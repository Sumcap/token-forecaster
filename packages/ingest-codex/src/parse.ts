import { basename } from "node:path";

import {
  countSkip,
  emptyImportStats,
  extractPromptFeatures,
  type ImportStats,
  type PromptFeatures,
  type UsageObservation,
} from "@token-forecaster/core";

/**
 * Codex rollout transcripts are an internal, versioned CLI artifact, not a
 * published API. This adapter therefore treats every field as optional, records
 * the shape of anything it does not understand, and never throws on a row.
 *
 * Shapes observed in the wild (see SCHEMA.md):
 *   modern  { timestamp, type: "event_msg"|"response_item"|"turn_context"|
 *             "session_meta"|"compacted"|..., payload: {...} }
 *   legacy  { record_type: ... }                        — pre-typed rollouts
 *   legacy  { content, role, type }                     — bare response items
 *   legacy  { git, id, instructions, timestamp }        — bare session meta
 */

interface RawRow {
  type?: unknown;
  payload?: unknown;
  timestamp?: unknown;
  record_type?: unknown;
  role?: unknown;
  id?: unknown;
}

interface TokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Options for {@link parseCodexRollout}. */
export interface ParseCodexOptions {
  /** Absolute path of the transcript, used for observation ids and reporting. */
  sourceFile: string;
  /** Per-install salt for prompt-feature hashes. */
  salt: string;
  /**
   * Emit only rows that begin at or after this byte offset.
   *
   * Rows before it are still parsed, because turn roots, the current model and
   * the duplicate-usage set are all carried forward state — resuming blind
   * would lose the prompt features of an in-flight turn and re-emit calls that
   * were already stored. Re-reading a single session file is cheap; the indexer
   * gets its real saving by skipping unchanged files outright.
   */
  fromOffset?: number;
}

/** Result of parsing one transcript. */
export interface ParseCodexResult {
  observations: UsageObservation[];
  stats: ImportStats;
  /** Byte offset one past the last row consumed; persist for incremental runs. */
  endOffset: number;
  sessionId: string;
  /** Codex CLI version from `session_meta`, when present. */
  cliVersion: string | null;
  /** Latest model seen, for reporting. */
  lastModel: string | null;
}

interface TurnState {
  index: number;
  features: PromptFeatures | null;
  calls: number;
  outputTotal: number;
  reasoningTotal: number;
  totalTotal: number;
  firstTimestamp: string;
  model: string | null;
  reasoning: string | null;
  contextWindow: number | null;
  /** Byte offset just past this turn's most recent call, for the emit cursor. */
  lastOffset: number;
}

/**
 * Parse a Codex rollout transcript into privacy-safe usage observations.
 *
 * Prompt text is read only to compute {@link PromptFeatures} and is never
 * stored, returned, or logged.
 *
 * @param text Full transcript contents (JSONL).
 */
export function parseCodexRollout(text: string, options: ParseCodexOptions): ParseCodexResult {
  const { sourceFile, salt, fromOffset = 0 } = options;
  const stats = emptyImportStats();
  stats.filesScanned = 1;
  const observations: UsageObservation[] = [];

  // Fall back to the rollout filename, which embeds the session uuid.
  let sessionId = basename(sourceFile).replace(/\.jsonl$/, "");
  let cliVersion: string | null = null;
  let model: string | null = null;
  let reasoning: string | null = null;
  let contextWindow: number | null = null;
  let lastTimestamp = new Date(0).toISOString();

  const seenUsage = new Set<string>();
  const turns: TurnState[] = [];
  let turn: TurnState | null = null;
  let sawUserMessageEvent = false;

  // Legacy rollouts predate `event_msg/user_message` and record the human turn
  // only as a `response_item` with role "user". Detecting that up front lets the
  // loop use those rows as turn roots without double-counting turns in modern
  // transcripts, where both rows are present for the same prompt.
  const hasUserMessageEvents = text.includes('"user_message"');

  let offset = 0;
  const lines = text.split("\n");

  for (const line of lines) {
    const rowStart = offset;
    // +1 for the newline consumed by split; the final element over-counts by
    // one only when the file does not end in a newline, which endOffset clamps.
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) continue;
    // Rows before the cursor rebuild state but are neither counted nor emitted.
    const emitting = rowStart >= fromOffset;
    if (emitting) stats.rowsRead += 1;

    let row: RawRow;
    try {
      row = JSON.parse(line) as RawRow;
    } catch {
      if (emitting) countSkip(stats, "parse_error");
      continue;
    }
    if (row === null || typeof row !== "object") {
      if (emitting) countSkip(stats, "unknown_record_shape");
      continue;
    }

    const ts = str(row.timestamp);
    if (ts) lastTimestamp = ts;

    const type = str(row.type);
    const payload = (row.payload ?? null) as Record<string, unknown> | null;

    if (!payload || typeof payload !== "object") {
      // Legacy rollouts predate the typed { type, payload } envelope.
      const variant =
        row.record_type !== undefined
          ? "legacy:record_type"
          : row.role !== undefined
            ? "legacy:bare_message"
            : row.id !== undefined
              ? "legacy:bare_session_meta"
              : `legacy:${type ?? "untyped"}`;
      if (emitting) {
        stats.schemaVariants[variant] = (stats.schemaVariants[variant] ?? 0) + 1;
        countSkip(stats, "unsupported_schema_version");
      }
      continue;
    }

    const payloadType = str(payload["type"]);
    const variantKey = `${type ?? "untyped"}/${payloadType ?? "-"}`;

    switch (type) {
      case "session_meta": {
        if (emitting) stats.schemaVariants["session_meta"] = (stats.schemaVariants["session_meta"] ?? 0) + 1;
        sessionId = str(payload["id"]) ?? sessionId;
        cliVersion = str(payload["cli_version"]) ?? cliVersion;
        continue;
      }
      case "turn_context": {
        if (emitting) stats.schemaVariants["turn_context"] = (stats.schemaVariants["turn_context"] ?? 0) + 1;
        model = str(payload["model"]) ?? model;
        reasoning = str(payload["effort"]) ?? reasoning;
        continue;
      }
      case "event_msg":
        break;
      case "response_item": {
        if (emitting) stats.schemaVariants[variantKey] = (stats.schemaVariants[variantKey] ?? 0) + 1;
        if (hasUserMessageEvents || payloadType !== "message") continue;
        if (str(payload["role"]) !== "user") continue;
        const content = payload["content"];
        const parts = Array.isArray(content) ? content : [];
        let chars = 0;
        let text_ = "";
        for (const part of parts) {
          const value = (part as Record<string, unknown> | null)?.["text"];
          if (typeof value === "string") {
            text_ += value;
            chars += value.length;
          }
        }
        if (chars === 0) continue;
        stats.schemaVariants["legacy_turn_root"] = (stats.schemaVariants["legacy_turn_root"] ?? 0) + 1;
        turn = {
          index: turns.length,
          features: extractPromptFeatures(text_, salt, 0),
          calls: 0,
          outputTotal: 0,
          reasoningTotal: 0,
          totalTotal: 0,
          firstTimestamp: ts ?? lastTimestamp,
          model,
          reasoning,
          contextWindow,
          lastOffset: rowStart,
        };
        turns.push(turn);
        continue;
      }
      case "compacted":
      case "world_state":
      case "inter_agent_communication_metadata":
      case "message":
        if (emitting) stats.schemaVariants[variantKey] = (stats.schemaVariants[variantKey] ?? 0) + 1;
        continue;
      default: {
        if (emitting) {
          stats.unknownEvents[type ?? "untyped"] = (stats.unknownEvents[type ?? "untyped"] ?? 0) + 1;
          countSkip(stats, "unrecognised_event");
        }
        continue;
      }
    }

    // --- event_msg payloads -------------------------------------------------
    switch (payloadType) {
      case "user_message": {
        sawUserMessageEvent = true;
        const message = payload["message"];
        const images = Array.isArray(payload["images"]) ? payload["images"].length : 0;
        // Text enters here and leaves as counts. It is not retained.
        const features =
          typeof message === "string" ? extractPromptFeatures(message, salt, images) : null;
        turn = {
          index: turns.length,
          features,
          calls: 0,
          outputTotal: 0,
          reasoningTotal: 0,
          totalTotal: 0,
          firstTimestamp: ts ?? lastTimestamp,
          model,
          reasoning,
          contextWindow,
          lastOffset: rowStart,
        };
        turns.push(turn);
        continue;
      }
      case "token_count": {
        const info = payload["info"];
        if (!info || typeof info !== "object") {
          if (emitting) countSkip(stats, "missing_usage");
          continue;
        }
        const infoRec = info as Record<string, unknown>;
        const last = (infoRec["last_token_usage"] ?? null) as TokenUsage | null;
        const total = (infoRec["total_token_usage"] ?? null) as TokenUsage | null;
        contextWindow = num(infoRec["model_context_window"]) ?? contextWindow;
        if (!last || typeof last !== "object") {
          if (emitting) countSkip(stats, "missing_usage");
          continue;
        }

        const outputTokens = num(last.output_tokens);
        const inputTokens = num(last.input_tokens);
        const cached = num(last.cached_input_tokens);
        const reasoningOut = num(last.reasoning_output_tokens);
        const lastTotal = num(last.total_tokens);
        const cumulative = total ? num(total.total_tokens) : null;

        // The CLI re-emits token_count for UI refreshes. The cumulative total
        // plus the per-call usage uniquely identifies a real model call.
        const key = `${cumulative ?? "?"}|${inputTokens ?? "?"}|${outputTokens ?? "?"}|${reasoningOut ?? "?"}`;
        if (seenUsage.has(key)) {
          if (emitting) countSkip(stats, "duplicate_usage");
          continue;
        }
        seenUsage.add(key);

        if (outputTokens === null) {
          if (emitting) countSkip(stats, "missing_usage");
          continue;
        }
        if (outputTokens <= 0) {
          if (emitting) countSkip(stats, "zero_output");
          continue;
        }
        if (!turn) {
          // Usage before any recoverable turn root: still a real call, but with
          // no prompt to condition on. Keep it in an implicit turn 0.
          turn = {
            index: turns.length,
            features: null,
            calls: 0,
            outputTotal: 0,
            reasoningTotal: 0,
            totalTotal: 0,
            firstTimestamp: ts ?? lastTimestamp,
            model,
            reasoning,
            contextWindow,
            lastOffset: rowStart,
          };
          turns.push(turn);
          if (emitting) countSkip(stats, "no_turn_context");
        }

        const callIndex = turn.calls;
        turn.calls += 1;
        turn.outputTotal += outputTokens;
        turn.reasoningTotal += reasoningOut ?? 0;
        turn.totalTotal += lastTotal ?? 0;
        if (turn.model === null) turn.model = model;
        if (turn.reasoning === null) turn.reasoning = reasoning;
        if (turn.contextWindow === null) turn.contextWindow = contextWindow;

        turn.lastOffset = offset;
        if (!emitting) continue;
        observations.push({
          provider: "openai",
          id: `codex:${sessionId}:${turn.index}:${callIndex}:call`,
          sourceFile,
          sourceOffset: offset,
          sessionId,
          turnIndex: turn.index,
          callIndex,
          scale: "call",
          timestamp: ts ?? lastTimestamp,
          model: turn.model,
          reasoning: turn.reasoning,
          usageSource: "provider_exact",
          inputTokens,
          cachedInputTokens: cached,
          outputTokens,
          reasoningOutputTokens: reasoningOut,
          totalTokens: lastTotal,
          contextWindow: turn.contextWindow,
          promptFeatures: turn.features,
        });
        stats.rowsUsed += 1;
        continue;
      }
      default: {
        if (emitting) stats.schemaVariants[variantKey] = (stats.schemaVariants[variantKey] ?? 0) + 1;
        continue;
      }
    }
  }

  // Turn-scale rows: one per turn that produced at least one call.
  // A turn row is re-emitted whenever the turn gained a call in this window;
  // the store upserts on `id`, so a growing turn converges to its final total.
  for (const t of turns) {
    if (t.calls === 0) continue;
    if (t.lastOffset < fromOffset) continue;
    observations.push({
      provider: "openai",
      id: `codex:${sessionId}:${t.index}:turn`,
      sourceFile,
      sourceOffset: t.lastOffset,
      sessionId,
      turnIndex: t.index,
      callIndex: 0,
      scale: "turn",
      timestamp: t.firstTimestamp,
      model: t.model,
      reasoning: t.reasoning,
      usageSource: "provider_exact",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: t.outputTotal,
      reasoningOutputTokens: t.reasoningTotal,
      totalTokens: t.totalTotal,
      contextWindow: t.contextWindow,
      promptFeatures: t.features,
    });
  }

  if (!sawUserMessageEvent && turns.length > 0) {
    stats.schemaVariants["no_user_message_events"] =
      (stats.schemaVariants["no_user_message_events"] ?? 0) + 1;
  }

  return {
    observations,
    stats,
    endOffset: Math.min(offset, Buffer.byteLength(text, "utf8")),
    sessionId,
    cliVersion,
    lastModel: model,
  };
}

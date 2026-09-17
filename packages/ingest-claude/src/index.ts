/**
 * Typed adapter over the shared Claude Code transcript loader.
 *
 * The loader (`../load-history.mjs`) is the single definition of "a call" in
 * this repo: the evaluation probes and this importer read it from the same
 * file, so a change to the population definition can never silently apply to
 * one and not the other.
 *
 * PRIVACY
 * -------
 * The loader never returns prompt or response text. It reduces a human message
 * to counts, buckets, booleans and an unsalted identity hash inside its own
 * scan and discards the text there. This module therefore only ever sees those
 * derivations, and it re-hashes the identity with the caller's per-install salt
 * before it reaches a UsageObservation. Nothing here logs, prints or persists
 * text.
 */

import { createHash } from "node:crypto";

import {
  countSkip,
  emptyImportStats,
  type ImportStats,
  type PromptFeatures,
  type UsageObservation,
} from "@token-forecaster/core";

import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  type ClaudeHistoryRow,
  type PromptFeaturesRaw,
} from "../load-history.mjs";

export { defaultProjectsDir };
export type { ClaudeHistoryRow, PromptFeaturesRaw };

export interface ImportClaudeOptions {
  /** Transcript root; defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /**
   * Per-install secret mixed into prompt hashes so they are not comparable
   * across machines and cannot be brute-forced against a prompt dictionary.
   */
  salt: string;
  /** Epoch milliseconds. Rows older than this are not imported. */
  since?: number;
}

export interface ImportClaudeResult {
  observations: UsageObservation[];
  stats: ImportStats;
}

/**
 * Verb classes the loader assigns to prompts that ask for an action rather than
 * an explanation. The core `hasImperative` flag is defined on the leading verb
 * of the prompt; the loader instead scores verbs anywhere in the text, so this
 * is an approximation of the same idea over the only signal available.
 */
const IMPERATIVE_VERB_CLASSES = new Set(["write", "fix", "run"]);

/**
 * Map the loader's bucketed prompt derivations onto the shared PromptFeatures
 * contract.
 *
 * Three of the core fields have no counterpart in the loader's derivation
 * (`lines`, `codeFences`, `urls`) and are reported as `0` rather than guessed;
 * `paths` collapses to the loader's boolean `mentionsPath` as a lower bound of
 * one. The hash is the loader's unsalted prompt identity re-hashed under the
 * caller's salt, so it keeps its dedup property without becoming comparable
 * across installs.
 */
function toPromptFeatures(
  raw: PromptFeaturesRaw,
  salt: string,
  images: number,
): PromptFeatures {
  return {
    chars: raw.chars,
    words: raw.words,
    lines: 0,
    codeFences: 0,
    urls: 0,
    paths: raw.mentionsPath ? 1 : 0,
    hasQuestion: raw.isQuestion,
    hasImperative: IMPERATIVE_VERB_CLASSES.has(raw.verbClass),
    images,
    hash: createHash("sha256")
      .update(salt)
      .update(" ")
      .update(raw.promptHash)
      .digest("hex")
      .slice(0, 16),
  };
}

/**
 * The provider stop reason, lower-cased, or null when the transcript did not
 * record one. Deliberately not mapped onto an enum here: the enum lives in the
 * telemetry schema, and an importer that quietly folded an unknown value into
 * `other` would hide format drift the schema is there to catch.
 */
function stopReasonOf(row: ClaudeHistoryRow): string | null {
  return typeof row.stopReason === "string" && row.stopReason.length > 0
    ? row.stopReason.toLowerCase()
    : null;
}

function reasoningOf(row: ClaudeHistoryRow): string | null {
  if (typeof row.effort === "string" && row.effort.length > 0) return row.effort;
  if (!(row.blockTypes instanceof Set)) return null;
  return hasThinkingBlock(row) ? "thinking" : "none";
}

interface PreparedRow {
  row: ClaudeHistoryRow;
  sessionId: string;
  timestampMs: number;
  turnRootId: string | null;
  turnIndex: number;
  callIndex: number;
}

/**
 * Import Claude Code transcript history as privacy-safe usage observations.
 *
 * Emits one `call`-scale observation per API call, plus one `turn`-scale
 * observation for each user turn whose agent loop was reconstructed exactly.
 * A turn with even one call whose ancestry was truncated (compaction, a session
 * copied without its history) would sum to less than the user was billed, so it
 * is excluded from turn aggregation while its calls are still kept.
 */
export async function importClaudeHistory(
  options: ImportClaudeOptions,
): Promise<ImportClaudeResult> {
  const { salt } = options;
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const since = options.since;
  const stats = emptyImportStats();

  const { rows, filesScanned } = await loadRequests(projectsDir, {
    withPromptFeatures: true,
  });
  stats.filesScanned = filesScanned;

  // Pass 1: filter to usable rows.
  const candidates: Array<{
    row: ClaudeHistoryRow;
    sessionId: string;
    timestampMs: number;
  }> = [];

  for (const row of rows) {
    const timestampMs = row.timestampMs;
    if (!Number.isFinite(timestampMs)) {
      stats.rowsRead++;
      countSkip(stats, "unknown_record_shape");
      continue;
    }
    if (since !== undefined && timestampMs < since) continue;
    stats.rowsRead++;

    if (row.model === "<synthetic>") {
      countSkip(stats, "unrecognised_event");
      continue;
    }
    if (typeof row.outputTokens !== "number" || !Number.isFinite(row.outputTokens)) {
      countSkip(stats, "missing_usage");
      continue;
    }
    if (row.outputTokens <= 0) {
      countSkip(stats, "zero_output");
      continue;
    }
    candidates.push({
      row,
      sessionId: row.sessionId ?? "(unknown-session)",
      timestampMs,
    });
  }

  candidates.sort((a, b) =>
    a.sessionId === b.sessionId
      ? a.timestampMs - b.timestampMs || a.row.requestId.localeCompare(b.row.requestId)
      : a.sessionId.localeCompare(b.sessionId),
  );

  // Pass 2: number the turns. `turnRootId` is an opaque uuid, not an ordinal,
  // so turns are numbered by the order their first call appears in the
  // session's timeline; that is what `turnIndex` is contracted to mean.
  const usable: PreparedRow[] = [];
  const turnIndexBySession = new Map<string, Map<string, number>>();
  const callCounter = new Map<string, number>();
  const turnGroups = new Map<string, PreparedRow[]>();
  const inexactTurns = new Set<string>();

  for (const candidate of candidates) {
    const { row, sessionId, timestampMs } = candidate;
    const turnRootId = row.turnRootId ?? null;

    // A call whose ancestry was truncated is kept at call scale (its own token
    // count is exact) but poisons the turn it appears to belong to.
    if (row.loopDepthExact === false) countSkip(stats, "no_turn_context");

    let turnIndex = -1;
    if (turnRootId !== null) {
      let indices = turnIndexBySession.get(sessionId);
      if (indices === undefined) {
        indices = new Map();
        turnIndexBySession.set(sessionId, indices);
      }
      const existing = indices.get(turnRootId);
      if (existing === undefined) {
        turnIndex = indices.size;
        indices.set(turnRootId, turnIndex);
      } else {
        turnIndex = existing;
      }
    }

    const counterKey = `${sessionId}\0${turnIndex}`;
    const callIndex = callCounter.get(counterKey) ?? 0;
    callCounter.set(counterKey, callIndex + 1);

    const prepared: PreparedRow = {
      row,
      sessionId,
      timestampMs,
      turnRootId,
      turnIndex,
      callIndex,
    };
    usable.push(prepared);

    if (turnRootId !== null) {
      const turnKey = `${sessionId}\0${turnRootId}`;
      if (row.loopDepthExact === false) inexactTurns.add(turnKey);
      const group = turnGroups.get(turnKey);
      if (group === undefined) turnGroups.set(turnKey, [prepared]);
      else group.push(prepared);
    }
  }

  // Pass 3: call-scale observations.
  const observations: UsageObservation[] = [];
  for (const prepared of usable) {
    const { row, sessionId, timestampMs, turnIndex, callIndex } = prepared;
    const rawPrompt = row.turnPrompt ?? null;
    observations.push({
      provider: "anthropic",
      id: `claude:${sessionId}:${row.requestId}`,
      // The loader merges rows across files and returns no per-row path, so
      // the transcript root is the most precise provenance available.
      sourceFile: projectsDir,
      sourceOffset: 0,
      sessionId,
      turnIndex,
      callIndex,
      scale: "call",
      timestamp: new Date(timestampMs).toISOString(),
      model: row.model ?? null,
      reasoning: reasoningOf(row),
      usageSource: "provider_exact",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: row.outputTokens,
      reasoningOutputTokens: null,
      totalTokens: null,
      contextWindow: null,
      turnRootId: prepared.turnRootId,
      // Names in emission order, duplicates kept: three `Read`s in one call is
      // a different call from one `Read`.
      toolNames: [...row.tools],
      largestToolInputChars: row.maxToolChars ?? null,
      stopReason: stopReasonOf(row),
      promptFeatures:
        rawPrompt === null
          ? null
          : toPromptFeatures(rawPrompt, salt, row.turnHasImage === true ? 1 : 0),
    });
  }
  stats.rowsUsed = observations.length;

  // Pass 4: turn-scale observations.
  for (const [turnKey, calls] of turnGroups) {
    if (inexactTurns.has(turnKey)) continue;
    const first = calls[0];
    if (first === undefined || first.turnRootId === null) continue;

    let outputTokens = 0;
    const toolNames: string[] = [];
    let largestToolInputChars = 0;
    for (const call of calls) {
      outputTokens += call.row.outputTokens;
      toolNames.push(...call.row.tools);
      largestToolInputChars = Math.max(largestToolInputChars, call.row.maxToolChars ?? 0);
    }
    // How the TURN stopped is how its last call stopped; the earlier ones all
    // stopped at `tool_use` by definition of still being in the loop.
    const lastCall = calls[calls.length - 1]!;

    const rawPrompt = first.row.turnPrompt ?? null;
    observations.push({
      provider: "anthropic",
      id: `claude:${first.sessionId}:${first.turnRootId}:turn`,
      sourceFile: projectsDir,
      sourceOffset: 0,
      sessionId: first.sessionId,
      turnIndex: first.turnIndex,
      callIndex: 0,
      scale: "turn",
      timestamp: new Date(first.timestampMs).toISOString(),
      model: first.row.model ?? null,
      reasoning: reasoningOf(first.row),
      usageSource: "provider_exact",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens,
      reasoningOutputTokens: null,
      totalTokens: null,
      contextWindow: null,
      turnRootId: first.turnRootId,
      toolNames,
      largestToolInputChars,
      stopReason: stopReasonOf(lastCall.row),
      promptFeatures:
        rawPrompt === null
          ? null
          : toPromptFeatures(rawPrompt, salt, first.row.turnHasImage === true ? 1 : 0),
    });
  }

  return { observations, stats };
}

/**
 * Provider-neutral usage observations shared by the local history importers
 * (Codex, Claude Code) and the personal profile trainer.
 *
 * PRIVACY CONTRACT
 * ----------------
 * Nothing in this module may carry raw prompt or response text. Importers turn
 * text into {@link PromptFeatures} (counts plus a salted hash) and drop the text
 * before an observation is constructed. Anything persisted downstream is
 * derived from these structures, so keeping text out here keeps it out of the
 * database, the API, the UI, and the evaluation artifacts.
 */

/** Which vendor produced the tokens. Never mix these when fitting quantiles. */
export type UsageProvider = "openai" | "anthropic";

/**
 * Scale of the observation.
 *
 * - `call` — one model request/response pair.
 * - `turn` — every call the agent loop made between one user prompt and the
 *   moment control returned to the user.
 */
export type UsageScale = "call" | "turn";

/**
 * Provenance of the token counts. Exact provider usage and estimates must never
 * be pooled silently: a profile fitted on estimates cannot be reported as if it
 * were fitted on billed numbers.
 */
export type UsageSource = "provider_exact" | "character_estimate" | "dom_estimate";

/** Privacy-safe summary of a prompt. Counts and a hash only — never the text. */
export interface PromptFeatures {
  /** Character count of the prompt as submitted. */
  chars: number;
  /** Whitespace-delimited word count. */
  words: number;
  /** Newline-delimited line count. */
  lines: number;
  /** Number of fenced code blocks (``` runs / 2, floored). */
  codeFences: number;
  /** Number of URLs detected. */
  urls: number;
  /** Number of filesystem-looking paths detected. */
  paths: number;
  /** Whether the prompt contains a question mark. */
  hasQuestion: boolean;
  /** Whether the prompt looks like an imperative task ("add", "fix", "build"…). */
  hasImperative: boolean;
  /** Number of attached images, when the source records them. */
  images: number;
  /**
   * Salted, truncated hash of the normalised prompt. Used only to deduplicate
   * repeated prompts across files; not reversible to text.
   */
  hash: string;
}

/** One usable training observation. */
export interface UsageObservation {
  provider: UsageProvider;
  /** Stable identity for incremental indexing: unique per (file, event). */
  id: string;
  /** Source transcript file, absolute path. */
  sourceFile: string;
  /** Byte offset in the source file at which this record ended. */
  sourceOffset: number;
  /** Provider session identifier when available, else a file-derived id. */
  sessionId: string;
  /** Zero-based index of the user turn inside the session. */
  turnIndex: number;
  /** Zero-based index of this call inside its turn (`0` for turn-scale rows). */
  callIndex: number;
  scale: UsageScale;
  /** Event time, ISO-8601 UTC. */
  timestamp: string;
  /** Model id exactly as the transcript reported it, or null when unknown. */
  model: string | null;
  /**
   * Reasoning / thinking configuration: Codex `effort`, or Claude thinking
   * budget bucket. Null when the transcript does not say.
   */
  reasoning: string | null;
  usageSource: UsageSource;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /** The forecast target. Always present on a usable observation. */
  outputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  /** Provider-reported context window, when the transcript records it. */
  contextWindow: number | null;
  /** Features of the user prompt that opened this turn, when recoverable. */
  promptFeatures: PromptFeatures | null;
}

/** Why a transcript row did not become an observation. */
export type SkipReason =
  | "parse_error"
  | "unknown_record_shape"
  | "unrecognised_event"
  | "missing_usage"
  | "duplicate_usage"
  | "zero_output"
  | "no_turn_context"
  | "unsupported_schema_version";

/** Per-import accounting. Every row read is either used or skipped with a reason. */
export interface ImportStats {
  filesScanned: number;
  filesFailed: number;
  rowsRead: number;
  rowsUsed: number;
  /** Counts keyed by {@link SkipReason}; keys with zero counts are omitted. */
  skipped: Partial<Record<SkipReason, number>>;
  /** Free-form counts of transcript shapes seen, for drift monitoring. */
  schemaVariants: Record<string, number>;
  /** Event `type` values the adapter did not recognise, with counts. */
  unknownEvents: Record<string, number>;
}

/** Create an empty {@link ImportStats}. */
export function emptyImportStats(): ImportStats {
  return {
    filesScanned: 0,
    filesFailed: 0,
    rowsRead: 0,
    rowsUsed: 0,
    skipped: {},
    schemaVariants: {},
    unknownEvents: {},
  };
}

/** Accumulate `b` into `a`, in place. */
export function mergeImportStats(a: ImportStats, b: ImportStats): ImportStats {
  a.filesScanned += b.filesScanned;
  a.filesFailed += b.filesFailed;
  a.rowsRead += b.rowsRead;
  a.rowsUsed += b.rowsUsed;
  for (const [k, v] of Object.entries(b.skipped)) {
    const key = k as SkipReason;
    a.skipped[key] = (a.skipped[key] ?? 0) + (v ?? 0);
  }
  for (const [k, v] of Object.entries(b.schemaVariants)) {
    a.schemaVariants[k] = (a.schemaVariants[k] ?? 0) + v;
  }
  for (const [k, v] of Object.entries(b.unknownEvents)) {
    a.unknownEvents[k] = (a.unknownEvents[k] ?? 0) + v;
  }
  return a;
}

/** Record one skip. */
export function countSkip(stats: ImportStats, reason: SkipReason, n = 1): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + n;
}

/**
 * The model id a profile is keyed on, with per-session variant suffixes removed.
 *
 * A client may name a model in a form history never records. Claude Code's
 * status line reports the million-token context variant as
 * `claude-opus-5[1m]`, while every transcript it writes says `claude-opus-5` —
 * so keying a forecast on the raw string looks up a rung that cannot exist and
 * silently falls back to a coarser one. The bracketed part selects a context
 * window, not a different model, and the two share their output distribution.
 *
 * Applied on both sides — training and forecasting — so the key a rung is
 * stored under is the key a request looks it up by.
 */
export function canonicalModelId(model: string | null): string | null {
  if (model === null) return null;
  const trimmed = model.replace(/\[[^\]]*\]\s*$/, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

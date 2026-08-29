/**
 * Hand-written ambient declarations for `load-history.mjs`.
 *
 * The loader is plain JavaScript on purpose: it is the single shared population
 * definition used by both the evaluation probes (which run it directly with
 * `node`) and by this package's typed adapter, so it is deliberately NOT
 * compiled by `tsc`. These declarations describe the shape it actually returns.
 *
 * Privacy: no field here carries prompt or response text. `PromptFeaturesRaw`
 * is counts, buckets, booleans and hashes only.
 */

/** Block types the loader treats as thinking output. */
export declare const THINKING_BLOCK_TYPES: Set<string>;

/**
 * Bucketed, hashed derivations of one human message. Never reconstructable to
 * text. `null` from {@link derivePromptFeatures} means "no prompt observed",
 * which callers must skip rather than treat as a level.
 */
export interface PromptFeaturesRaw {
  chars: number;
  words: number;
  lengthBucket: string;
  verbClass: string;
  hasLimit: boolean;
  hasExpansive: boolean;
  mentionsPath: boolean;
  isQuestion: boolean;
  requirements: number;
  requirementBucket: string;
  requestedFormat: string;
  deliverableType: string;
  artifactIntent: boolean;
  followupCompression: unknown;
  /** Unsalted sha256 of the stripped prompt text. Identity only. */
  promptHash: string;
  semanticHash: unknown;
}

/** One merged API call: every transcript row that shared a `requestId`. */
export interface ClaudeHistoryRow {
  requestId: string;
  outputTokens: number;
  visibleChars: number;
  textChars: number;
  toolChars: number;
  thinkingChars: number;
  blockTypes: Set<string>;
  tools: string[];
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  /** Epoch milliseconds; `NaN` when the transcript had no parsable timestamp. */
  timestampMs: number;
  stopReason: string | null;
  /** Number of transcript rows merged into this call. */
  rows: number;
  /** Salted hash of the project directory the call came from. */
  workloadId: string | null;

  // --- present only with `withLoopContext` (implied by `withPromptFeatures`) ---
  parentRequestId?: string | null;
  loopDepth?: number;
  loopDepthExact?: boolean;
  afterUserMessage?: boolean;
  chainBroken?: boolean;
  resultChars?: number | null;
  resultIsError?: boolean | null;
  resultBlocks?: number;
  resultArrivedMs?: number | null;
  resultPathHashes?: string[];
  resultSemanticHash?: unknown;
  /** Features of the human message that opened this call's turn, or null. */
  turnPrompt?: PromptFeaturesRaw | null;
  /** Opaque uuid of the turn-opening user row, or null when unknown. */
  turnRootId?: string | null;
  /** Slash-command name on the turn root, `"none"`, or null when unknown. */
  turnCommand?: string | null;
  turnHasImage?: boolean | null;

  // --- present only with `withResolvedFileContext` ---
  toolPathHashes?: string[];
  readPathHashes?: string[];
  searchPathHashes?: string[];
  mutationPathHashes?: string[];
  assistantTextSemanticHash?: unknown;
  assistantThinkingSemanticHash?: unknown;
  toolInputSemanticHash?: unknown;
}

export interface LoadRequestsOptions {
  withLoopContext?: boolean;
  withPromptFeatures?: boolean;
  withResolvedFileContext?: boolean;
}

export interface LoadRequestsResult {
  rows: ClaudeHistoryRow[];
  filesScanned: number;
}

export declare function derivePromptFeatures(rawText: unknown): PromptFeaturesRaw | null;

export declare function defaultProjectsDir(): string;

export declare function loadRequests(
  projectsDir?: string,
  options?: LoadRequestsOptions,
): Promise<LoadRequestsResult>;

export declare function hasThinkingBlock(row: { blockTypes: Set<string> }): boolean;

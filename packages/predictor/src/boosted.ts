/**
 * Portable pre-call quantile correction.
 *
 * The historical lookup remains the anchor. These shallow trees learn small,
 * quantile-specific residual corrections from information already available
 * before generation. Unknown context never becomes false: the correction is
 * skipped unless the caller explicitly supplies a complete agent-loop state.
 */

export type RequestedOutputFormat =
  | "json"
  | "table"
  | "list"
  | "code"
  | "document"
  | "mixed"
  | "unspecified";

export type ForecastDeliverableType =
  | "artifact"
  | "structured"
  | "document"
  | "code"
  | "analysis"
  | "operation"
  | "other";

export interface PromptForecastFeatures {
  characterCount: number;
  requirements: number;
  hasLimit: boolean;
  hasExpansive: boolean;
  artifactIntent: boolean;
  requestedFormat: RequestedOutputFormat;
  deliverableType: ForecastDeliverableType;
}

export interface AgentLoopForecastContext {
  /** Zero-based count of requests already issued in this session. */
  sessionPosition: number;
  /** Parent-linked position in the current human turn. */
  loopDepth: number;
  /** Number of completed parent calls visible to this request. */
  priorCallCount: number;
  /** Maximum output tokens among those parent calls. Required when count > 0. */
  priorMaxOutputTokens?: number;
  /** Long artifact/file responses already observed in the parent chain. */
  priorArtifactCount?: number;
  /** Whether any parent call chose Write. */
  priorWriteObserved?: boolean;
  /** Whether any parent call produced a long Write/Edit payload. */
  priorArtifactObserved?: boolean;
}

export interface BoostedForecastContext {
  prompt?: PromptForecastFeatures;
  agentLoop?: AgentLoopForecastContext;
}

export interface QuantileBoostLeaf {
  value: number;
}

export interface QuantileBoostSplit {
  feature: number;
  threshold: number;
  left: QuantileBoostNode;
  right: QuantileBoostNode;
}

export type QuantileBoostNode = QuantileBoostLeaf | QuantileBoostSplit;

export interface QuantileBoostProfile {
  featureSchema: PortableBoostFeatureSchema;
  learningRate: number;
  /** p50, p90, p99 ensembles, in that order. */
  ensembles: [QuantileBoostNode[], QuantileBoostNode[], QuantileBoostNode[]];
  trainingSamples: number;
}

export const QUANTILE_BOOST_FEATURE_COUNT = 37;
/**
 * Schemas this runtime can apply. v2 appends one feature (turn-root image
 * presence, index 36); v1 trees never reference an index above 35, so a v1
 * profile evaluates identically against the v2 feature vector.
 */
export const SUPPORTED_BOOST_FEATURE_SCHEMAS = [
  "portable-precall-v1",
  "portable-precall-v2",
] as const;
export type PortableBoostFeatureSchema =
  (typeof SUPPORTED_BOOST_FEATURE_SCHEMAS)[number];
const META_WIDTH = 24;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
}

export function hasCompleteAgentLoopContext(
  context: AgentLoopForecastContext | undefined,
): context is AgentLoopForecastContext {
  if (context === undefined) return false;
  const baseComplete =
    Number.isInteger(context.sessionPosition) &&
    context.sessionPosition >= 0 &&
    Number.isInteger(context.loopDepth) &&
    context.loopDepth >= 0 &&
    Number.isInteger(context.priorCallCount) &&
    context.priorCallCount >= 0;
  if (!baseComplete) return false;
  if (context.priorCallCount === 0) return true;
  return (
    Number.isInteger(context.priorMaxOutputTokens) &&
    (context.priorMaxOutputTokens ?? -1) >= 0 &&
    Number.isInteger(context.priorArtifactCount) &&
    (context.priorArtifactCount ?? -1) >= 0 &&
    typeof context.priorWriteObserved === "boolean" &&
    typeof context.priorArtifactObserved === "boolean"
  );
}

export interface PortableBoostFeatureRequest {
  model: string;
  thinkingEnabled: boolean;
  promptMentionsPath?: boolean;
  /** Omitted means the turn root was unavailable, never "no image". */
  promptHasImage?: boolean;
  boostedContext: BoostedForecastContext;
}

/** The exact 36-feature schema used by the trainer. */
export function portableQuantileBoostFeatures(
  request: PortableBoostFeatureRequest,
): number[] {
  const loop = request.boostedContext.agentLoop;
  if (!hasCompleteAgentLoopContext(loop)) {
    throw new Error("portable quantile correction requires complete agent-loop context");
  }
  assertNonNegativeInteger("sessionPosition", loop.sessionPosition);
  assertNonNegativeInteger("loopDepth", loop.loopDepth);
  assertNonNegativeInteger("priorCallCount", loop.priorCallCount);
  const prompt = request.boostedContext.prompt;
  if (prompt) {
    assertNonNegativeInteger("prompt.characterCount", prompt.characterCount);
    assertNonNegativeInteger("prompt.requirements", prompt.requirements);
  }
  const features = new Array<number>(QUANTILE_BOOST_FEATURE_COUNT).fill(0);
  features[0] = request.thinkingEnabled ? 1 : 0;
  features[1] =
    request.promptMentionsPath === undefined
      ? -1
      : request.promptMentionsPath
        ? 1
        : 0;
  features[2] = Math.log1p(prompt?.characterCount ?? 0) / 8;
  features[3] = Math.log1p(prompt?.requirements ?? 0) / 3;
  features[4] = prompt?.hasLimit ? 1 : 0;
  features[5] = prompt?.hasExpansive ? 1 : 0;
  features[6] = prompt?.artifactIntent ? 1 : 0;
  features[7] = Math.log1p(loop.sessionPosition) / 6;
  features[8] = Math.log1p(loop.loopDepth) / 5;
  features[9] = Math.log1p(loop.priorCallCount) / 5;
  features[10] = Math.log1p(loop.priorMaxOutputTokens ?? 0) / 10;
  features[11] = Math.log1p(loop.priorArtifactCount ?? 0) / 3;

  const categoricals = [
    `model=${request.model}`,
    `format=${prompt?.requestedFormat ?? "(unknown)"}`,
    `deliverable=${prompt?.deliverableType ?? "(unknown)"}`,
    `priorWrite=${loop.priorCallCount === 0 ? "(unknown)" : loop.priorWriteObserved ? "yes" : "no"}`,
    `priorArtifact=${loop.priorCallCount === 0 ? "(unknown)" : loop.priorArtifactObserved ? "yes" : "no"}`,
  ];
  for (const value of categoricals) {
    features[12 + (fnv1a(value) % META_WIDTH)] = 1;
  }
  // v2: turn-root image presence, tri-state exactly like promptMentionsPath.
  features[36] =
    request.promptHasImage === undefined ? -1 : request.promptHasImage ? 1 : 0;
  return features;
}

function nodeValue(node: QuantileBoostNode, features: readonly number[]): number {
  let current = node;
  while ("feature" in current) {
    current =
      (features[current.feature] ?? 0) <= current.threshold
        ? current.left
        : current.right;
  }
  return current.value;
}

export function applyQuantileBoost(
  model: QuantileBoostProfile,
  base: readonly [number, number, number],
  features: readonly number[],
): [number, number, number] {
  if (
    !SUPPORTED_BOOST_FEATURE_SCHEMAS.includes(
      model.featureSchema as PortableBoostFeatureSchema,
    )
  ) {
    throw new Error(`Unsupported quantile-boost feature schema: ${model.featureSchema}`);
  }
  if (features.length !== QUANTILE_BOOST_FEATURE_COUNT) {
    throw new Error(
      `Expected ${QUANTILE_BOOST_FEATURE_COUNT} boost features, got ${features.length}`,
    );
  }
  const corrected = model.ensembles.map((trees, index) =>
    Math.max(
      0,
      Math.round(
        (base[index] ?? 0) +
          model.learningRate *
            trees.reduce((sum, tree) => sum + nodeValue(tree, features), 0),
      ),
    ),
  ) as [number, number, number];
  corrected[1] = Math.max(corrected[0], corrected[1]);
  corrected[2] = Math.max(corrected[1], corrected[2]);
  return corrected;
}

// Prompt extraction mirrors the evaluation loader. It returns aggregates only.
const LIMIT_PATTERNS = [
  /\bin (one|a|two|three|1|2|3) (sentences?|lines?|paragraphs?|words?)\b/,
  /\b(brief|briefly|concise|concisely|short|shortly|tl;?dr|one[- ]liner|succinct)\b/,
  /\b\d{1,3}\s+(examples?|items?|tests?|lines?|words?|options?|ideas?|bullets?|sentences?|paragraphs?|cases?)\b/,
  /\b(no more than|at most|keep it|limit(ed)? to|just the|only the)\b/,
];
const EXPANSIVE_PATTERNS = [
  /\b(exhaustive|exhaustively|comprehensive|comprehensively|thorough|thoroughly|in depth|in-depth|detailed|deep dive|complete(ly)?|full(y)?|everything|all of|step by step|step-by-step)\b/,
];
const FORMAT_PATTERNS: [RequestedOutputFormat, RegExp][] = [
  ["json", /\b(json|jsonl|schema|structured output)\b/],
  ["table", /\b(table|matrix|spreadsheet|csv|tsv)\b/],
  ["list", /\b(list|bullets?|checklist|ranked|options?)\b/],
  ["code", /\b(code|implementation|patch|diff|function|class|component|endpoint|script|test suite)\b/],
  ["document", /\b(report|document|readme|guide|proposal|spec(?:ification)?|memo|email|post|article)\b/],
];
const ARTIFACT_VERB =
  /\b(write|rewrite|re-write|redo|re-do|create|implement|add|build|generate|draft|scaffold|make|fix|repair|patch|refactor|update|updating|change|modify)\b/;
const ARTIFACT_NOUN =
  /\b(file|code|component|endpoint|script|tests?|docs?|document|report|readme|guide|proposal|spec(?:ification)?|app|page|module|package|config(?:uration)?|migration|schema)\b/;
const EXPLICIT_FILE_ACTION =
  /\b(write|rewrite|re-write|redo|re-do|save|create|generate|edit|modify|update|updating|patch|replace|append)\b[^.!?\n]{0,80}\b(file|to|into|at|under)\b/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+\S/;

export function promptForecastFeatures(prompt: string): PromptForecastFeatures {
  const lower = prompt.toLowerCase();
  const formats = FORMAT_PATTERNS.filter(([, pattern]) => pattern.test(lower));
  const requestedFormat: RequestedOutputFormat =
    formats.length === 1 ? formats[0]![0] : formats.length > 1 ? "mixed" : "unspecified";
  const pathMention =
    /(\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|c|h|hpp|cpp|sh|zsh|yml|yaml|toml|css|scss|html|sql|txt|lock)\b|\b(src|lib|packages|apps|docs|experiments|fixtures|research|tests?|scripts?)\/)/.test(
      prompt,
    );
  const artifactIntent =
    EXPLICIT_FILE_ACTION.test(lower) ||
    (ARTIFACT_VERB.test(lower) && (ARTIFACT_NOUN.test(lower) || pathMention));
  let deliverableType: ForecastDeliverableType;
  if (artifactIntent) deliverableType = "artifact";
  else if (requestedFormat === "json" || requestedFormat === "table") {
    deliverableType = "structured";
  } else if (requestedFormat === "document" || requestedFormat === "code") {
    deliverableType = requestedFormat;
  } else if (/\b(explain|why|summari[sz]e|compare|review|investigate|analy[sz]e)\b/.test(lower)) {
    deliverableType = "analysis";
  } else if (/\b(run|execute|test|deploy|install|start|launch|verify|check)\b/.test(lower)) {
    deliverableType = "operation";
  } else deliverableType = "other";
  const lines = prompt.split("\n");
  const listItems = lines.filter((line) => LIST_ITEM.test(line)).length;
  const sentences = prompt
    .split(/[.!?\n]+/)
    .filter((part) => part.trim().length > 2).length;
  return {
    characterCount: prompt.length,
    requirements: Math.max(listItems, Math.min(sentences, 20), 1),
    hasLimit: LIMIT_PATTERNS.some((pattern) => pattern.test(lower)),
    hasExpansive: EXPANSIVE_PATTERNS.some((pattern) => pattern.test(lower)),
    artifactIntent,
    requestedFormat,
    deliverableType,
  };
}

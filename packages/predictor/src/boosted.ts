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
  /**
   * Short compression follow-up: "shrink what you just said", not "read things
   * and write an analysis". Optional so telemetry rows written before schema v3
   * stay valid; absent is treated as false by the v3 feature vector.
   */
  followupCompression?: boolean;
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

/**
 * What the session has already done, at the moment the human presses enter.
 * Both fields are known before the turn's first call, so this is a legal
 * pre-call family (docs/CONTEXT-SIGNALS-PLAN.md, constraint 3). Absent means
 * unknown, never zero: a caller that cannot count its own turns leaves the
 * whole object off and the v5 columns read as "no session context".
 */
export interface SessionForecastContext {
  /** Turn roots that started earlier in this session. Zero on the first turn. */
  turnsSoFar: number;
  /**
   * Output tokens of the immediately previous turn, when that turn had already
   * finished before this one started. Omitted when there is no previous turn or
   * when it was still running, which is a different thing from "it produced 0".
   */
  previousTurnOutputTokens?: number;
}

export interface BoostedForecastContext {
  prompt?: PromptForecastFeatures;
  agentLoop?: AgentLoopForecastContext;
  /**
   * Session-so-far context for the v5 turn-total columns (42-44). Optional for
   * the same reason `textHead` is: most callers hold neither, and a missing
   * family must not read as a session that has done nothing.
   */
  sessionContext?: SessionForecastContext;
  /**
   * `baseTextHead(draft)` — the public base head's `[p50, p90, p99]` on the
   * `log1p(tokens)` scale. Optional because most callers hold only prompt
   * aggregates; when it is absent the v4 columns read as "no head ran" rather
   * than as a short prompt. Text never reaches this request, only these three
   * numbers.
   */
  textHead?: readonly [number, number, number];
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

/**
 * Schemas this runtime can apply, each appending features to its predecessor.
 * v2 appended turn-root image presence (index 36), v3 the compression
 * follow-up bit (index 37), v4 the base text head: its three `log1p(tokens)`
 * quantiles at 38-40 and a presence bit at 41, and v5 the session-so-far
 * family: `log1p(turnsSoFar)` at 42, `log1p(previousTurnOutputTokens)` at 43
 * and a presence bit at 44. A tree trained against an older schema never
 * references an index above that schema's width, so an old profile evaluates
 * identically against the widest feature vector.
 *
 * Indices only ever append; they are never reused. v5's family is *conceptually*
 * v3 + session (the text head it skips over was graded and refused), but it
 * cannot sit at 38-40 without a v4 profile's trees reading session numbers as
 * head quantiles. Which columns a v5 model may actually split on is a training
 * question, and the trainer answers it by offering the v3 prefix plus 42-44;
 * the runtime only needs the width to be monotone.
 */
export const SUPPORTED_BOOST_FEATURE_SCHEMAS = [
  "portable-precall-v1",
  "portable-precall-v2",
  "portable-precall-v3",
  "portable-precall-v4",
  "portable-precall-v5",
] as const;
export type PortableBoostFeatureSchema =
  (typeof SUPPORTED_BOOST_FEATURE_SCHEMAS)[number];
/** Feature-vector width each schema was trained against. */
export const BOOST_FEATURE_COUNT_BY_SCHEMA: Record<
  PortableBoostFeatureSchema,
  number
> = {
  "portable-precall-v1": 36,
  "portable-precall-v2": 37,
  "portable-precall-v3": 38,
  "portable-precall-v4": 42,
  "portable-precall-v5": 45,
};
/** Width the extractor emits today: the newest supported schema. */
export const QUANTILE_BOOST_FEATURE_COUNT = 45;
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

/** The exact feature vector used by the trainer, at the newest schema width. */
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
  // v3: compression follow-up. Binary, not tri-state: a prompt we could read is
  // either a compression follow-up or it is not, and no prompt at all is the
  // same "not a compression follow-up" as a prompt that asks for an artifact.
  features[37] = prompt?.followupCompression ? 1 : 0;
  // v4: the public base text head. Indices 38-40 carry its three log1p
  // quantiles and 41 is the presence bit, so a tree can split on "a head ran"
  // before it splits on what the head said. All four are zero together when
  // the caller had no draft text -- a missing head is not a short prompt.
  const textHead = request.boostedContext.textHead;
  if (textHead !== undefined) {
    if (textHead.length !== 3 || !textHead.every((value) => Number.isFinite(value))) {
      throw new Error("boostedContext.textHead must be three finite numbers");
    }
    features[38] = textHead[0];
    features[39] = textHead[1];
    features[40] = textHead[2];
    features[41] = 1;
  }
  // v5: the session so far. 42 is the turn index inside the session, 43 the
  // previous turn's output tokens, 44 the presence bit, so a tree can split on
  // "the caller knows where it is in the session" before it splits on where.
  // All three are zero together when no session context was supplied -- an
  // unknown session is not a session at its first turn.
  const sessionContext = request.boostedContext.sessionContext;
  if (sessionContext !== undefined) {
    assertNonNegativeInteger("sessionContext.turnsSoFar", sessionContext.turnsSoFar);
    if (sessionContext.previousTurnOutputTokens !== undefined) {
      assertNonNegativeInteger(
        "sessionContext.previousTurnOutputTokens",
        sessionContext.previousTurnOutputTokens,
      );
    }
    features[42] = Math.log1p(sessionContext.turnsSoFar) / 6;
    features[43] = Math.log1p(sessionContext.previousTurnOutputTokens ?? 0) / 10;
    features[44] = 1;
  }
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
  // Width is schema-dependent: a narrower vector is safe for an older profile
  // (its trees never index past its own width), a wider one is safe for any.
  const required =
    BOOST_FEATURE_COUNT_BY_SCHEMA[model.featureSchema as PortableBoostFeatureSchema];
  if (features.length < required || features.length > QUANTILE_BOOST_FEATURE_COUNT) {
    throw new Error(
      `Expected at least ${required} and at most ${QUANTILE_BOOST_FEATURE_COUNT} ` +
        `boost features for ${model.featureSchema}, got ${features.length}`,
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

/**
 * Compression follow-up: "shrink the thing you just produced". Distinct from
 * the corpus sense of "summarize X", which means "go read X, then write a long
 * analysis" — the two regimes have opposite output lengths and, before this
 * feature, no bit separated them.
 *
 * Three conditions, all required. Short (a real compression follow-up is an
 * aside, not a brief); a compression verb; and an object that points back at
 * prior conversation rather than at new material.
 */
const FOLLOWUP_COMPRESSION_MAX_CHARS = 80;
const COMPRESSION_VERB =
  /\b(summari[sz]e|summari[sz]ing|condense|shorten|compress|recap|tl;?dr)\b/;
const MAKE_IT_SHORTER =
  /\bmake (it|this|that) (shorter|smaller|briefer|tighter|concise|more concise|less verbose)\b/;
const ANAPHORIC_OBJECT =
  /^(it|that|this|these|those|them|the above|all of (it|that|the above)|the (last|previous) (message|answer|reply|response|one)|your (last )?(answer|reply|response|message))\b/;
/** Words allowed to trail the anaphor without turning it into a new subject. */
const COMPRESSION_MODIFIER =
  /^(even|much|way|a|an|the|bit|lot|lots|more|further|again|please|pls|now|down|up|hard|harder|short|shorter|small|smaller|brief|briefly|concise|concisely|tight|tighter|less|half|just|really|very|super|so|and|but|then|to|into|in|for|of|as|possible|me|us|ok|okay|thanks|thank|you|one|two|three|couple|few|\d{1,3}|sentences?|lines?|words?|paragraphs?|bullets?|points?)$/;

function isFollowupCompression(prompt: string, lower: string, mentionsPath: boolean): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > FOLLOWUP_COMPRESSION_MAX_CHARS) {
    return false;
  }
  // Naming new material (a path, or a thing to produce) means it is not a
  // follow-up on what was already said.
  if (mentionsPath || ARTIFACT_NOUN.test(lower)) return false;
  if (MAKE_IT_SHORTER.test(lower)) return true;
  const verb = COMPRESSION_VERB.exec(lower);
  if (verb === null) return false;
  const tail = lower
    .slice(verb.index + verb[0].length)
    .replace(/^[\s,:;.!?-]+/, "")
    .trim();
  const anaphor = ANAPHORIC_OBJECT.exec(tail);
  // No object at all ("tl;dr", "shorten") is anaphoric by default: there is
  // nothing else it could refer to.
  const rest = anaphor === null ? tail : tail.slice(anaphor[0].length);
  if (anaphor === null && tail.length > 0 && !isModifierOnly(tail)) return false;
  return isModifierOnly(rest);
}

function isModifierOnly(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9;']+/g) ?? [];
  return words.every((word) => COMPRESSION_MODIFIER.test(word));
}

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
    followupCompression: isFollowupCompression(prompt, lower, pathMention),
  };
}

import { canonicalModelId } from "@token-forecaster/core";
import type { PromptFeatures, UsageObservation, UsageProvider, UsageScale } from "@token-forecaster/core";

/** Empirical quantiles fitted on one group. */
export interface PersonalQuantiles {
  sampleSize: number;
  p50: number;
  p90: number;
  p99: number;
}

/**
 * Dimensions a personal group may condition on.
 *
 * `provider` and `scale` are deliberately absent: they partition the profile
 * rather than appearing inside a group key, because OpenAI and Anthropic tokens
 * are not interchangeable and a per-call distribution is not a per-turn one.
 */
export type PersonalDimension = "model" | "reasoning" | "promptSize" | "promptKind";

/**
 * Backoff ladder, most specific first. The prompt rungs sit above the coarse
 * rungs but are only present in a shipped profile when
 * {@link ../evaluate.js} proved on a chronological holdout that they help.
 */
export const CORE_TIERS: readonly (readonly PersonalDimension[])[] = [
  ["model", "reasoning"],
  ["model"],
  ["reasoning"],
];

/** Prompt-conditioned rungs, adopted only when held-out evaluation supports them. */
export const PROMPT_TIERS: readonly (readonly PersonalDimension[])[] = [
  ["model", "reasoning", "promptSize"],
  ["model", "reasoning", "promptKind"],
  ["promptSize"],
];

/** The tier ladder actually walked at forecast time, in priority order. */
export function tierLadder(withPrompt: boolean): readonly (readonly PersonalDimension[])[] {
  return withPrompt ? [...PROMPT_TIERS.slice(0, 2), ...CORE_TIERS, PROMPT_TIERS[2]!] : CORE_TIERS;
}

/** Sentinel group holding every observation for a (provider, scale). */
export const OVERALL_GROUP = "overall";

/** Coarse prompt-length bucket. Matches the bucketing used by the Claude loader. */
export function promptSizeBucket(features: PromptFeatures | null): string | null {
  if (!features || features.chars === 0) return null;
  if (features.chars < 80) return "lt80";
  if (features.chars < 300) return "80-300";
  if (features.chars < 1200) return "300-1200";
  return "gte1200";
}

/**
 * Prompt-size buckets in order, with the length each one's quantiles are read
 * as speaking for.
 *
 * A rung is fitted on every prompt in its bucket, so its quantiles describe the
 * bucket's centre rather than either edge. The anchors are the geometric
 * centres of the buckets (the open-ended top one is anchored at twice its
 * floor), which is what lets a forecast move *within* a bucket instead of
 * snapping four times across the whole range: see
 * {@link ../forecast.js} `interpolatePromptSize`.
 */
export const PROMPT_SIZE_ANCHORS: readonly (readonly [string, number])[] = [
  ["lt80", 40],
  ["80-300", 155],
  ["300-1200", 600],
  ["gte1200", 2400],
];

/** Coarse prompt-intent bucket. */
export function promptKindBucket(features: PromptFeatures | null): string | null {
  if (!features || features.chars === 0) return null;
  if (features.hasImperative) return features.codeFences > 0 ? "task+code" : "task";
  if (features.hasQuestion) return "question";
  return "other";
}

/** Dimension values for one observation, or `null` where the value is unknown. */
export function dimensionValues(
  observation: Pick<UsageObservation, "model" | "reasoning" | "promptFeatures">,
): Partial<Record<PersonalDimension, string>> {
  const out: Partial<Record<PersonalDimension, string>> = {};
  // Keyed on the canonical id so a rung fitted from a transcript is found by a
  // client that names the same model differently.
  const model = canonicalModelId(observation.model);
  if (model) out.model = model;
  if (observation.reasoning) out.reasoning = observation.reasoning;
  const size = promptSizeBucket(observation.promptFeatures);
  if (size) out.promptSize = size;
  const kind = promptKindBucket(observation.promptFeatures);
  if (kind) out.promptKind = kind;
  return out;
}

/**
 * Build a group key, or `null` when any dimension of the tier is unknown.
 *
 * An unknown dimension must never collapse to a level such as `"none"`: doing so
 * would pool "no thinking" with "thinking not recorded" and quietly bias the
 * quantiles.
 */
export function personalGroupKey(
  dimensions: readonly PersonalDimension[],
  values: Partial<Record<PersonalDimension, string>>,
): string | null {
  const parts: string[] = [];
  for (const dim of dimensions) {
    const value = values[dim];
    if (value === undefined) return null;
    parts.push(`${dim}=${encodeURIComponent(value)}`);
  }
  return parts.join("|");
}

/** One provider × scale slice of a personal profile. */
export interface PersonalScaleProfile {
  provider: UsageProvider;
  scale: UsageScale;
  /** Observations that went into this slice. */
  sampleSize: number;
  /**
   * Whether conditioned rungs were kept for this slice. False means the
   * chronological holdout found conditioning no better than this user's
   * unconditional distribution, so only `overall` is stored.
   */
  conditioned: boolean;
  /**
   * Whether this slice may serve forecasts at all.
   *
   * A personal profile is not automatically better than the profile shipped in
   * the box: on a thin slice it is reliably worse, because a handful of
   * observations buys noisy quantiles where the bundled profile has thousands.
   * So the same chronological holdout that decides *how* to condition also
   * decides *whether* to serve, and a slice that cannot beat a cold start by
   * {@link ../evaluate.js} `ADOPTION_MARGIN` is stored but not served. False
   * here sends {@link ../forecast.js} `personalForecast` to the cold start.
   */
  adopted: boolean;
  /** Why {@link adopted} is what it is, in one sentence. */
  adoptedReason: string;
  /** Earliest and latest observation timestamps, ISO-8601. */
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Distinct models seen, for the UI. */
  models: string[];
  /** Group key → quantiles, including {@link OVERALL_GROUP}. */
  groups: Record<string, PersonalQuantiles>;
}

/** A profile trained entirely on one person's local history. */
export interface PersonalProfile {
  id: string;
  generatedAt: string;
  /** Always local: this profile is never fitted on anyone else's calls. */
  provenance: "local-personal";
  /** Whether prompt-conditioned rungs were adopted, and why. */
  promptTiersAdopted: boolean;
  promptTiersReason: string;
  /** Minimum group size required before a rung may be used at forecast time. */
  minSamples: number;
  /** Keyed `${provider}|${scale}`. */
  scales: Record<string, PersonalScaleProfile>;
}

/** Key for {@link PersonalProfile.scales}. */
export function scaleKey(provider: UsageProvider, scale: UsageScale): string {
  return `${provider}|${scale}`;
}

import type { UsageObservation } from "@token-forecaster/core";

import {
  CORE_TIERS,
  OVERALL_GROUP,
  PROMPT_TIERS,
  dimensionValues,
  personalGroupKey,
  scaleKey,
  type PersonalProfile,
  type PersonalDimension,
  type PersonalQuantiles,
  type PersonalScaleProfile,
} from "./profile.js";

/**
 * Empirical quantile with linear interpolation between order statistics.
 *
 * @param sorted Ascending values. Must be non-empty.
 * @param p      Quantile in [0, 1].
 */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("quantile requires at least one value");
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function fit(values: number[]): PersonalQuantiles {
  values.sort((a, b) => a - b);
  return {
    sampleSize: values.length,
    p50: Math.round(quantile(values, 0.5)),
    p90: Math.round(quantile(values, 0.9)),
    p99: Math.round(quantile(values, 0.99)),
  };
}

/**
 * What a chronological holdout concluded for one provider x scale slice.
 *
 * Conditioning is not a global choice. On this user's corpus, conditioning on
 * model helps enormously for whole-turn totals and actively hurts for
 * individual Codex calls — so the decision is recorded per slice and a slice
 * that lost keeps only its unconditional distribution.
 */
export interface SliceDecision {
  /** Store conditioned rungs at all. */
  conditioning: boolean;
  /** Store prompt-derived rungs. Ignored when `conditioning` is false. */
  prompt: boolean;
}

/** Options for {@link trainPersonalProfile}. */
export interface TrainPersonalOptions {
  id: string;
  /** Include prompt-conditioned rungs. Only set this when a holdout supports it. */
  withPromptTiers: boolean;
  /** Reason recorded on the profile for the above decision. */
  promptTiersReason: string;
  /**
   * Per-slice overrides keyed by `scaleKey(provider, scale)`. A slice with no
   * entry uses `withPromptTiers` and keeps its conditioned rungs.
   */
  decisions?: Readonly<Record<string, SliceDecision>>;
  /**
   * Per-slice permission to serve, keyed by `scaleKey(provider, scale)`.
   *
   * Separate from {@link decisions} on purpose. A decision says how to fit a
   * slice; this says whether the result is allowed to answer a forecast at all,
   * which is a judgement against the *bundled* profile rather than against this
   * user's own baseline. A slice with no entry is served — that is what the
   * evaluation and sufficiency candidates rely on, since they exist to measure
   * an ungated personal model.
   */
  serve?: Readonly<Record<string, boolean>>;
  /** Why a slice is or is not served, keyed the same way. */
  serveReasons?: Readonly<Record<string, string>>;
  /** Minimum group size the forecaster requires. Default 60. */
  minSamples?: number;
  /** Groups smaller than this are not stored at all. Default 20. */
  minStoredSamples?: number;
  now?: Date;
}

/**
 * Fit hierarchical empirical quantiles on one person's observations.
 *
 * Observations are partitioned by provider and scale first — OpenAI and
 * Anthropic tokens are never pooled, and per-call and per-turn distributions are
 * kept apart — then grouped along the backoff ladder.
 */
export function trainPersonalProfile(
  observations: readonly UsageObservation[],
  options: TrainPersonalOptions,
): PersonalProfile {
  const minStored = options.minStoredSamples ?? 20;
  const decisions = options.decisions ?? {};
  const serve = options.serve ?? {};
  const serveReasons = options.serveReasons ?? {};
  const tiersFor = (key: string): readonly (readonly PersonalDimension[])[] => {
    const decision = decisions[key];
    if (decision && !decision.conditioning) return [];
    const prompt = decision ? decision.prompt : options.withPromptTiers;
    return prompt ? [...CORE_TIERS, ...PROMPT_TIERS] : CORE_TIERS;
  };

  interface Bucket {
    provider: UsageObservation["provider"];
    scale: UsageObservation["scale"];
    all: number[];
    groups: Map<string, number[]>;
    models: Set<string>;
    first: string | null;
    last: string | null;
  }
  const buckets = new Map<string, Bucket>();

  for (const observation of observations) {
    if (!Number.isFinite(observation.outputTokens) || observation.outputTokens <= 0) continue;
    const key = scaleKey(observation.provider, observation.scale);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        provider: observation.provider,
        scale: observation.scale,
        all: [],
        groups: new Map(),
        models: new Set(),
        first: null,
        last: null,
      };
      buckets.set(key, bucket);
    }
    bucket.all.push(observation.outputTokens);
    if (observation.model) bucket.models.add(observation.model);
    if (bucket.first === null || observation.timestamp < bucket.first) {
      bucket.first = observation.timestamp;
    }
    if (bucket.last === null || observation.timestamp > bucket.last) {
      bucket.last = observation.timestamp;
    }

    const values = dimensionValues(observation);
    for (const tier of tiersFor(key)) {
      const groupKey = personalGroupKey(tier, values);
      if (groupKey === null) continue;
      const existing = bucket.groups.get(groupKey);
      if (existing) existing.push(observation.outputTokens);
      else bucket.groups.set(groupKey, [observation.outputTokens]);
    }
  }

  const scales: Record<string, PersonalScaleProfile> = {};
  for (const [key, bucket] of buckets) {
    if (bucket.all.length === 0) continue;
    const groups: Record<string, PersonalQuantiles> = { [OVERALL_GROUP]: fit(bucket.all) };
    for (const [groupKey, values] of bucket.groups) {
      if (values.length < minStored) continue;
      groups[groupKey] = fit(values);
    }
    scales[key] = {
      provider: bucket.provider,
      scale: bucket.scale,
      conditioned: tiersFor(key).length > 0,
      adopted: serve[key] ?? true,
      adoptedReason:
        serveReasons[key] ??
        (serve[key] === false
          ? "held-out evaluation did not show this slice beating a cold start"
          : "no held-out verdict recorded; serving this user's own history"),
      sampleSize: bucket.all.length,
      firstObservedAt: bucket.first,
      lastObservedAt: bucket.last,
      models: [...bucket.models].sort(),
      groups,
    };
  }

  return {
    id: options.id,
    generatedAt: (options.now ?? new Date()).toISOString(),
    provenance: "local-personal",
    promptTiersAdopted: options.withPromptTiers,
    promptTiersReason: options.promptTiersReason,
    minSamples: options.minSamples ?? 60,
    scales,
  };
}

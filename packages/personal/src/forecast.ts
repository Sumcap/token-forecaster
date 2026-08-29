import { canonicalModelId } from "@token-forecaster/core";
import type { PromptFeatures, UsageProvider, UsageScale } from "@token-forecaster/core";
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  historicalBaselineForecast,
  historicalTurnTotalForecast,
  staticBaselineForecast,
} from "@token-forecaster/predictor";

import {
  CORE_TIERS,
  OVERALL_GROUP,
  PROMPT_SIZE_ANCHORS,
  dimensionValues,
  personalGroupKey,
  scaleKey,
  tierLadder,
  type PersonalDimension,
  type PersonalQuantiles,
  type PersonalProfile,
  type PersonalScaleProfile,
} from "./profile.js";

/** Where a forecast's numbers came from. */
export type PersonalForecastSource =
  /** A conditioned rung of this user's own profile. */
  | "personal_group"
  /** This user's unconditional distribution for the provider and scale. */
  | "personal_overall"
  /** The shipped Claude Code profile — someone else's data, cold start only. */
  | "bundled_fallback"
  /** No usable distribution at all. */
  | "static_baseline";

/** A forecast request. Carries features, never prompt text. */
export interface PersonalForecastRequest {
  provider: UsageProvider;
  scale: UsageScale;
  model?: string | null;
  reasoning?: string | null;
  promptFeatures?: PromptFeatures | null;
  /** Hard output cap to clamp against, when the caller knows one. */
  maxTokens?: number;
  /**
   * Read the prompt-size rungs as a curve rather than four steps.
   *
   * The rungs are fitted on buckets, so on their own they hold a forecast still
   * for every prompt from 80 to 300 characters and then jump. That is fine for
   * scoring a finished turn and useless for a bar someone is watching while
   * they type. With this on the draft is placed *between* rungs, so the number
   * moves as it is written; see {@link livePromptForecast} for what is read off
   * whose data. Off by default: evaluation scores the rungs as they were
   * fitted, and turning it on there would be marking its own homework.
   */
  interpolatePromptSize?: boolean;
}

/** A forecast with the provenance needed to judge how much to trust it. */
export interface PersonalForecastResult {
  p50: number;
  p90: number;
  p99: number;
  source: PersonalForecastSource;
  /** The rung used, or `null` for the non-personal fallbacks. */
  groupKey: string | null;
  /** Observations behind the rung, or 0 when not personal. */
  sampleSize: number;
  provider: UsageProvider;
  scale: UsageScale;
  /** True whenever the numbers are not this user's own. */
  usedFallback: boolean;
  /** Human-readable explanation of why this source was chosen. */
  reason: string;
}

const DEFAULT_MAX_TOKENS = 64_000;
/** Below this the unconditional personal rung is worse than a cold start. */
const MIN_OVERALL_SAMPLES = 30;

/**
 * Forecast P50/P90/P99 output tokens for one request.
 *
 * The ladder walks this user's own rungs first, then their unconditional
 * distribution, and only then falls back to the shipped profile. The fallback is
 * never silent: {@link PersonalForecastResult.source} always says whose data
 * produced the numbers.
 */
export function personalForecast(
  profile: PersonalProfile | null,
  request: PersonalForecastRequest,
): PersonalForecastResult {
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const model = canonicalModelId(request.model ?? null);
  const stored = profile?.scales[scaleKey(request.provider, request.scale)];
  // A slice that did not beat a cold start on its own holdout is kept for the
  // dashboard but never answers a forecast: serving it would be shipping a
  // measured regression. `adopted` is absent on profiles written before the gate
  // existed, and those are served — the next rebuild stamps a real verdict.
  const gated = stored !== undefined && stored.adopted === false;
  const slice = gated ? undefined : stored;

  if (slice) {
    const values = dimensionValues({
      model,
      reasoning: request.reasoning ?? null,
      promptFeatures: request.promptFeatures ?? null,
    });
    if (request.interpolatePromptSize === true) {
      const live = livePromptForecast(slice, values, request.promptFeatures ?? null, profile!);
      if (live) {
        return clamp({
          ...live,
          source: "personal_group",
          provider: request.provider,
          scale: request.scale,
          usedFallback: false,
        }, maxTokens);
      }
    }

    for (const tier of tierLadder(profile!.promptTiersAdopted)) {
      const key = personalGroupKey(tier, values);
      if (key === null) continue;
      const group = slice.groups[key];
      if (!group || group.sampleSize < profile!.minSamples) continue;
      return clamp({
        p50: group.p50,
        p90: group.p90,
        p99: group.p99,
        source: "personal_group",
        groupKey: key,
        sampleSize: group.sampleSize,
        provider: request.provider,
        scale: request.scale,
        usedFallback: false,
        reason: `personal rung ${key} (n=${group.sampleSize})`,
      }, maxTokens);
    }

    const overall = slice.groups[OVERALL_GROUP];
    if (overall && overall.sampleSize >= MIN_OVERALL_SAMPLES) {
      return clamp({
        p50: overall.p50,
        p90: overall.p90,
        p99: overall.p99,
        source: "personal_overall",
        groupKey: OVERALL_GROUP,
        sampleSize: overall.sampleSize,
        provider: request.provider,
        scale: request.scale,
        usedFallback: false,
        reason: `no conditioned rung reached n>=${profile!.minSamples}; using this user's unconditional ${request.provider} ${request.scale} distribution`,
      }, maxTokens);
    }
  }

  return coldStart(
    { ...request, model },
    maxTokens,
    gated
      ? `your ${request.provider} ${request.scale} history is not being used: ${stored!.adoptedReason}`
      : null,
  );
}

/**
 * A forecast that moves with the length of the prompt, for a prompt someone is
 * still writing.
 *
 * The rungs are fitted on four length buckets, so read literally they hold one
 * number for every prompt from 80 to 300 characters and then jump. That is the
 * right way to score a finished turn and the wrong way to drive a bar someone
 * is watching while they type. Here the same rungs are read as points on a
 * curve — each one speaking for the centre of its bucket — and the draft is
 * placed between them, on log length because the buckets are geometric.
 *
 * There are two ways to get that curve, in order of preference:
 *
 *  1. This user's own size rungs for this model and reasoning level, when two
 *     of them bracket the draft. Nothing is borrowed and nothing is modelled.
 *  2. Failing that — and it fails often, because splitting a model by four
 *     lengths thins every rung — the size curve measured across *all* of this
 *     user's turns, applied as a ratio to whatever coarse rung the ladder would
 *     have used. The level stays this model's; only the shape is pooled.
 *
 * Both stop at the outermost anchor rather than extrapolating: past 2400
 * characters the honest answer is the last thing that was actually measured.
 * `null` means neither route had the data, and the plain ladder runs instead.
 */
function livePromptForecast(
  slice: PersonalScaleProfile,
  values: Partial<Record<PersonalDimension, string>>,
  features: PromptFeatures | null,
  profile: PersonalProfile,
): { p50: number; p90: number; p99: number; groupKey: string; sampleSize: number; reason: string } | null {
  const chars = features?.chars ?? 0;
  if (chars <= 0 || !profile.promptTiersAdopted) return null;
  const minSamples = profile.minSamples;

  const own: readonly PersonalDimension[] = ["model", "reasoning", "promptSize"];
  const ownAnchors = sizeAnchors(slice, own, values, minSamples);
  const ownCurve = interpolateAnchors(ownAnchors, chars, false);
  if (ownCurve) {
    return {
      ...ownCurve.quantiles,
      groupKey: personalGroupKey(own, values) ?? OVERALL_GROUP,
      sampleSize: ownCurve.sampleSize,
      reason: `your ${values.model}/${values.reasoning} size rungs read as a curve at ${chars} characters (between ${ownCurve.between})`,
    };
  }

  // Pooled shape on a personal level. The ratio is taken against this user's
  // unconditional distribution, which is exactly what the pooled size rungs
  // partition — so a ratio of 1 means "a prompt of this length is unremarkable
  // for you", and the coarse rung passes through unchanged.
  const pooled: readonly PersonalDimension[] = ["promptSize"];
  const pooledCurve = interpolateAnchors(sizeAnchors(slice, pooled, values, minSamples), chars, true);
  const overall = slice.groups[OVERALL_GROUP];
  if (!pooledCurve || !overall) return null;

  for (const tier of CORE_TIERS) {
    const key = personalGroupKey(tier, values);
    if (key === null) continue;
    const base = slice.groups[key];
    if (!base || base.sampleSize < minSamples) continue;
    const scale = (level: number, at: number, reference: number): number =>
      reference > 0 ? level * (at / reference) : level;
    return {
      p50: scale(base.p50, pooledCurve.quantiles.p50, overall.p50),
      p90: scale(base.p90, pooledCurve.quantiles.p90, overall.p90),
      p99: scale(base.p99, pooledCurve.quantiles.p99, overall.p99),
      groupKey: key,
      sampleSize: base.sampleSize,
      reason: `personal rung ${key} (n=${base.sampleSize}) scaled by your prompt-length curve at ${chars} characters (${pooledCurve.between})`,
    };
  }
  return null;
}

/**
 * The size rungs of one tier that have enough observations to be read, as
 * (length, quantiles) points ordered by length.
 */
function sizeAnchors(
  slice: PersonalScaleProfile,
  tier: readonly PersonalDimension[],
  values: Partial<Record<PersonalDimension, string>>,
  minSamples: number,
): { at: number; bucket: string; quantiles: PersonalQuantiles }[] {
  const points: { at: number; bucket: string; quantiles: PersonalQuantiles }[] = [];
  for (const [bucket, at] of PROMPT_SIZE_ANCHORS) {
    const key = personalGroupKey(tier, { ...values, promptSize: bucket });
    if (key === null) continue;
    const group = slice.groups[key];
    if (group && group.sampleSize >= minSamples) points.push({ at, bucket, quantiles: group });
  }
  return points;
}

/**
 * Read `chars` off a curve through `points`, linearly in log length.
 *
 * Outside the outermost points the answer is either the nearest measured point
 * (`clampEnds`) or nothing at all — never a line extended past its data.
 */
function interpolateAnchors(
  points: { at: number; bucket: string; quantiles: PersonalQuantiles }[],
  chars: number,
  clampEnds: boolean,
): { quantiles: { p50: number; p90: number; p99: number }; sampleSize: number; between: string } | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (chars <= first.at) {
    return clampEnds ? { quantiles: first.quantiles, sampleSize: first.quantiles.sampleSize, between: first.bucket } : null;
  }
  if (chars >= last.at) {
    return clampEnds ? { quantiles: last.quantiles, sampleSize: last.quantiles.sampleSize, between: last.bucket } : null;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i]!;
    const high = points[i + 1]!;
    if (chars < low.at || chars > high.at) continue;
    const weight = (Math.log(chars) - Math.log(low.at)) / (Math.log(high.at) - Math.log(low.at));
    const mix = (a: number, b: number): number => a + (b - a) * weight;
    return {
      quantiles: {
        p50: mix(low.quantiles.p50, high.quantiles.p50),
        p90: mix(low.quantiles.p90, high.quantiles.p90),
        p99: mix(low.quantiles.p99, high.quantiles.p99),
      },
      sampleSize: low.quantiles.sampleSize + high.quantiles.sampleSize,
      between: `${low.bucket} and ${high.bucket}`,
    };
  }
  return null;
}

/**
 * Cold start: no personal data yet.
 *
 * Anthropic requests reuse the profile bundled with the predictor package.
 * OpenAI requests have no bundled counterpart — mixing in Anthropic quantiles
 * would be exactly the cross-provider pooling this package exists to avoid — so
 * they fall through to the static baseline.
 */
function coldStart(
  request: PersonalForecastRequest,
  maxTokens: number,
  gatedReason: string | null = null,
): PersonalForecastResult {
  const because = (reason: string): string =>
    gatedReason === null ? reason : `${reason} — ${gatedReason}`;
  if (request.provider === "anthropic") {
    if (request.scale === "turn") {
      const turn = historicalTurnTotalForecast(
        request.model ? { model: request.model } : {},
        BUNDLED_CLAUDE_CODE_PROFILE,
      );
      if (turn) {
        return clamp({
          p50: turn.p50,
          p90: turn.p90,
          p99: turn.p99,
          source: "bundled_fallback",
          groupKey: turn.groupKey,
          sampleSize: 0,
          provider: request.provider,
          scale: request.scale,
          usedFallback: true,
          reason: because("cold start: bundled Claude Code turn totals (not this user's data)"),
        }, maxTokens);
      }
    } else {
      const result = historicalBaselineForecast(
        { model: request.model ?? "unknown", maxTokens },
        BUNDLED_CLAUDE_CODE_PROFILE,
      );
      return clamp({
        p50: result.forecast.p50,
        p90: result.forecast.p90,
        p99: result.forecast.p99 ?? result.forecast.p90,
        source: "bundled_fallback",
        groupKey: result.calibration.groupKey,
        sampleSize: 0,
        provider: request.provider,
        scale: request.scale,
        usedFallback: true,
        reason: because("cold start: bundled Claude Code per-call profile (not this user's data)"),
      }, maxTokens);
    }
  }

  const base = staticBaselineForecast(maxTokens);
  return clamp({
    p50: base.p50,
    p90: base.p90,
    p99: base.p99 ?? base.p90,
    source: "static_baseline",
    groupKey: null,
    sampleSize: 0,
    provider: request.provider,
    scale: request.scale,
    usedFallback: true,
    reason: because(
      request.provider === "openai"
        ? "cold start: no personal OpenAI history and no bundled OpenAI profile; Anthropic quantiles are not transferable"
        : "cold start: no usable distribution",
    ),
  }, maxTokens);
}

function clamp(result: PersonalForecastResult, maxTokens: number): PersonalForecastResult {
  const p50 = Math.min(Math.max(0, Math.round(result.p50)), maxTokens);
  const p90 = Math.min(Math.max(p50, Math.round(result.p90)), maxTokens);
  const p99 = Math.min(Math.max(p90, Math.round(result.p99)), maxTokens);
  return { ...result, p50, p90, p99 };
}

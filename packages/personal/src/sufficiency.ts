import type { UsageObservation } from "@token-forecaster/core";

import { scoreForecaster, type CandidateScore } from "./evaluate.js";
import { personalForecast } from "./forecast.js";
import { scaleKey, type PersonalProfile } from "./profile.js";
import { trainPersonalProfile, type SliceDecision } from "./train.js";

/**
 * How much history is enough?
 *
 * The only honest way to answer that is to measure it: fit the deployed model
 * on progressively larger slices of the user's own past, score every fit on the
 * same strictly-later holdout, and look at where the curve stops falling. A
 * threshold picked by intuition ("you need 1,000 calls") would be a guess
 * dressed up as a number.
 *
 * The curve uses the most *recent* N training rows at each point rather than
 * the oldest, because that matches how the product actually works — it always
 * has your latest history, and the question is how far back it needs to reach.
 */

/** One point on a learning curve. */
export interface LearningPoint {
  /** Training observations used for this fit. */
  n: number;
  /** Mean pinball loss on the fixed holdout. Lower is better. */
  pinballMean: number;
  coverageP50: number;
  coverageP90: number;
  /** Share of holdout rows that still fell back off this user's own data. */
  fallbackShare: number;
}

/** Whether a slice has enough data, and what more would buy. */
export type SufficiencyVerdict =
  /** Not enough to fit anything; forecasts come from the cold-start fallback. */
  | "cold"
  /** Fitted, but the curve is still falling fast — more history will help. */
  | "thin"
  /** Working, still improving slowly. */
  | "usable"
  /** The curve has flattened. More of the same data will not help. */
  | "saturated";

/** Data-sufficiency report for one provider × scale slice. */
export interface SliceSufficiency {
  provider: UsageObservation["provider"];
  scale: UsageObservation["scale"];
  totalObservations: number;
  trainN: number;
  holdoutN: number;
  sessions: number;
  /** Calendar days between the first and last observation. */
  spanDays: number;
  curve: LearningPoint[];
  /** Loss at the largest fit, i.e. what you have today. */
  currentPinball: number;
  /** Best loss anywhere on the curve. */
  bestPinball: number;
  /**
   * Relative loss reduction from halving-to-full training data. This is the
   * marginal value of the most recent doubling of history, and the basis of the
   * verdict.
   */
  gainFromLastDoubling: number;
  /** Smallest n whose loss is within 5% of the best on the curve. */
  saturationN: number | null;
  /** Loss of the cold-start fallback on the same holdout, for reference. */
  coldStartPinball: number;
  /**
   * Smallest measured n at which the personal model beat the cold start. The
   * most useful single number here: how much of your own history it takes
   * before the generic profile stops being the better answer.
   */
  beatsColdStartAtN: number | null;
  /**
   * True when the curve saturates on well under half the available history —
   * recency matters more than volume, and the older data is not carrying the
   * forecast.
   */
  recencyDominates: boolean;
  verdict: SufficiencyVerdict;
  verdictReason: string;
  /**
   * Rough count of further observations worth collecting, or 0 when the curve
   * has flattened. Stated as "about another doubling", not a promise.
   */
  suggestedAdditional: number;
}

/** The whole report. */
export interface SufficiencyReport {
  generatedAt: string;
  slices: SliceSufficiency[];
  /** Overall readiness, driven by the weakest slice that is actually in use. */
  headline: string;
}

/** Minimum rows before a slice can be fitted at all. Mirrors the forecaster. */
const MIN_FITTABLE = 60;
/** Loss reduction per doubling below which the curve counts as flat. */
const FLAT_THRESHOLD = 0.02;
/** Loss reduction per doubling above which the curve is still falling fast. */
const STEEP_THRESHOLD = 0.1;
/** Fractions of the training window sampled for the curve, most recent first. */
const CURVE_FRACTIONS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1] as const;

/** Options for {@link measureSufficiency}. */
export interface SufficiencyOptions {
  trainFraction?: number;
  minHoldout?: number;
  /** Per-slice decisions from the evaluation, so the curve measures what ships. */
  decisions?: Readonly<Record<string, SliceDecision>>;
  now?: Date;
}

/**
 * Measure, per slice, how forecast quality responds to more history.
 *
 * @param observations Every stored observation.
 * @param options      Split and per-slice training decisions.
 */
export function measureSufficiency(
  observations: readonly UsageObservation[],
  options: SufficiencyOptions = {},
): SufficiencyReport {
  const trainFraction = options.trainFraction ?? 0.7;
  const minHoldout = options.minHoldout ?? 100;
  const decisions = options.decisions ?? {};

  const bySlice = new Map<string, UsageObservation[]>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.outputTokens) || observation.outputTokens <= 0) continue;
    if (observation.usageSource !== "provider_exact") continue;
    if (!Number.isFinite(Date.parse(observation.timestamp))) continue;
    const key = scaleKey(observation.provider, observation.scale);
    const list = bySlice.get(key);
    if (list) list.push(observation);
    else bySlice.set(key, [observation]);
  }

  const slices: SliceSufficiency[] = [];
  for (const [key, rows] of bySlice) {
    rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const sessions = new Set(rows.map((r) => r.sessionId)).size;
    const spanDays = Math.max(
      0,
      Math.round((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 86_400_000),
    );

    const splitIndex = Math.max(
      1,
      Math.min(rows.length - 1, Math.floor(rows.length * trainFraction)),
    );
    const train = rows.slice(0, splitIndex);
    const holdout = rows.slice(splitIndex);

    const base = {
      provider: first.provider,
      scale: first.scale,
      totalObservations: rows.length,
      trainN: train.length,
      holdoutN: holdout.length,
      sessions,
      spanDays,
    };

    if (holdout.length < minHoldout || train.length < MIN_FITTABLE) {
      slices.push({
        ...base,
        curve: [],
        currentPinball: 0,
        bestPinball: 0,
        gainFromLastDoubling: 0,
        saturationN: null,
        coldStartPinball: 0,
        beatsColdStartAtN: null,
        recencyDominates: false,
        verdict: "cold",
        verdictReason:
          train.length < MIN_FITTABLE
            ? `only ${train.length} fittable observations; ${MIN_FITTABLE} are needed before a personal rung is used, so forecasts come from the cold-start fallback`
            : `only ${holdout.length} held-out observations; at least ${minHoldout} are needed to measure quality at all`,
        suggestedAdditional: Math.max(0, MIN_FITTABLE * 2 - rows.length),
      });
      continue;
    }

    const decision = decisions[key];
    // The reference line: what a brand-new install would score on this holdout.
    const coldStartPinball = scoreForecaster("cold_start", holdout, (o) =>
      predictFor(null, o),
    ).pinballMean;
    const curve: LearningPoint[] = [];
    for (const fraction of CURVE_FRACTIONS) {
      const n = Math.floor(train.length * fraction);
      if (n < 20) continue;
      // Take the most recent n training rows: the product always has your
      // latest history, so that is the fit worth measuring.
      const window = train.slice(train.length - n);
      const profile = trainPersonalProfile(window, {
        id: `sufficiency-${n}`,
        withPromptTiers: decision?.prompt ?? false,
        promptTiersReason: "sufficiency curve",
        ...(decision ? { decisions: { [key]: decision } } : {}),
      });
      const score = scoreForecaster(String(n), holdout, (o) => predictFor(profile, o));
      curve.push({
        n,
        pinballMean: score.pinballMean,
        coverageP50: score.coverageP50,
        coverageP90: score.coverageP90,
        fallbackShare: fallbackShare(score),
      });
    }

    if (curve.length === 0) {
      slices.push({
        ...base,
        curve,
        currentPinball: 0,
        bestPinball: 0,
        gainFromLastDoubling: 0,
        saturationN: null,
        coldStartPinball,
        beatsColdStartAtN: null,
        recencyDominates: false,
        verdict: "cold",
        verdictReason: "not enough training rows to fit even the smallest curve point",
        suggestedAdditional: MIN_FITTABLE,
      });
      continue;
    }

    const full = curve[curve.length - 1]!;
    const half = curve.length >= 2 ? curve[curve.length - 2]! : null;
    const bestPinball = Math.min(...curve.map((p) => p.pinballMean));
    const gainFromLastDoubling =
      half && half.pinballMean > 0 ? 1 - full.pinballMean / half.pinballMean : 0;
    const saturation = curve.find((p) => p.pinballMean <= bestPinball * 1.05);
    const beatsColdStart = curve.find((p) => p.pinballMean < coldStartPinball);
    const recencyDominates =
      saturation !== undefined && saturation.n <= train.length * 0.25;

    let verdict: SufficiencyVerdict;
    let verdictReason: string;
    let suggestedAdditional = 0;
    if (gainFromLastDoubling >= STEEP_THRESHOLD) {
      verdict = "thin";
      verdictReason = `doubling from ${half!.n.toLocaleString()} to ${full.n.toLocaleString()} observations still cut error by ${(gainFromLastDoubling * 100).toFixed(0)}%; the curve has not flattened, so more history will measurably help`;
      suggestedAdditional = full.n;
    } else if (gainFromLastDoubling >= FLAT_THRESHOLD) {
      verdict = "usable";
      verdictReason = `the last doubling of history cut error by ${(gainFromLastDoubling * 100).toFixed(0)}%; still improving, but slowly`;
      suggestedAdditional = Math.round(full.n / 2);
    } else {
      verdict = "saturated";
      verdictReason =
        gainFromLastDoubling <= 0
          ? `doubling the history did not reduce error (${(gainFromLastDoubling * 100).toFixed(0)}%); the limit here is what the model conditions on, not how much data you have`
          : `the last doubling of history cut error by only ${(gainFromLastDoubling * 100).toFixed(0)}%; more of the same data will not help`;
    }

    if (recencyDominates && saturation) {
      verdictReason += `. The most recent ${saturation.n.toLocaleString()} observations forecast as well as all ${train.length.toLocaleString()}, so recency matters more than volume here`;
    }

    slices.push({
      ...base,
      curve,
      currentPinball: full.pinballMean,
      bestPinball,
      gainFromLastDoubling,
      saturationN: saturation?.n ?? null,
      coldStartPinball,
      beatsColdStartAtN: beatsColdStart?.n ?? null,
      recencyDominates,
      verdict,
      verdictReason,
      suggestedAdditional,
    });
  }

  slices.sort((a, b) => b.totalObservations - a.totalObservations);
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    slices,
    headline: headline(slices),
  };
}

function headline(slices: readonly SliceSufficiency[]): string {
  if (slices.length === 0) return "No usable history has been indexed yet.";
  const thresholds = slices
    .map((s) => s.beatsColdStartAtN)
    .filter((value): value is number => value !== null);
  const cold = slices.filter((s) => s.verdict === "cold");
  const thin = slices.filter((s) => s.verdict === "thin");
  const saturated = slices.filter((s) => s.verdict === "saturated");
  const parts: string[] = [];
  if (saturated.length) {
    parts.push(
      `${saturated.length} of ${slices.length} slices have plateaued — more history will not improve them`,
    );
  }
  if (thin.length) {
    parts.push(`${thin.length} would still improve measurably with more history`);
  }
  if (cold.length) {
    parts.push(`${cold.length} do not yet have enough data to fit and use the cold-start fallback`);
  }
  const threshold = thresholds.length
    ? ` The personal model overtook the generic one at as few as ${Math.min(...thresholds).toLocaleString()} of your own observations.`
    : "";
  return `${parts.join("; ")}.${threshold}`;
}

function fallbackShare(score: CandidateScore): number {
  const total = Object.values(score.sources).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const fallback =
    (score.sources["bundled_fallback"] ?? 0) + (score.sources["static_baseline"] ?? 0);
  return fallback / total;
}

function predictFor(profile: PersonalProfile | null, observation: UsageObservation) {
  return personalForecast(profile, {
    provider: observation.provider,
    scale: observation.scale,
    model: observation.model,
    reasoning: observation.reasoning,
    promptFeatures: observation.promptFeatures,
  });
}

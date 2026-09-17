import type { UsageObservation, UsageProvider, UsageScale } from "@token-forecaster/core";

import { personalForecast, type PersonalForecastResult } from "./forecast.js";
import { scaleKey, type PersonalProfile } from "./profile.js";
import { trainPersonalProfile } from "./train.js";

/**
 * Chronological replay: fit on earlier sessions, score later ones.
 *
 * Nothing here ever scores a profile on an observation that was used to fit it.
 * The split is by time, not at random, because the question the product asks is
 * "does last month's history predict tomorrow's task", and a random split
 * silently answers an easier one.
 */

/**
 * Relative pinball-loss reduction a candidate must clear before it is adopted.
 *
 * Without a margin, a tie decided in the fourth significant figure counts as
 * "personalization helped" — which is exactly the claim this module exists to
 * avoid making on noise.
 */
export const ADOPTION_MARGIN = 0.02;

/** Pinball (quantile) loss. */
export function pinball(actual: number, predicted: number, q: number): number {
  const delta = actual - predicted;
  return delta >= 0 ? q * delta : (q - 1) * delta;
}

/** Scores for one candidate forecaster on one holdout. */
export interface CandidateScore {
  name: string;
  n: number;
  /** Fraction of holdout actuals at or below the forecast quantile. */
  coverageP50: number;
  coverageP90: number;
  coverageP99: number;
  pinballP50: number;
  pinballP90: number;
  pinballP99: number;
  /** Mean pinball across the three quantiles — the headline number. */
  pinballMean: number;
  /** Mean P90 − P50, in tokens. Narrower is better at equal coverage. */
  meanIntervalWidth: number;
  /** Median forecast P50, for scale sanity. */
  medianP50: number;
  /** How often each source was used. */
  sources: Record<string, number>;
}

/** One provider × scale evaluation. */
export interface SliceEvaluation {
  provider: UsageProvider;
  scale: UsageScale;
  trainN: number;
  holdoutN: number;
  trainSpan: [string, string] | null;
  holdoutSpan: [string, string] | null;
  candidates: CandidateScore[];
  /** Winner by mean pinball loss. */
  best: string;
  /**
   * Whether the conditioned personal model beat this user's own unconditional
   * baseline on the holdout by at least {@link ADOPTION_MARGIN}. When false,
   * personalization beyond "this user's overall distribution" is not supported
   * by the data and the trained profile keeps only the unconditional rung.
   */
  conditioningHelps: boolean;
  /** Whether prompt rungs beat the core rungs by at least {@link ADOPTION_MARGIN}. */
  promptTiersHelp: boolean;
  /** Relative pinball reduction of the personal model over the cold start. */
  gainOverColdStart: number;
  /**
   * Relative pinball reduction of the candidate that would actually ship for
   * this slice over the cold start. Unlike {@link gainOverColdStart} this is not
   * a best-of: it scores the configuration the trainer is about to write, so it
   * is the number the serve decision is entitled to use. Negative means the
   * personal model is worse than the profile shipped in the box.
   */
  gainOverColdStartAsShipped: number;
  /** Relative pinball reduction of conditioning over this user's flat baseline. */
  gainOverFlat: number;
  /**
   * Whether the shipped configuration beat a cold start by {@link ADOPTION_MARGIN}.
   * When false the slice is trained but not served; see
   * {@link ../profile.js} `PersonalScaleProfile.adopted`.
   */
  beatsColdStart: boolean;
  /** One sentence explaining {@link beatsColdStart}. */
  beatsColdStartReason: string;
}

/** The full evaluation report. */
export interface PersonalEvaluation {
  generatedAt: string;
  trainFraction: number;
  totalObservations: number;
  /** Observations excluded from evaluation, keyed by reason. */
  excluded: Record<string, number>;
  slices: SliceEvaluation[];
  /**
   * Global recommendation fed to {@link trainPersonalProfile}: adopt prompt
   * rungs only if they helped on a slice with enough holdout to say so.
   */
  adoptPromptTiers: boolean;
  adoptPromptTiersReason: string;
  /**
   * Per-slice training instructions keyed by `scaleKey(provider, scale)`. This
   * is the machine-readable form of the verdicts above.
   */
  decisions: Record<string, { conditioning: boolean; prompt: boolean }>;
  /**
   * Per-slice permission to serve, keyed by `scaleKey(provider, scale)`.
   *
   * Every slice present in the observations appears here, including ones with
   * too little held-out data to score — those are `false`, because "we could not
   * measure it" is a reason to keep the bundled profile, not a reason to ship an
   * unmeasured one.
   */
  serve: Record<string, boolean>;
  /** Why each slice is or is not served. */
  serveReasons: Record<string, string>;
}

/** Options for {@link evaluatePersonalModel}. */
export interface EvaluateOptions {
  /** Fraction of each slice's timeline used for fitting. Default 0.7. */
  trainFraction?: number;
  /** Minimum holdout rows before a slice is scored at all. Default 100. */
  minHoldout?: number;
  minSamples?: number;
  /**
   * Score the slice as if prompt rungs were switched on regardless of the
   * per-slice verdict, matching a caller that forces them for live drafting.
   * The serve gate then judges what will actually ship rather than what the
   * measurement would have chosen on its own.
   */
  promptTiersForced?: boolean;
  now?: Date;
}

/**
 * Score one forecaster against a holdout.
 *
 * Exported so the sufficiency curve measures quality exactly the way the
 * evaluation does, rather than growing a second definition of "better".
 */
export function scoreForecaster(
  name: string,
  holdout: readonly UsageObservation[],
  predict: (o: UsageObservation) => PersonalForecastResult,
): CandidateScore {
  let hit50 = 0;
  let hit90 = 0;
  let hit99 = 0;
  let loss50 = 0;
  let loss90 = 0;
  let loss99 = 0;
  let width = 0;
  const p50s: number[] = [];
  const sources: Record<string, number> = {};

  for (const observation of holdout) {
    const forecast = predict(observation);
    const actual = observation.outputTokens;
    if (actual <= forecast.p50) hit50 += 1;
    if (actual <= forecast.p90) hit90 += 1;
    if (actual <= forecast.p99) hit99 += 1;
    loss50 += pinball(actual, forecast.p50, 0.5);
    loss90 += pinball(actual, forecast.p90, 0.9);
    loss99 += pinball(actual, forecast.p99, 0.99);
    width += forecast.p90 - forecast.p50;
    p50s.push(forecast.p50);
    sources[forecast.source] = (sources[forecast.source] ?? 0) + 1;
  }

  const n = holdout.length;
  p50s.sort((a, b) => a - b);
  const pinballP50 = loss50 / n;
  const pinballP90 = loss90 / n;
  const pinballP99 = loss99 / n;
  return {
    name,
    n,
    coverageP50: hit50 / n,
    coverageP90: hit90 / n,
    coverageP99: hit99 / n,
    pinballP50,
    pinballP90,
    pinballP99,
    pinballMean: (pinballP50 + pinballP90 + pinballP99) / 3,
    meanIntervalWidth: width / n,
    medianP50: p50s[Math.floor(n / 2)] ?? 0,
    sources,
  };
}

/**
 * Fit-and-score every candidate on a chronological holdout, per provider × scale.
 *
 * Candidates:
 *   - `cold_start`      — no personal profile at all (bundled or static).
 *   - `personal_flat`   — this user's unconditional distribution.
 *   - `personal_core`   — conditioned on model and reasoning configuration.
 *   - `personal_prompt` — the above plus prompt-derived rungs.
 */
export function evaluatePersonalModel(
  observations: readonly UsageObservation[],
  options: EvaluateOptions = {},
): PersonalEvaluation {
  const trainFraction = options.trainFraction ?? 0.7;
  const minHoldout = options.minHoldout ?? 100;
  const excluded: Record<string, number> = {};

  const usable: UsageObservation[] = [];
  for (const observation of observations) {
    if (!Number.isFinite(observation.outputTokens) || observation.outputTokens <= 0) {
      excluded["non_positive_output"] = (excluded["non_positive_output"] ?? 0) + 1;
      continue;
    }
    const time = Date.parse(observation.timestamp);
    if (!Number.isFinite(time)) {
      excluded["unparseable_timestamp"] = (excluded["unparseable_timestamp"] ?? 0) + 1;
      continue;
    }
    if (observation.usageSource !== "provider_exact") {
      // Estimates are kept out of scoring so coverage means "against billed
      // tokens", not "against our own estimate of them".
      excluded["not_provider_exact"] = (excluded["not_provider_exact"] ?? 0) + 1;
      continue;
    }
    usable.push(observation);
  }

  const bySlice = new Map<string, UsageObservation[]>();
  for (const observation of usable) {
    const key = scaleKey(observation.provider, observation.scale);
    const list = bySlice.get(key);
    if (list) list.push(observation);
    else bySlice.set(key, [observation]);
  }

  const slices: SliceEvaluation[] = [];
  const serve: Record<string, boolean> = {};
  const serveReasons: Record<string, string> = {};
  for (const [sliceKeyName, rows] of bySlice) {
    rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const splitIndex = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * trainFraction)));
    const train = rows.slice(0, splitIndex);
    const holdout = rows.slice(splitIndex);
    const first = rows[0]!;
    if (holdout.length < minHoldout) {
      excluded["slice_too_small"] = (excluded["slice_too_small"] ?? 0) + holdout.length;
      // Unmeasurable is not the same as good. A slice this thin is exactly where
      // a personal profile loses to the bundled one, so it is recorded as "do
      // not serve" rather than left absent and defaulted into service.
      serve[sliceKeyName] = false;
      serveReasons[sliceKeyName] =
        `only ${holdout.length} held-out observations; at least ${minHoldout} are needed to test this against a cold start, so the bundled profile keeps serving`;
      continue;
    }

    const flat = fitFlat(train, options);
    const core = trainPersonalProfile(train, {
      id: "eval-core",
      withPromptTiers: false,
      promptTiersReason: "evaluation candidate",
      ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const prompt = trainPersonalProfile(train, {
      id: "eval-prompt",
      withPromptTiers: true,
      promptTiersReason: "evaluation candidate",
      ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    const candidates = [
      scoreForecaster("cold_start", holdout, (o) => predictFor(null, o)),
      scoreForecaster("personal_flat", holdout, (o) => predictFor(flat, o)),
      scoreForecaster("personal_core", holdout, (o) => predictFor(core, o)),
      scoreForecaster("personal_prompt", holdout, (o) => predictFor(prompt, o)),
    ];

    const best = candidates.reduce((a, b) => (b.pinballMean < a.pinballMean ? b : a));
    const flatScore = candidates.find((c) => c.name === "personal_flat")!;
    const coreScore = candidates.find((c) => c.name === "personal_core")!;
    const promptScore = candidates.find((c) => c.name === "personal_prompt")!;

    const gainOverFlat =
      flatScore.pinballMean > 0 ? 1 - coreScore.pinballMean / flatScore.pinballMean : 0;
    const coldScore = candidates.find((c) => c.name === "cold_start")!;
    const bestPersonal = Math.min(
      flatScore.pinballMean,
      coreScore.pinballMean,
      promptScore.pinballMean,
    );
    const gainOverColdStart =
      coldScore.pinballMean > 0 ? 1 - bestPersonal / coldScore.pinballMean : 0;
    const conditioningHelps = gainOverFlat >= ADOPTION_MARGIN;
    const promptTiersHelp =
      coreScore.pinballMean > 0 &&
      1 - promptScore.pinballMean / coreScore.pinballMean >= ADOPTION_MARGIN;

    // What the trainer is about to write for this slice, scored as itself. The
    // serve gate must not be allowed to quote a candidate that will not ship.
    const shipsPrompt = options.promptTiersForced === true || (conditioningHelps && promptTiersHelp);
    const shipsConditioning = options.promptTiersForced === true || conditioningHelps;
    const shippedScore = shipsPrompt ? promptScore : shipsConditioning ? coreScore : flatScore;
    const gainOverColdStartAsShipped =
      coldScore.pinballMean > 0 ? 1 - shippedScore.pinballMean / coldScore.pinballMean : 0;
    const beatsColdStart = gainOverColdStartAsShipped >= ADOPTION_MARGIN;
    const beatsColdStartReason = beatsColdStart
      ? `${shippedScore.name} cut held-out pinball loss ${(gainOverColdStartAsShipped * 100).toFixed(1)}% below a cold start over ${holdout.length.toLocaleString()} observations`
      : `${shippedScore.name} did not beat a cold start by ${(ADOPTION_MARGIN * 100).toFixed(0)}% on ${holdout.length.toLocaleString()} held-out observations (${(gainOverColdStartAsShipped * 100).toFixed(1)}%), so the bundled profile keeps serving`;
    serve[sliceKeyName] = beatsColdStart;
    serveReasons[sliceKeyName] = beatsColdStartReason;

    slices.push({
      provider: first.provider,
      scale: first.scale,
      trainN: train.length,
      holdoutN: holdout.length,
      trainSpan: [train[0]!.timestamp, train[train.length - 1]!.timestamp],
      holdoutSpan: [holdout[0]!.timestamp, holdout[holdout.length - 1]!.timestamp],
      candidates,
      best: best.name,
      conditioningHelps,
      promptTiersHelp,
      gainOverColdStart,
      gainOverColdStartAsShipped,
      gainOverFlat,
      beatsColdStart,
      beatsColdStartReason,
    });
  }

  const helped = slices.filter((s) => s.promptTiersHelp);
  const adoptPromptTiers = helped.length > 0 && helped.length >= slices.length / 2;
  const decisions: Record<string, { conditioning: boolean; prompt: boolean }> = {};
  for (const slice of slices) {
    decisions[scaleKey(slice.provider, slice.scale)] = {
      conditioning: slice.conditioningHelps,
      prompt: slice.conditioningHelps && slice.promptTiersHelp,
    };
  }
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    trainFraction,
    totalObservations: observations.length,
    excluded,
    slices,
    adoptPromptTiers,
    adoptPromptTiersReason: adoptPromptTiers
      ? `prompt rungs lowered held-out pinball loss on ${helped.length}/${slices.length} slices`
      : slices.length === 0
        ? "no slice had enough held-out data to test prompt rungs"
        : `prompt rungs did not lower held-out pinball loss by ${(ADOPTION_MARGIN * 100).toFixed(0)}% on a majority of slices (${helped.length}/${slices.length})`,
    decisions,
    serve,
    serveReasons,
  };
}

/**
 * A profile with the conditioned rungs stripped: this user's unconditional
 * distribution. The honest baseline that personalization must beat before we
 * claim conditioning helps.
 */
function fitFlat(train: readonly UsageObservation[], options: EvaluateOptions): PersonalProfile {
  const profile = trainPersonalProfile(train, {
    id: "eval-flat",
    withPromptTiers: false,
    promptTiersReason: "unconditional baseline",
    ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  for (const slice of Object.values(profile.scales)) {
    const overall = slice.groups["overall"];
    slice.groups = overall ? { overall } : {};
  }
  return profile;
}

function predictFor(
  profile: PersonalProfile | null,
  observation: UsageObservation,
): PersonalForecastResult {
  return personalForecast(profile, {
    provider: observation.provider,
    scale: observation.scale,
    model: observation.model,
    reasoning: observation.reasoning,
    promptFeatures: observation.promptFeatures,
  });
}

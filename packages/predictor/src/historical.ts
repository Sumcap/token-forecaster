import type {
  ForecastObservation,
  OutputForecast,
} from "@token-forecaster/core";
import { staticBaselineForecast } from "./static.js";
import {
  applyQuantileBoost,
  hasCompleteAgentLoopContext,
  portableQuantileBoostFeatures,
} from "./boosted.js";
import type {
  BoostedForecastContext,
  QuantileBoostProfile,
} from "./boosted.js";

export const HISTORICAL_PREDICTOR_VERSION = "baseline-3-boosted/0.3.0";

/**
 * Dimensions a group may be conditioned on. Deliberately short:
 *
 * - `tools` was removed. It means "were tools available", which is a constant
 *   for any agent that always attaches its toolset, and a constant dimension
 *   splits groups without adding signal. It also conflated an omitted
 *   `toolCount` with "no tools". The thing that actually predicts output length
 *   is whether the turn *calls* a tool, which is not knowable before the call.
 * - `input` was removed. Conditioning on an input-size bucket was tested four
 *   independent ways and made p99 worse every time: more buckets means fewer
 *   samples per bucket, and the tail estimate is what goes noisy first.
 *
 * `prevOutput` remains as an optional custom-profile dimension for API
 * compatibility, but the current bundled profile omits it: its apparent
 * 5-fold gain did not clear the later session-block bootstrap gate. Previous
 * action, loop depth, previous stop_reason, tool-result size and tool duration
 * were also measured at zero. `promptPath` is the currently adopted addition.
 *
 * See docs/STATE-OF-PLAY.md for the measurements behind both removals.
 */
export type HistoricalDimension =
  | "model"
  | "thinking"
  | "effort"
  | "task"
  | "promptPath"
  | "promptImage"
  | "prevOutput";

export interface HistoricalQuantiles {
  sampleSize: number;
  p50: number;
  p90: number;
  p99: number;
}

/**
 * Where a profile's numbers come from. Open-ended on purpose: the union grows
 * when a corpus stops being one person's.
 */
export type ProfileProvenance = "single-user-corpus" | "multi-user-corpus";

export interface HistoricalForecastProfile {
  id: string;
  generatedAt: string;
  /** Human-readable description of the workload represented by this profile. */
  scope: string;
  /**
   * Who the corpus came from, so a headless consumer can render the honest
   * caveat without hardcoding a profile id.
   *
   * `"single-user-corpus"` means every quantile, every conditioned rung and
   * every trained tree in this profile was fitted on one person's history: it
   * is a population prior for that kind of work, not a calibration of the
   * caller. Omitting the field means "not recorded", NOT "multi-user" — an
   * older profile predates the field, so treat `undefined` as unknown and say
   * so rather than claiming a provenance it never declared.
   */
  provenance?: ProfileProvenance;
  eligibleObservations: number;
  /**
   * Recency window the profile was fitted on, in days, or null when it was
   * fitted on the full history. Recorded so a consumer can tell how stale the
   * numbers may be.
   */
  windowDays?: number | null;
  /** Group keys are produced by historicalGroupKey(). */
  groups: Record<string, HistoricalQuantiles>;
  /**
   * Map request model aliases/snapshots onto the identifiers used by the
   * profile, so a caller holding a dated snapshot id still selects the right
   * group instead of silently dropping to `overall`. Generated from
   * @token-forecaster/model-registry by the eval script.
   */
  modelAliases?: Record<string, string>;
  /** Optional portable residual correction trained over the historical ladder. */
  boostedCorrection?: QuantileBoostProfile;
  /**
   * Whole-turn output totals (Σ output tokens over one human turn's agent
   * loop, subagents included), fitted per turn rather than per call, keyed on
   * what is knowable when the human message arrives. Keys: `overall`,
   * `thinking=yes|no`, and — since the 12 August 2026 regeneration — the
   * pooled turn-opener rungs `thinking=…|promptPath=…` and
   * `thinking=…|promptImage=…` (both prompt bits cleared the paired
   * session-block gate in probe-turn-totals.mjs; model conditioning graded
   * worse than pooling and is deliberately absent). Missing rungs are
   * skipped, so an older profile keeps its old behavior.
   */
  turnTotals?: Record<string, HistoricalQuantiles>;
  /**
   * Portable residual correction for the TURN TOTAL, trained on turn-opener
   * state only (the agent loop has not started, so every parent-chain feature
   * is zero and the trees split on prompt aggregates, model/thinking and
   * session position). This is what makes the turn forecast respond to the
   * draft a user is typing; the per-call correction cannot (regime collapse at
   * turn roots — docs/BACKLOG.md, 11 August 2026).
   */
  turnTotalBoost?: QuantileBoostProfile;
  /**
   * Whole-session output totals (Σ output tokens over every turn of one
   * session), fitted per session. The only key is `overall`: at ~300 sessions
   * no conditional forecast — per-turn-count buckets, spent-so-far buckets,
   * turns×median — separated from the unconditional session distribution at
   * 95% with endpoint stability (STATE-OF-PLAY §6.26), so the unconditional
   * quantiles are the whole ship. One measured warning for consumers:
   * "total quantile minus spent-so-far" graded WORSE mid-session than simply
   * re-reading these quantiles — remaining output is roughly memoryless, so
   * do not subtract.
   */
  sessionTotals?: Record<string, HistoricalQuantiles>;
}

export interface BuildHistoricalProfileOptions {
  id: string;
  scope: string;
  /** Exclude older observations. Useful for preventing stale calibration. */
  windowDays?: number;
  now?: Date;
}

export interface HistoricalForecastRequest {
  /** Canonical or dated model id. Dated ids are resolved via profile.modelAliases. */
  model: string;
  /** Forecast quantiles are clamped to this. */
  maxTokens: number;
  /**
   * Whether extended thinking is enabled on the request.
   *
   * Omitting this means "unknown", NOT "disabled" — see requestDimensionValues.
   */
  thinkingEnabled?: boolean;
  /**
   * Output tokens produced by the previous call in this agent loop, if any.
   *
   * Like `thinkingEnabled`, omitting this means "unknown", NOT "the previous
   * call was short" — the first call of a turn has no predecessor and must fall
   * through to a broader group rather than be filed under the smallest bucket.
   */
  previousOutputTokens?: number;
  /** Not yet present in any shipped profile; reserved for Phase 3 telemetry. */
  outputEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Not yet present in any shipped profile; reserved for Phase 3 telemetry. */
  taskType?: string;
  /**
   * Whether the human turn-root prompt names a file or repository path.
   * Omitted means the prompt was unavailable, not that it mentioned no path.
   */
  promptMentionsPath?: boolean;
  /**
   * Whether the human turn-root message carries an image attachment. Image
   * turns run measurably shorter in the local corpus (screenshot-verification
   * turns get short confirmations). Omitted means the turn root was
   * unavailable, not that no image was attached. The dimension ships only when
   * the eval's adoption gate clears; missing groups are skipped as usual.
   */
  promptHasImage?: boolean;
  /**
   * Privacy-safe prompt aggregates and exact parent-chain state. When absent or
   * incomplete, the trained correction is skipped and confidence is lowered;
   * unknown is never converted to a false/zero observation.
   */
  boostedContext?: BoostedForecastContext;
}

export interface HistoricalForecastOptions {
  /** Minimum observations required before a group may be selected. */
  minSamples?: number;
}

export interface HistoricalCalibrationDetails {
  profileId: string;
  profileScope: string;
  /**
   * The group the forecast came from, or null when even `overall` was too
   * small and the static baseline was used.
   */
  groupKey: string | null;
  sampleSize: number;
  /**
   * True when the forecast did NOT come from a group conditioned on this
   * request — i.e. the profile has no sufficiently populated group for this
   * model, so the numbers describe a blend of other models (`groupKey ===
   * "overall"`) or the static baseline (`groupKey === null`).
   *
   * This is the caller's only signal that the forecast is not about their
   * model. Surface it; do not treat a fallback forecast as calibrated.
   */
  usedFallback: boolean;
  /** Whether the portable quantile correction ran on complete pre-call state. */
  boostedCorrectionApplied: boolean;
  boostedCorrectionReason:
    | "applied"
    | "profile_untrained"
    | "incomplete_context"
    | "unknown_thinking"
    | "fallback_group";
}

export interface HistoricalForecastResult {
  forecast: OutputForecast;
  calibration: HistoricalCalibrationDetails;
}

type DimensionValues = Partial<Record<HistoricalDimension, string>>;

/**
 * Backoff ladder, most specific first. A forecast walks this list and takes the
 * first group that clears the minimum sample size, so ordering encodes which
 * dimensions we believe carry the most signal.
 */
/**
 * Upper bounds (exclusive) of the previous-output buckets, in tokens.
 *
 * These are the boundaries the effect was measured at, not round numbers picked
 * by eye. Holding day and model fixed, `800-3k` runs 1.35x the `200-800` median
 * and `>=3k` runs 1.33x, both replicating in direction across cells. `<200` came
 * back at 0.97x — indistinguishable from `200-800`, so a *short* previous reply
 * says nothing and only a *long* one does. The two are kept separate anyway
 * because the eval re-tests the merge on every regeneration and merging them
 * cannot be undone from a shipped profile.
 */
export const PREVIOUS_OUTPUT_BUCKET_EDGES = [200, 800, 3_000] as const;

/**
 * Bucket a previous-call output length. Exported so the profile builder and the
 * forecaster cannot drift apart, and so a caller can see which bucket it is in.
 */
export function previousOutputBucket(outputTokens: number): string {
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new Error(
      `previousOutputTokens must be a non-negative finite number, got ${outputTokens}`,
    );
  }
  const [small, medium, large] = PREVIOUS_OUTPUT_BUCKET_EDGES;
  if (outputTokens < small) return `lt${small}`;
  if (outputTokens < medium) return `${small}-${medium}`;
  if (outputTokens < large) return `${medium}-${large}`;
  return `gte${large}`;
}

// Keep this expression in sync with PATH_PATTERN in
// experiments/evaluation/lib/load-history.mjs. It is intentionally a small,
// measured lexical feature rather than a general path parser.
const PROMPT_PATH_PATTERN =
  /(\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|c|h|hpp|cpp|sh|zsh|yml|yaml|toml|css|scss|html|sql|txt|lock)\b|\b(src|lib|packages|apps|docs|experiments|fixtures|research|tests?|scripts?)\/)/;

/** Derive the privacy-safe prompt-path bit used by the historical ladder. */
export function promptMentionsPath(prompt: string): boolean {
  return PROMPT_PATH_PATTERN.test(prompt);
}

export const HISTORICAL_GROUP_TIERS: readonly (readonly HistoricalDimension[])[] = [
  ["model", "thinking", "effort", "task"],
  ["model", "thinking", "effort"],
  ["model", "thinking", "task"],
  // Naming a file/path in the human turn-root prompt is the only prompt feature
  // to clear the held-out adoption gate after skill-injection ancestry was
  // reconstructed correctly. The bundled deployment profile contains these
  // groups only when the evaluator's current bootstrap CI clears zero.
  ["model", "thinking", "promptPath"],
  // Whether the turn-root message carries an image. Measured 10 August 2026
  // (probe-missing-signals.mjs): negative at all five corpus endpoints tested
  // (-1.4 to -5.8 pinball/call), adoption-gate-clear at two of them, within-
  // (day, model) median ratio 0.89x. Ships only when the eval gate clears on
  // the current regeneration, exactly like promptPath.
  ["model", "thinking", "promptImage"],
  // Previous-output bucketing remains available to custom profiles, but the
  // current bundled profile does not contain these groups because the candidate
  // failed its held-out adoption gate. Missing groups are simply skipped. When
  // present, this rung falls back to model+thinking whenever the previous call
  // is unknown or its bucket is too thin.
  ["model", "thinking", "prevOutput"],
  // Extended-thinking tokens are billed as output tokens, so the flag moves
  // observed output length by ~2.9x at the median and ~3.3x at p99. It is by
  // far the strongest pre-call signal found, which is why it sits directly
  // above the model-only rung.
  ["model", "thinking"],
  ["model"],
  // Pooled rungs below this line serve callers whose model the profile has
  // never seen (usedFallback: true). Order measured 9 August 2026 on
  // leave-one-model-out calls (experiments/evaluation/probe-cold-start.mjs):
  // the pooled thinking rung beats the pooled promptPath rung by ~55
  // pinball/call there, and a joint thinking|promptPath rung adds nothing, so
  // thinking-family rungs outrank the path bit. For a caller whose model IS in
  // the profile this changes nothing: every model-conditioned rung sits above.
  // (Runtime nuance: a thinking-unknown caller that passes promptMentionsPath
  // now reaches its own model rung before the pooled path bit — its forecast
  // is about its model rather than a cross-model blend, and it is no longer
  // flagged as a fallback.)
  ["thinking", "effort", "task"],
  ["thinking", "effort"],
  ["thinking", "task"],
  ["thinking"],
  ["promptPath"],
  ["promptImage"],
] as const;

export const OVERALL_HISTORICAL_GROUP = "overall";

export function historicalGroupKey(
  dimensions: readonly HistoricalDimension[],
  values: DimensionValues,
): string | null {
  const parts: string[] = [];
  for (const dimension of dimensions) {
    const value = values[dimension];
    if (value === undefined) return null;
    parts.push(`${dimension}=${encodeURIComponent(value)}`);
  }
  return parts.join("|");
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) {
    throw new Error("Cannot compute a quantile without observations");
  }
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("Quantile index fell outside the observation set");
  }
  return Math.round(lower + (upper - lower) * (index - lowerIndex));
}

function summarize(values: readonly number[]): HistoricalQuantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    sampleSize: sorted.length,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
  };
}

function observationDimensionValues(
  observation: ForecastObservation,
): DimensionValues {
  return {
    model: observation.modelSnapshot ?? observation.model,
    thinking: isThinkingEnabled(observation.request.thinkingConfiguration)
      ? "yes"
      : "no",
    // Absent means the call had no recoverable predecessor, so the dimension is
    // left undefined and every prevOutput rung is skipped for it. Filing it
    // under the smallest bucket instead would seed that bucket with
    // turn-opening calls, which are the longest ones in the corpus.
    // `== null` on purpose: null is what a JSON or database round-trip produces
    // for an absent value, and absent must mean absent on every path.
    ...(observation.request.previousOutputTokens == null
      ? {}
      : {
          prevOutput: previousOutputBucket(
            observation.request.previousOutputTokens,
          ),
        }),
    ...(observation.request.outputEffort
      ? { effort: observation.request.outputEffort }
      : {}),
    ...(observation.request.taskType
      ? { task: observation.request.taskType }
      : {}),
    ...(observation.request.promptMentionsPath == null
      ? {}
      : {
          promptPath: observation.request.promptMentionsPath ? "yes" : "no",
        }),
    ...(observation.request.promptHasImage == null
      ? {}
      : {
          promptImage: observation.request.promptHasImage ? "yes" : "no",
        }),
  };
}

export interface TurnTotalForecast {
  /** Quantiles of TOTAL output tokens for the whole turn, not one call. */
  p50: number;
  p90: number;
  p99: number;
  /** Number of turns the selected group was fitted on. */
  sampleSize: number;
  /** `overall`, `thinking=yes|no`, or a turn-opener rung key. */
  groupKey: string;
  /**
   * True when the caller declared thinking but the conditioned group was
   * unavailable and the blended overall turn distribution answered instead.
   */
  usedFallback: boolean;
  /**
   * True when the turn-total correction ran on the caller's prompt aggregates.
   * Only then does the number respond to the draft's wording; a caller that
   * shows a live "as you type" estimate should surface this bit the same way
   * per-call consumers surface boostedCorrectionApplied.
   */
  promptCorrectionApplied: boolean;
}

/**
 * The subset of the forecast request a turn total can condition on. Everything
 * beyond thinkingEnabled is optional and only deepens the rung/correction when
 * present, so existing thinking-only callers keep their exact behavior.
 */
export type TurnTotalForecastRequest = Pick<
  HistoricalForecastRequest,
  | "thinkingEnabled"
  | "promptMentionsPath"
  | "promptHasImage"
  | "boostedContext"
> & { model?: string };

/**
 * Forecast the whole turn's output-token total from what is known when the
 * human message arrives. Returns null when the profile carries no turn
 * distribution — callers must treat that as "no forecast", never as zero.
 *
 * The per-call forecast and this one answer different questions: a call
 * forecast budgets the next API response; this budgets the agent loop the
 * message is about to start (median ~14 calls in the local corpus). It is also
 * the number that scales with typed intent: an artifact-plus-review prompt
 * does not lengthen the FIRST call, it lengthens the loop, so prompt
 * conditioning lives here (turn-opener rungs + turnTotalBoost) rather than in
 * the per-call correction.
 */
export function historicalTurnTotalForecast(
  request: TurnTotalForecastRequest,
  profile: HistoricalForecastProfile,
  options: HistoricalForecastOptions = {},
): TurnTotalForecast | null {
  const groups = profile.turnTotals;
  if (groups === undefined) return null;
  const minSamples = options.minSamples ?? 60;
  const wantsThinking = request.thinkingEnabled != null;
  const thinking = request.thinkingEnabled ? "yes" : "no";
  const model =
    request.model === undefined
      ? undefined
      : (profile.modelAliases?.[request.model] ?? request.model);

  // Turn-opener ladder, most specific first. Rungs pool across models on
  // purpose: model-conditioned turn groups graded WORSE than the pooled
  // thinking rung (probe-turn-totals.mjs mean -672/turn for thinking-only,
  // and the model ladder lost ~+500/turn in eval-winning-boost), so the
  // prompt bits condition the pooled distribution instead. promptPath
  // outranks promptImage because it is the stronger lever on this corpus
  // (path turns run ~2x the pooled median). Every rung requires the thinking
  // flag: an unknown flag must not be filed as "no" (the two distributions
  // differ ~3x, same as per call).
  const candidateKeys: string[] = [];
  if (wantsThinking) {
    if (request.promptMentionsPath != null) {
      candidateKeys.push(
        `thinking=${thinking}|promptPath=${request.promptMentionsPath ? "yes" : "no"}`,
      );
    }
    if (request.promptHasImage != null) {
      candidateKeys.push(
        `thinking=${thinking}|promptImage=${request.promptHasImage ? "yes" : "no"}`,
      );
    }
    candidateKeys.push(`thinking=${thinking}`);
  }

  let selected: { key: string; group: HistoricalQuantiles } | null = null;
  for (const key of candidateKeys) {
    const group = groups[key];
    if (group !== undefined && group.sampleSize >= minSamples) {
      selected = { key, group };
      break;
    }
  }
  let usedFallback = false;
  if (selected === null) {
    const overall = groups[OVERALL_HISTORICAL_GROUP];
    if (overall === undefined || overall.sampleSize < minSamples) return null;
    selected = { key: OVERALL_HISTORICAL_GROUP, group: overall };
    usedFallback = wantsThinking;
  }

  let quantiles: [number, number, number] = [
    selected.group.p50,
    selected.group.p90,
    selected.group.p99,
  ];
  // The turn-total correction needs the same completeness contract as the
  // per-call one: known thinking, known model, and prompt aggregates. The
  // agent-loop state is not required from the caller — at a turn start it is
  // definitionally empty, except sessionPosition which is used when supplied.
  const prompt = request.boostedContext?.prompt;
  let promptCorrectionApplied = false;
  if (
    profile.turnTotalBoost !== undefined &&
    wantsThinking &&
    model !== undefined &&
    prompt !== undefined
  ) {
    const sessionPosition =
      request.boostedContext?.agentLoop?.sessionPosition ?? 0;
    const features = portableQuantileBoostFeatures({
      model,
      thinkingEnabled: request.thinkingEnabled === true,
      ...(request.promptMentionsPath === undefined
        ? {}
        : { promptMentionsPath: request.promptMentionsPath }),
      ...(request.promptHasImage === undefined
        ? {}
        : { promptHasImage: request.promptHasImage }),
      boostedContext: {
        prompt,
        agentLoop: {
          sessionPosition:
            Number.isInteger(sessionPosition) && sessionPosition >= 0
              ? sessionPosition
              : 0,
          loopDepth: 0,
          priorCallCount: 0,
        },
      },
    });
    quantiles = applyQuantileBoost(profile.turnTotalBoost, quantiles, features);
    promptCorrectionApplied = true;
  }

  return {
    p50: quantiles[0],
    p90: quantiles[1],
    p99: quantiles[2],
    sampleSize: selected.group.sampleSize,
    groupKey: selected.key,
    usedFallback,
    promptCorrectionApplied,
  };
}

export interface SessionTotalForecast {
  /** Quantiles of TOTAL output tokens for a whole session, not one call/turn. */
  p50: number;
  p90: number;
  p99: number;
  /** Number of sessions the group was fitted on. */
  sampleSize: number;
  /** Always `overall` today; the field exists so adoption needs no API break. */
  groupKey: string;
}

/**
 * Forecast a whole session's output-token total. Returns null when the
 * profile carries no session distribution — callers must treat that as "no
 * forecast", never as zero.
 *
 * There is deliberately no request argument: no conditioning candidate
 * (turns so far, tokens spent so far) beat these unconditional quantiles
 * (STATE-OF-PLAY §6.26). Mid-session, re-read the same quantiles rather than
 * subtracting what was already spent — subtracting graded worse.
 */
export function historicalSessionTotalForecast(
  profile: HistoricalForecastProfile,
  options: HistoricalForecastOptions = {},
): SessionTotalForecast | null {
  const groups = profile.sessionTotals;
  if (groups === undefined) return null;
  const minSamples = options.minSamples ?? 60;
  const overall = groups[OVERALL_HISTORICAL_GROUP];
  if (overall === undefined || overall.sampleSize < minSamples) return null;
  return { ...pickQuantiles(overall), groupKey: OVERALL_HISTORICAL_GROUP };
}

function pickQuantiles(group: HistoricalQuantiles) {
  return {
    p50: group.p50,
    p90: group.p90,
    p99: group.p99,
    sampleSize: group.sampleSize,
  };
}

function isThinkingEnabled(configuration: unknown): boolean {
  if (configuration === undefined || configuration === null) return false;
  if (
    typeof configuration === "object" &&
    "type" in configuration &&
    configuration.type === "disabled"
  ) {
    return false;
  }
  return true;
}

function requestDimensionValues(
  request: HistoricalForecastRequest,
  profile: HistoricalForecastProfile,
): DimensionValues {
  const model = profile.modelAliases?.[request.model] ?? request.model;
  return {
    model,
    // An omitted thinkingEnabled means "caller did not say", not "disabled".
    // Conflating the two is unsafe in one direction: the no-thinking groups
    // have roughly a third of the p99 of the thinking groups, so defaulting an
    // unknown request to "no" would silently under-forecast a thinking request
    // by ~3x at the tail. Leaving the dimension undefined instead makes
    // historicalGroupKey() skip every thinking tier and fall back to a broader
    // group, which is the conservative direction.
    //
    // `== null`, not `=== undefined`: a caller round-tripping a request through
    // JSON or a database sends `null` for "not set", and treating that as
    // `false` would file it under thinking=no — the exact ~3x tail
    // under-forecast this rung exists to prevent.
    ...(request.thinkingEnabled == null
      ? {}
      : { thinking: request.thinkingEnabled ? "yes" : "no" }),
    // Same discipline as thinking, and it matters for the same reason: a caller
    // that cannot see its previous call must skip the rung, not claim the
    // previous reply was short. "Short" is a measured statement about the loop;
    // "unknown" is the absence of one.
    ...(request.previousOutputTokens == null
      ? {}
      : { prevOutput: previousOutputBucket(request.previousOutputTokens) }),
    ...(request.outputEffort ? { effort: request.outputEffort } : {}),
    ...(request.taskType ? { task: request.taskType } : {}),
    ...(request.promptMentionsPath == null
      ? {}
      : { promptPath: request.promptMentionsPath ? "yes" : "no" }),
    ...(request.promptHasImage == null
      ? {}
      : { promptImage: request.promptHasImage ? "yes" : "no" }),
  };
}

/**
 * Build a privacy-safe aggregate profile from normalized observations.
 *
 * Censored responses are intentionally excluded from ordinary quantiles: their
 * observed output is only a lower bound on natural response length. They remain
 * available to the future cap-risk/survival model through the source telemetry.
 */
export function buildHistoricalProfile(
  observations: readonly ForecastObservation[],
  options: BuildHistoricalProfileOptions,
): HistoricalForecastProfile {
  if (
    options.windowDays !== undefined &&
    (!Number.isFinite(options.windowDays) || options.windowDays <= 0)
  ) {
    throw new Error(
      `windowDays must be positive when provided, got ${options.windowDays}`,
    );
  }
  const now = options.now ?? new Date();
  const cutoff =
    options.windowDays === undefined
      ? null
      : now.getTime() - options.windowDays * 24 * 60 * 60 * 1_000;

  const eligible = observations.filter((observation) => {
    if (observation.actual === undefined || observation.actual.isCensored) {
      return false;
    }
    if (cutoff === null) return true;
    const timestamp = Date.parse(observation.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });

  const grouped = new Map<string, number[]>();
  const add = (key: string, outputTokens: number): void => {
    const values = grouped.get(key) ?? [];
    values.push(outputTokens);
    grouped.set(key, values);
  };

  for (const observation of eligible) {
    const outputTokens = observation.actual?.outputTokens;
    if (outputTokens === undefined) continue;
    add(OVERALL_HISTORICAL_GROUP, outputTokens);
    const values = observationDimensionValues(observation);
    for (const tier of HISTORICAL_GROUP_TIERS) {
      const key = historicalGroupKey(tier, values);
      if (key !== null) add(key, outputTokens);
    }
  }

  return {
    id: options.id,
    generatedAt: now.toISOString(),
    scope: options.scope,
    eligibleObservations: eligible.length,
    groups: Object.fromEntries(
      [...grouped.entries()].map(([key, values]) => [key, summarize(values)]),
    ),
  };
}

function selectHistoricalGroup(
  request: HistoricalForecastRequest,
  profile: HistoricalForecastProfile,
  minSamples: number,
): { key: string; quantiles: HistoricalQuantiles } | null {
  const values = requestDimensionValues(request, profile);
  for (const tier of HISTORICAL_GROUP_TIERS) {
    const key = historicalGroupKey(tier, values);
    if (key === null) continue;
    const quantiles = profile.groups[key];
    if (quantiles !== undefined && quantiles.sampleSize >= minSamples) {
      return { key, quantiles };
    }
  }

  const overall = profile.groups[OVERALL_HISTORICAL_GROUP];
  return overall !== undefined && overall.sampleSize >= minSamples
    ? { key: OVERALL_HISTORICAL_GROUP, quantiles: overall }
    : null;
}

function assertHistoricalRequest(request: HistoricalForecastRequest): void {
  if (!request.model) throw new Error("model must not be empty");
  if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
    throw new Error(
      `maxTokens must be a positive integer, got ${request.maxTokens}`,
    );
  }
}

/**
 * Forecast from the narrowest sufficiently populated historical group.
 *
 * Contract when the profile has no group for the request's model — the Sonnet 5
 * case today, and any model the profile was not fitted on:
 *
 *   1. Every model-conditioned rung is skipped, because none of its keys exist.
 *   2. If thinking is known, the pooled thinking rung is used when populated
 *      (shipped since 9 August 2026; leave-one-model-out it beats the blended
 *      `overall` by ~43 pinball/call). Otherwise the pooled prompt-path rung
 *      if that bit is known and its groups ship, otherwise `overall`. All of
 *      these are blends of the models the profile *was* fitted on — workload-
 *      shaped priors, not forecasts about the requested model.
 *   3. If no historical fallback is populated, the static baseline is returned.
 *
 * Steps 2 and 3 both set `calibration.usedFallback = true`, and step 3 also
 * sets `calibration.groupKey = null` and `forecast.source = "default"`.
 * Confidence is never above "low" on a fallback. A caller that wants to refuse
 * uncalibrated numbers should branch on `usedFallback`; there is no silent
 * degradation path.
 *
 * This predictor intentionally omits probabilityOfOutputCap. Quantiles can be
 * learned from uncensored outputs, but cap probability needs cap-aware
 * observations or a survival model; inventing it from three quantiles would be
 * misleading.
 */
export function historicalBaselineForecast(
  request: HistoricalForecastRequest,
  profile: HistoricalForecastProfile,
  options: HistoricalForecastOptions = {},
): HistoricalForecastResult {
  assertHistoricalRequest(request);
  const minSamples = options.minSamples ?? 100;
  if (!Number.isInteger(minSamples) || minSamples <= 0) {
    throw new Error(`minSamples must be a positive integer, got ${minSamples}`);
  }

  const selected = selectHistoricalGroup(request, profile, minSamples);
  if (selected === null) {
    return {
      forecast: staticBaselineForecast(request.maxTokens),
      calibration: {
        profileId: profile.id,
        profileScope: profile.scope,
        groupKey: null,
        sampleSize: 0,
        usedFallback: true,
        boostedCorrectionApplied: false,
        boostedCorrectionReason: "fallback_group",
      },
    };
  }

  const { quantiles, key } = selected;
  // A pooled feature-only group is still a blend of models. It is useful as a
  // sparse-cell backoff, but must carry the same low-confidence fallback flag
  // as `overall` whenever the selected key is not model-conditioned.
  const usedFallback =
    key === OVERALL_HISTORICAL_GROUP || !key.startsWith("model=");
  let corrected: [number, number, number] = [
    quantiles.p50,
    quantiles.p90,
    quantiles.p99,
  ];
  let boostedCorrectionReason: HistoricalCalibrationDetails["boostedCorrectionReason"];
  if (usedFallback) {
    boostedCorrectionReason = "fallback_group";
  } else if (profile.boostedCorrection === undefined) {
    boostedCorrectionReason = "profile_untrained";
  } else if (request.thinkingEnabled == null) {
    boostedCorrectionReason = "unknown_thinking";
  } else if (!hasCompleteAgentLoopContext(request.boostedContext?.agentLoop)) {
    boostedCorrectionReason = "incomplete_context";
  } else {
    const model = profile.modelAliases?.[request.model] ?? request.model;
    const features = portableQuantileBoostFeatures({
      model,
      thinkingEnabled: request.thinkingEnabled,
      ...(request.promptMentionsPath === undefined
        ? {}
        : { promptMentionsPath: request.promptMentionsPath }),
      ...(request.promptHasImage === undefined
        ? {}
        : { promptHasImage: request.promptHasImage }),
      boostedContext: request.boostedContext,
    });
    corrected = applyQuantileBoost(profile.boostedCorrection, corrected, features);
    boostedCorrectionReason = "applied";
  }
  const boostedCorrectionApplied = boostedCorrectionReason === "applied";
  const confidence =
    !usedFallback && boostedCorrectionApplied && quantiles.sampleSize >= 500
      ? "medium"
      : "low";
  const forecast: OutputForecast = {
    p50: Math.min(corrected[0], request.maxTokens),
    p90: Math.min(corrected[1], request.maxTokens),
    p99: Math.min(corrected[2], request.maxTokens),
    confidence,
    source: boostedCorrectionApplied ? "trained" : "historical",
    predictorVersion: `${HISTORICAL_PREDICTOR_VERSION}/${profile.id}`,
  };

  return {
    forecast,
    calibration: {
      profileId: profile.id,
      profileScope: profile.scope,
      groupKey: key,
      sampleSize: quantiles.sampleSize,
      usedFallback,
      boostedCorrectionApplied,
      boostedCorrectionReason,
    },
  };
}

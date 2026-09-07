/**
 * The whole forecast pipeline, with no DOM and no chrome API in sight.
 *
 * It returns a fully decided view model: geometry, strings, and aria labels.
 * The chip renders it and nothing else, so every product decision in here is
 * unit testable.
 */
import {
  calculateContextBudget,
  type ContextBudgetResult,
  type CountQuality,
  type WarningLevel,
} from "@token-forecaster/core";
import { projectCostUsd, requireModel } from "@token-forecaster/model-registry";
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  historicalBaselineForecast,
  historicalTurnTotalForecast,
  promptForecastFeatures,
  promptMentionsPath,
  type BoostedForecastContext,
} from "@token-forecaster/predictor";
import {
  formatCompact,
  formatExact,
  formatUsd,
  QUALITY_LABELS,
  QUALITY_SHORT,
  STRINGS,
} from "./format.js";
import type { ResolvedModel } from "./model-map.js";
import type { Surface } from "./surface.js";
import {
  liveVerdict,
  scoringScale,
  summarizeLedger,
  type ForecastSnapshot,
  type Quantiles,
  type Tone,
  type TurnRecord,
} from "./turn.js";
import type { ResolvedThinking } from "./thinking.js";

export type VerifyState = "off" | "waiting" | "verifying" | "done";

export interface EngineInput {
  /** Raw composer text. Drives the prompt features, not just the count. */
  draft: string;
  /** Displayed count from the reconciler: local estimate or verified. */
  inputTokens: number;
  inputQuality: CountQuality;
  verifyState: VerifyState;
  verifyError: string | null;
  model: ResolvedModel;
  thinking: ResolvedThinking;
  surface: Surface;
  /** Assistant replies already in this conversation. Zero-based position. */
  sessionPosition: number;
  /** Whether the composer carries an attachment that reads as an image. */
  hasImage: boolean;
  /**
   * Tokens of the visible transcript, or null when the gauge is off or the
   * panel is collapsed. Null means "not measured", never "empty".
   */
  transcriptTokens: number | null;
  /**
   * The turn writing right now, or null between turns. The snapshot is the
   * forecast as it stood when send was pressed and is never recomputed here:
   * a prediction that follows the outcome cannot be checked against it.
   */
  live?: { snapshot: ForecastSnapshot; outTokens: number } | null;
  /** Turns already settled in this conversation, oldest first. */
  ledger?: readonly TurnRecord[];
}

export interface BandSegment {
  /** Percent of the track width. */
  widthPercent: number;
  opacity: number;
}

export interface BandTick {
  /** Percent from the left, or ignored when `anchor` is "end". */
  percent: number;
  label: string;
  anchor: "center" | "end";
}

export interface ForecastBand {
  segments: BandSegment[];
  ticks: BandTick[];
  /** Token value the full track width stands for. */
  domain: number;
  /** What the full track width means. */
  domainKind: "p99" | "p90" | "cap";
  ariaLabel: string;
  title: string;
}

export interface ContextMeter {
  measuredPercent: number;
  reservedPercent: number;
  level: WarningLevel;
  caption: string;
  note: string;
  /** True while the measured figure is a floor rather than a measurement. */
  lowerBound: boolean;
  over: boolean;
  ariaValueNow: number;
  ariaValueMax: number;
  ariaValueText: string;
}

/**
 * The running turn, drawn on the very band the panel already teaches: same
 * square-root track, same ticks, plus one marker for what has been written so
 * far. The band is rebuilt from the frozen quantiles on every render, so it is
 * the same picture every time even though nothing is cached.
 */
export interface LiveView {
  band: ForecastBand;
  /** Where the written estimate sits on the track, 0 to 100. */
  markerPercent: number;
  /** The two quantile boundaries, for the pill's 44px copy of the track. */
  p50Percent: number;
  p90Percent: number;
  /** True once the written estimate runs past the end of the track. */
  over: boolean;
  tone: Tone;
  /** Pill text while the turn writes. */
  pillText: string;
  headline: string;
  verdict: string;
  detail: string;
  scaleNote: string;
  ariaLabel: string;
  caveat: string;
}

/** How the forecaster is doing across this conversation, not just this turn. */
export interface LedgerView {
  headline: string;
  foot: string;
  note: string;
  tone: Tone;
  fillPercent: number;
  markP50Percent: number;
  markP90Percent: number;
  dots: Array<{ tone: Tone; title: string }>;
}

export interface MetaSegment {
  text: string;
  title?: string;
}

export interface ChipViewModel {
  /** "live" is "a reply is being written", with or without a draft typed. */
  state: "empty" | "ready" | "live";
  pill: {
    text: string;
    ariaLabel: string;
    verified: boolean;
    pulsing: boolean;
    /** Drives the pill border tint. Only warning and above escalate. */
    level: WarningLevel;
  };
  /** Header line of the panel: the count and how it was produced. */
  countLabel: string;
  countTitle: string;
  headline: string | null;
  tuned: boolean;
  band: ForecastBand | null;
  turnLine: string | null;
  turnTuned: boolean;
  pooledNote: string | null;
  meter: ContextMeter | null;
  warnings: string[];
  cost: { value: string; note: string; title: string } | null;
  meta: MetaSegment[];
  /**
   * Where the panel's on/off control sits, or null when there is nothing to
   * control. It is offered in every ready state now that the setting ships as
   * an override: a default the user cannot see and flip is a wrong guess with
   * no way out.
   */
  thinkingControl: "on" | "off" | null;
  caveat: string;
  emptyHint: string | null;
  /** Non-null only while a reply is being written. */
  live: LiveView | null;
  /** Non-null once one turn in this conversation has been scored. */
  ledger: LedgerView | null;
  /**
   * The forecast as it stands for the draft on screen, ready to be frozen the
   * moment the draft is sent. Null when there is no draft to send.
   */
  snapshot: ForecastSnapshot | null;
}

/** 3px of a 312px track: below this a segment says nothing true. */
const MIN_SEGMENT_PERCENT = 1;
/** 28px of a 312px track: closer than this and two tick labels collide. */
const TICK_COLLISION_PERCENT = 9;
/** 6px of a 312px track: closer than this and two boundaries are one edge. */
const TICK_MERGE_PERCENT = 2;

/**
 * Where a token count sits on the track, on a square-root scale.
 *
 * Linear buries p50 (348 of 4,200 is 8% of the track); log needs a lower bound
 * the data does not supply. Square root is zero-anchored, parameter-free, and
 * monotone, so quantile ORDER survives while the small end stays legible. Every
 * boundary is labeled with its real value, so the reader compares numbers.
 */
function bandPosition(value: number, domain: number): number {
  if (domain <= 0) return 0;
  return Math.min(100, Math.sqrt(Math.max(0, value) / domain) * 100);
}

export function buildBand(forecast: Quantiles, maxOutputTokens: number): ForecastBand {
  const p99 = forecast.p99;
  let domain: number;
  let domainKind: ForecastBand["domainKind"];
  if (p99 === undefined) {
    domain = Math.max(forecast.p90, 1);
    domainKind = "p90";
  } else if (p99 >= maxOutputTokens * 0.5) {
    // The output cap only enters the picture once it is actually in reach.
    domain = maxOutputTokens;
    domainKind = "cap";
  } else {
    domain = Math.max(p99, 1);
    domainKind = "p99";
  }

  const at50 = bandPosition(forecast.p50, domain);
  const at90 = bandPosition(forecast.p90, domain);
  const at99 = p99 === undefined ? at90 : bandPosition(p99, domain);

  const segments: BandSegment[] = [
    { widthPercent: Math.max(MIN_SEGMENT_PERCENT, at50), opacity: 0.9 },
    { widthPercent: Math.max(MIN_SEGMENT_PERCENT, at90 - at50), opacity: 0.45 },
  ];
  if (p99 !== undefined) {
    segments.push({ widthPercent: Math.max(MIN_SEGMENT_PERCENT, at99 - at90), opacity: 0.2 });
  }

  const endLabel =
    domainKind === "cap" ? `cap ${formatCompact(domain)}` : formatCompact(domain);
  const ticks: BandTick[] = [];
  if (at90 - at50 < TICK_MERGE_PERCENT) {
    ticks.push({
      percent: (at50 + at90) / 2,
      label: `${formatCompact(forecast.p50)} · ${formatCompact(forecast.p90)}`,
      anchor: "center",
    });
  } else {
    ticks.push({ percent: at50, label: formatCompact(forecast.p50), anchor: "center" });
    ticks.push({ percent: at90, label: formatCompact(forecast.p90), anchor: "center" });
  }
  // The domain-end label always survives; a floating label too close to it goes.
  const endPercent = domainKind === "p90" ? at90 : at99;
  while (ticks.length > 0 && endPercent - ticks[ticks.length - 1]!.percent < TICK_COLLISION_PERCENT) {
    ticks.pop();
  }
  ticks.push({ percent: 100, label: endLabel, anchor: "end" });

  const quantileText =
    p99 === undefined
      ? `p50 ${formatExact(forecast.p50)} · p90 ${formatExact(forecast.p90)}`
      : `p50 ${formatExact(forecast.p50)} · p90 ${formatExact(forecast.p90)} · p99 ${formatExact(p99)}`;
  const domainText =
    domainKind === "p90"
      ? "the track ends at the 90th percentile"
      : domainKind === "cap"
        ? `the track ends at the model's output cap, ${formatExact(domain)}`
        : "the track ends at the 99th percentile";

  return {
    segments,
    ticks,
    domain,
    domainKind,
    ariaLabel: `Reply length forecast: ${quantileText} output tokens. Square-root scale, ${domainText}.`,
    title: `${quantileText} output tokens`,
  };
}

function buildMeter(
  budget: ContextBudgetResult,
  knownInputTokens: number,
  reservedTokens: number,
  contextWindow: number,
  lowerBound: boolean,
): ContextMeter {
  const measuredPercent = Math.min(100, (knownInputTokens / contextWindow) * 100);
  const reservedPercent = Math.min(
    Math.max(0, 100 - measuredPercent),
    (reservedTokens / contextWindow) * 100,
  );
  const over = knownInputTokens + reservedTokens > contextWindow;
  const prefix = lowerBound ? "≥ " : "";
  const caption = `${prefix}${formatExact(knownInputTokens)} / ${formatCompact(contextWindow)}${
    over ? `, ${STRINGS.contextOver}` : ""
  }`;
  return {
    measuredPercent,
    reservedPercent,
    level: budget.warningLevel,
    caption,
    note: lowerBound ? STRINGS.contextLowerBound : STRINGS.contextDraftOnly,
    lowerBound,
    over,
    ariaValueNow: knownInputTokens,
    ariaValueMax: contextWindow,
    ariaValueText: `${lowerBound ? "at least " : ""}${formatExact(knownInputTokens)} of ${formatExact(
      contextWindow,
    )} tokens${lowerBound ? ", lower bound" : ", draft only"}`,
  };
}

/**
 * Everything the forecaster is allowed to condition on here. The agent-loop
 * state is exact rather than guessed: a message typed into the composer is
 * always the root of its turn, so depth and prior calls are genuinely zero.
 */
function boostedContext(draft: string, sessionPosition: number): BoostedForecastContext {
  return {
    prompt: promptForecastFeatures(draft),
    // The public base text head is deliberately NOT computed here: the shipped
    // turnTotalBoost is still schema v2 and ignores it, and its asset costs the
    // content script 1.3 MB (docs/SEMANTIC-PLAN.md, Stage 1 part 2). That is
    // why it lives behind `@token-forecaster/predictor/text-head` rather than
    // on the package's main entry -- this file's import of the predictor does
    // not pull it in. Wire it the day a v4 correction adopts; the request field
    // and telemetry column already exist.
    agentLoop: {
      sessionPosition: Math.max(0, Math.trunc(sessionPosition)),
      loopDepth: 0,
      priorCallCount: 0,
    },
  };
}

function modelText(model: ResolvedModel): string {
  const entry = requireModel(model.id);
  if (model.resolution === "override") return `${entry.displayName} (your setting)`;
  if (model.resolution === "page") return `${entry.displayName} (${STRINGS.fromPage})`;
  if (model.resolution === "family" && model.pageLabel !== null) {
    return STRINGS.familyModel(model.pageLabel, entry.displayName);
  }
  if (model.pageLabel !== null && model.pageLabel.trim().length > 0) {
    return STRINGS.assumedModel(model.pageLabel, entry.displayName);
  }
  return `${entry.displayName} (assumed)`;
}

function thinkingSegment(thinking: ResolvedThinking): MetaSegment {
  const state = thinking.enabled ? "on" : "off";
  if (thinking.source === "page" && thinking.pageLabel !== null) {
    return {
      text: STRINGS.thinkingFromPage(thinking.pageLabel),
      title: STRINGS.thinkingCountsAs(thinking.enabled),
    };
  }
  if (thinking.source === "override") {
    return { text: STRINGS.thinkingOverride(state, thinking.pageLabel) };
  }
  if (thinking.source === "transcript") {
    return {
      text: STRINGS.thinkingFromTranscript(state),
      title: STRINGS.thinkingTranscriptNote,
    };
  }
  return { text: STRINGS.thinkingAssumed(state), title: STRINGS.thinkingAssumedNote };
}

/** Tone to the pill's existing border levels, so no new colour is invented. */
const TONE_LEVEL: Record<Tone, WarningLevel> = {
  good: "normal",
  ok: "normal",
  warn: "warning",
  bad: "critical",
};

/**
 * The live view of a running turn.
 *
 * Nothing here recomputes the forecast: every number comes from the snapshot
 * frozen at send. The only moving part is the marker, which is the whole
 * point of the surface.
 */
function buildLive(live: { snapshot: ForecastSnapshot; outTokens: number }): LiveView {
  const scale = scoringScale(live.snapshot);
  const quantiles = scale.quantiles;
  // The output cap bounds one call, never a whole turn: a loop of calls totals
  // more than the cap routinely, so a turn-scale track that ended at the cap
  // would pin every long turn to the same spot at the end of the band.
  const domainCap =
    scale.kind === "turn" ? Number.POSITIVE_INFINITY : live.snapshot.maxOutputTokens;
  const band = buildBand(quantiles, domainCap);
  const written = Math.max(0, live.outTokens);
  const { tone, word } = liveVerdict(written, quantiles);
  const markerPercent = bandPosition(written, band.domain);
  const scaleNote = scale.kind === "turn" ? STRINGS.liveScaleTurn : STRINGS.liveScaleCall;
  return {
    band,
    markerPercent,
    p50Percent: bandPosition(quantiles.p50, band.domain),
    p90Percent: bandPosition(quantiles.p90, band.domain),
    over: written > band.domain,
    tone,
    pillText: STRINGS.livePill(formatCompact(written), word),
    headline: STRINGS.liveWritten(formatCompact(written), formatCompact(quantiles.p50)),
    verdict: word,
    detail: STRINGS.liveNine(formatCompact(quantiles.p90)),
    scaleNote,
    ariaLabel: `Reply in progress. About ${formatExact(written)} tokens written, ${word}. Predicted ${formatExact(
      quantiles.p50,
    )} typical, ${formatExact(quantiles.p90)} at the ninetieth percentile.`,
    caveat: `${STRINGS.liveFrozen} ${STRINGS.liveEstimate}`,
  };
}

/** The pill while a reply writes: the live verdict replaces the draft range. */
function livePill(live: LiveView): ChipViewModel["pill"] {
  return {
    text: live.pillText,
    ariaLabel: live.ariaLabel,
    verified: false,
    // The turn is genuinely in flight, which is the one thing the pulse has
    // always meant on this chip.
    pulsing: true,
    level: TONE_LEVEL[live.tone],
  };
}

/** The conversation's running score. Linear track: these are summed totals. */
function buildLedger(records: readonly TurnRecord[]): LedgerView | null {
  const summary = summarizeLedger(records);
  if (summary === null) return null;
  const span = Math.max(summary.expectedHigh, summary.written * 1.05, 1);
  const percent = (value: number): number => Math.min(100, (value / span) * 100);
  return {
    headline: STRINGS.ledgerLine(
      formatCompact(summary.written),
      formatCompact(summary.expected),
      summary.ratioPercent,
    ),
    foot: STRINGS.ledgerFoot(summary.scored, summary.within),
    note: STRINGS.ledgerNote,
    tone: summary.tone,
    fillPercent: percent(summary.written),
    markP50Percent: percent(summary.expected),
    markP90Percent: percent(summary.expectedHigh),
    dots: summary.dots,
  };
}

export function buildViewModel(input: EngineInput): ChipViewModel {
  const model = requireModel(input.model.id);
  const draft = input.draft;
  const caveat = input.surface === "code" ? STRINGS.caveatCode : STRINGS.caveatChat;

  const live = input.live === null || input.live === undefined ? null : buildLive(input.live);
  const ledger = buildLedger(input.ledger ?? []);

  if (draft.trim().length === 0) {
    return {
      state: live === null ? "empty" : "live",
      pill:
        live === null
          ? {
              text: STRINGS.emptyPill,
              ariaLabel: `${STRINGS.productName}. ${STRINGS.emptyHint}`,
              verified: false,
              pulsing: false,
              level: "normal",
            }
          : livePill(live),
      countLabel: "",
      countTitle: "",
      headline: null,
      tuned: false,
      band: null,
      turnLine: null,
      turnTuned: false,
      pooledNote: null,
      meter: null,
      warnings: [],
      cost: null,
      meta: [],
      thinkingControl: null,
      caveat,
      emptyHint: live === null ? STRINGS.emptyHint : null,
      live,
      ledger,
      snapshot: null,
    };
  }

  const mentionsPath = promptMentionsPath(draft);
  const context = boostedContext(draft, input.sessionPosition);
  // Always a boolean: the resolver ends in an assumption rather than in
  // "unknown", so the forecast never falls back to the pooled thinking group.
  const thinkingEnabled = input.thinking.enabled;

  const { forecast, calibration } = historicalBaselineForecast(
    {
      model: input.model.id,
      maxTokens: model.maxOutputTokens,
      thinkingEnabled,
      promptMentionsPath: mentionsPath,
      promptHasImage: input.hasImage,
      boostedContext: context,
    },
    BUNDLED_CLAUDE_CODE_PROFILE,
  );

  const turnTotal = historicalTurnTotalForecast(
    {
      model: input.model.id,
      thinkingEnabled,
      promptMentionsPath: mentionsPath,
      promptHasImage: input.hasImage,
      boostedContext: context,
    },
    BUNDLED_CLAUDE_CODE_PROFILE,
  );

  const knownInputTokens =
    input.inputTokens + (input.transcriptTokens === null ? 0 : input.transcriptTokens);
  const reservedTokens = Math.max(1, Math.min(forecast.p90, model.maxOutputTokens));
  let meter: ContextMeter | null = null;
  let warnings: string[] = [];
  try {
    const budget = calculateContextBudget({
      contextWindow: model.contextWindow,
      inputTokens: knownInputTokens,
      // claude.ai never shows a max_tokens, so the reservation the user is
      // really exposed to is the reply itself at p90.
      reservedOutputTokens: reservedTokens,
      outputP50: forecast.p50,
      outputP90: forecast.p90,
    });
    meter = buildMeter(
      budget,
      knownInputTokens,
      reservedTokens,
      model.contextWindow,
      input.transcriptTokens !== null,
    );
    warnings = [...budget.warningReasons];
  } catch {
    meter = null;
  }

  const cost = projectCostUsd(input.model.id, knownInputTokens, forecast.p50, forecast.p90);
  const quality = QUALITY_SHORT[input.inputQuality];
  const statusSuffix =
    input.verifyState === "verifying"
      ? ` (${STRINGS.verifying})`
      : input.verifyState === "waiting"
        ? ` (${STRINGS.waiting})`
        : "";

  if (input.verifyError !== null) warnings.unshift(STRINGS.verifyFailed(input.verifyError));

  const meta: MetaSegment[] = [
    { text: modelText(input.model) },
    thinkingSegment(input.thinking),
    {
      // Capped at "low" on both surfaces. The library grants "medium" at a rung
      // sample size of 500 or more, but those samples are one person's corpus,
      // so the level is unearned for a stranger. Restore
      // `input.surface === "code" ? forecast.confidence : "low"` only when the
      // leave-one-project-out probe (docs/MULTI-USER-PLAN.md, phase 1) reports
      // transfer coverage, and cite the artifact.
      text: STRINGS.confidenceWord("low"),
      title: `${calibration.profileScope} · ${formatExact(calibration.sampleSize)} calls in the selected group`,
    },
  ];

  const level = meter?.level ?? "normal";
  const pillLevel: WarningLevel = level === "informational" ? "normal" : level;
  // The pill draws the context meter too, so its label has to say what the bar
  // says; a bar with no spoken equivalent is a silent number.
  const contextSentence =
    meter === null ? "" : ` Context ${meter.ariaValueText}, reply reserved.`;
  const draftPill: ChipViewModel["pill"] = {
    text: `${formatCompact(input.inputTokens)} in · ~${formatCompact(forecast.p50)}–${formatCompact(forecast.p90)} out`,
    ariaLabel: `Token forecast. Draft ${formatExact(input.inputTokens)} tokens, ${quality}. Reply forecast ${formatExact(
      forecast.p50,
    )} to ${formatExact(forecast.p90)} tokens.${contextSentence}${
      pillLevel === "normal" ? "" : " Context warning."
    }`,
    verified: input.inputQuality === "anthropic_verified",
    pulsing: input.verifyState === "verifying",
    level: pillLevel,
  };

  // What is being written now outranks what might be sent next: the draft
  // range is one click away in the panel, and the running turn is not.
  return {
    state: live === null ? "ready" : "live",
    pill: live === null ? draftPill : livePill(live),
    countLabel: `${formatCompact(input.inputTokens)} in · ${quality}${statusSuffix}`,
    countTitle: QUALITY_LABELS[input.inputQuality],
    headline: `~${formatExact(forecast.p50)}–${formatExact(forecast.p90)} ${STRINGS.headlineUnit}`,
    tuned: calibration.boostedCorrectionApplied,
    band: buildBand(forecast, model.maxOutputTokens),
    turnLine:
      turnTotal === null
        ? null
        : `${STRINGS.turnPrefix} ~${formatCompact(turnTotal.p50)}–${formatCompact(turnTotal.p90)} ${STRINGS.turnUnit}`,
    turnTuned: turnTotal?.promptCorrectionApplied ?? false,
    pooledNote: calibration.usedFallback ? STRINGS.pooledModels : null,
    meter,
    warnings,
    cost: {
      value: `${formatUsd(cost.totalUsdAtP50)}–${formatUsd(cost.totalUsdAtP90)}`,
      note: STRINGS.costNoteShort,
      title: STRINGS.costNote,
    },
    meta,
    thinkingControl: thinkingEnabled ? "on" : "off",
    caveat,
    emptyHint: null,
    live,
    ledger,
    snapshot: {
      call: { p50: forecast.p50, p90: forecast.p90, p99: forecast.p99 },
      turn:
        turnTotal === null
          ? null
          : { p50: turnTotal.p50, p90: turnTotal.p90, p99: turnTotal.p99 },
      callTuned: calibration.boostedCorrectionApplied,
      turnTuned: turnTotal?.promptCorrectionApplied ?? false,
      modelId: input.model.id,
      modelName: model.displayName,
      maxOutputTokens: model.maxOutputTokens,
      thinkingEnabled,
      pooled: calibration.usedFallback,
      sampleSize: calibration.sampleSize,
      profileScope: calibration.profileScope,
      surface: input.surface,
      inputTokens: input.inputTokens,
      inputQuality: input.inputQuality,
      promptFeatures: context.prompt!,
      // Copied, not aliased: the snapshot outlives the context object.
      ...(context.textHead ? { textHeadQuantiles: [...context.textHead] as [number, number, number] } : {}),
      promptMentionsPath: mentionsPath,
      promptHasImage: input.hasImage,
      sessionPosition: Math.max(0, Math.trunc(input.sessionPosition)),
      predictorVersion: forecast.predictorVersion,
      forecastSource: forecast.source,
      confidence: forecast.confidence,
    },
  };
}

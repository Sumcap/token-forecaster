/**
 * The turn: freeze a forecast when the draft is sent, watch what the reply
 * actually writes, then score it.
 *
 * Pure. No DOM, no chrome API, no clock of its own; the caller supplies the
 * measurement and the timestamps, so every rule in here is unit testable.
 *
 * Two contracts hold the whole feature together, and both are borrowed from
 * the sheep-manager surface this ports:
 *
 *   1. The forecast is frozen at send and NEVER revised mid-turn. Only the
 *      marker moves. A prediction that drifts towards the outcome cannot be
 *      wrong, which makes it worthless as a check.
 *   2. The written figure is an estimate off the rendered text, and says so
 *      everywhere it appears. The extension never sends a reply anywhere, so
 *      there is no authoritative count to be had on this surface.
 */
import { formatCompact, formatExact, STRINGS } from "./format.js";
import type {
  CountQuality,
  ForecastConfidence,
  ForecastSource,
  PromptForecastFeatureObservation,
} from "@token-forecaster/core";
import type { Surface } from "./surface.js";

export interface Quantiles {
  p50: number;
  p90: number;
  /** Absent on rungs that never earned a p99. */
  p99?: number | undefined;
}

/**
 * Everything about a forecast that has to survive the send, so the score is
 * read against what was actually predicted rather than against whatever the
 * engine would say now.
 */
export interface ForecastSnapshot {
  /** The opening call of the turn. */
  call: Quantiles;
  /** The whole turn including a tool or research loop, when the rung exists. */
  turn: Quantiles | null;
  callTuned: boolean;
  turnTuned: boolean;
  modelId: string;
  modelName: string;
  /** The model's output cap, which is the band's domain once p99 reaches it. */
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  pooled: boolean;
  sampleSize: number;
  profileScope: string;
  surface: Surface;
  /** Privacy-safe pre-call fields frozen for an optional research row. */
  inputTokens?: number;
  inputQuality?: CountQuality;
  promptFeatures?: PromptForecastFeatureObservation;
  promptMentionsPath?: boolean;
  promptHasImage?: boolean;
  sessionPosition?: number;
  predictorVersion?: string;
  forecastSource?: ForecastSource;
  confidence?: ForecastConfidence;
}

export type ScaleKind = "turn" | "call";

export interface ScoringScale {
  quantiles: Quantiles;
  kind: ScaleKind;
}

/**
 * Which numbers a turn is scored against.
 *
 * What gets measured is every assistant message that appears after the send,
 * which on `/code` is the whole agent loop and in chat is one reply. So the
 * scale follows the surface rather than the reply's shape: a scale that
 * switched mid-flight would move the goalposts while the reader watched, and
 * that is exactly the overclaim this chip has already had to walk back once.
 */
export function scoringScale(snapshot: ForecastSnapshot): ScoringScale {
  if (snapshot.surface === "code" && snapshot.turn !== null) {
    return { quantiles: snapshot.turn, kind: "turn" };
  }
  return { quantiles: snapshot.call, kind: "call" };
}

export type Band = "under-p50" | "p50-p90" | "p90-p99" | "over-p99";
export type Tone = "good" | "ok" | "warn" | "bad";

export const BAND_TEXT: Record<Band, { label: string; short: string; why: string; tone: Tone }> = {
  "under-p50": {
    label: STRINGS.bandOnTrackLong,
    short: STRINGS.bandOnTrack,
    why: STRINGS.bandOnTrackWhy,
    tone: "good",
  },
  "p50-p90": {
    label: STRINGS.bandNormal,
    short: STRINGS.bandNormal,
    why: STRINGS.bandNormalWhy,
    tone: "ok",
  },
  "p90-p99": {
    label: STRINGS.bandLong,
    short: STRINGS.bandLong,
    why: STRINGS.bandLongWhy,
    tone: "warn",
  },
  "over-p99": {
    label: STRINGS.bandOver,
    short: STRINGS.bandOver,
    why: STRINGS.bandOverWhy,
    tone: "bad",
  },
};

/**
 * Where an outcome sits in the predicted distribution.
 *
 * With no p99 on the rung the top band still exists: anything past p90 by more
 * than half again is "far longer than predicted" whether or not the rung can
 * name the percentile. Silence up there would report a runaway turn as normal.
 */
export function bandOf(outTokens: number, quantiles: Quantiles): Band {
  if (outTokens <= quantiles.p50) return "under-p50";
  if (outTokens <= quantiles.p90) return "p50-p90";
  const top = quantiles.p99 ?? quantiles.p90 * 1.5;
  return outTokens <= top ? "p90-p99" : "over-p99";
}

export interface TurnRecord {
  /** Monotonic within one conversation. Identifies a record across renders. */
  id: number;
  snapshot: ForecastSnapshot;
  scale: ScoringScale;
  /** Estimated tokens written by everything the turn appended. */
  outTokens: number;
  /** Null only while the turn is still running, or when it is abandoned. */
  band: Band | null;
  /** The turn produced nothing to score: cancelled, or an error before text. */
  abandoned: boolean;
  startedAt: number;
  settledAt: number | null;
}

/** A view the verdict badge and the panel can both render without deciding. */
export interface VerdictView {
  text: string;
  title: string;
  tone: Tone | "off";
  icon: string;
  ariaLabel: string;
}

function scaleWords(kind: ScaleKind): string {
  return kind === "turn" ? STRINGS.liveScaleTurn : STRINGS.liveScaleCall;
}

/** The one-line answer to "did this turn come out the way it was predicted?". */
export function verdictView(record: TurnRecord): VerdictView {
  const written = formatCompact(record.outTokens);
  const quantiles = record.scale.quantiles;
  if (record.abandoned || record.band === null) {
    return {
      text: STRINGS.liveAbandoned,
      title: STRINGS.liveAbandoned,
      tone: "off",
      icon: "◌",
      ariaLabel: STRINGS.liveAbandoned,
    };
  }
  const band = BAND_TEXT[record.band];
  const title = STRINGS.verdictTitle(
    formatExact(record.outTokens),
    band.label,
    formatExact(quantiles.p50),
    formatExact(quantiles.p90),
    scaleWords(record.scale.kind),
  );
  return {
    text: `${STRINGS.settledWritten(written)} · ${band.label}`,
    title,
    tone: band.tone,
    icon: band.tone === "good" || band.tone === "ok" ? "✓" : "!",
    ariaLabel: `${STRINGS.settledWritten(formatExact(record.outTokens))}, ${band.label}.`,
  };
}

export interface LedgerSummary {
  scored: number;
  within: number;
  written: number;
  expected: number;
  expectedHigh: number;
  /** Written as a percentage of the summed p50. 100 is a typical session. */
  ratioPercent: number;
  tone: Tone;
  /** Newest last, capped by the caller's slice. One entry per scored turn. */
  dots: Array<{ tone: Tone; title: string }>;
}

/**
 * The running answer to "is the forecaster right about THIS conversation?".
 *
 * Against the summed p50, because half of comparable turns should land under
 * it: a healthy session hovers near 100%, and over 100% is a session of
 * longer-than-typical turns rather than a failing grade. The copy has to not
 * read as a score, so nothing here returns a pass or a fail.
 */
export function summarizeLedger(records: readonly TurnRecord[]): LedgerSummary | null {
  const scored = records.filter((record) => record.band !== null && !record.abandoned);
  if (scored.length === 0) return null;
  const written = scored.reduce((total, record) => total + record.outTokens, 0);
  const expected = scored.reduce((total, record) => total + record.scale.quantiles.p50, 0);
  const expectedHigh = scored.reduce((total, record) => total + record.scale.quantiles.p90, 0);
  const within = scored.filter(
    (record) => record.band === "under-p50" || record.band === "p50-p90",
  ).length;
  const tone: Tone = written <= expected ? "good" : written <= expectedHigh ? "ok" : "warn";
  return {
    scored: scored.length,
    within,
    written,
    expected,
    expectedHigh,
    ratioPercent: expected > 0 ? Math.round((written / expected) * 100) : 0,
    tone,
    dots: scored.slice(-24).map((record) => {
      const band = BAND_TEXT[record.band!];
      return {
        tone: band.tone,
        title: `${STRINGS.settledWritten(formatExact(record.outTokens))} · ${band.label}`,
      };
    }),
  };
}

/** The verb for a turn that is still writing, one band above the settled one. */
export function liveVerdict(outTokens: number, quantiles: Quantiles): {
  band: Band;
  tone: Tone;
  word: string;
} {
  const band = bandOf(outTokens, quantiles);
  const text = BAND_TEXT[band];
  return { band, tone: text.tone, word: text.short };
}

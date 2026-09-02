/**
 * Number formatting and every user-facing string in one place.
 *
 * The strings live here so the tests can assert them and so a wording change
 * never means touching DOM code.
 */
import type { CountQuality } from "@token-forecaster/core";

/**
 * Short form for the pill: 391 -> "391", 1,700 -> "1.7k", 30,222 -> "30k",
 * 1,000,000 -> "1M".
 */
export function formatCompact(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return String(value);
  if (value < 10_000) {
    const thousands = (value / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${thousands}k`;
  }
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Long form for the panel: 30,222. */
export function formatExact(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}

/** Cost keeps enough decimals to stay non-zero at chat scale. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export const QUALITY_LABELS: Record<CountQuality, string> = {
  anthropic_verified: "Anthropic counted, draft only",
  local_exact: "Local exact",
  local_estimate: "Local estimate",
  character_heuristic: "Local estimate (character heuristic)",
};

/** The short form beside the pill's dot and in the panel header. */
export const QUALITY_SHORT: Record<CountQuality, string> = {
  anthropic_verified: "counted",
  local_exact: "exact",
  local_estimate: "estimate",
  character_heuristic: "estimate",
};

export const STRINGS = {
  productName: "Token Forecaster",
  emptyPill: "Token Forecaster",
  emptyHint: "Start typing. The estimate updates while you write.",

  forecastKicker: "REPLY FORECAST",
  contextKicker: "CONTEXT (visible only)",
  headlineUnit: "tokens out",
  tunedBadge: "tuned to your draft",
  tunedBadgeShort: "tuned",
  pooledModels: "pooled across models",
  turnPrefix: "If this becomes a tool or research loop:",
  turnUnit: "total",

  contextLowerBound: "lower bound: excludes the system prompt, attachments, tools, and memory",
  contextDraftOnly: "draft only: the conversation is not measured",
  contextOver: "over",

  costLabel: "API-equivalent cost",
  costNoteShort: "list API rates",
  costNote: "list API rates, not what your subscription bills",

  confidenceWord: (level: string) => `confidence ${level}`,
  caveatChat:
    "Fitted on Claude Code agent traffic, so claude.ai chat is out of domain. Read these as rough scale, not a promise.",
  caveatCode:
    "Fitted on one person's Claude Code agent traffic, which is the work this page does. Read these as a prior for this kind of work, not a promise about how you write.",

  verifying: "verifying...",
  waiting: "waiting for a pause...",
  verifyFailed: (message: string) =>
    `Verification unavailable: ${message}. Showing the local estimate.`,

  assumedModel: (label: string, assumed: string) =>
    `${assumed} (assumed: "${label}" is not in the registry)`,
  familyModel: (label: string, assumed: string) =>
    `${assumed} (nearest known model to "${label}")`,
  fromPage: "from the page",

  thinkingFromPage: (label: string) => `thinking ${label} (from the page)`,
  thinkingOverride: (state: string, pageLabel: string | null) =>
    pageLabel === null
      ? `thinking ${state} (your setting)`
      : `thinking ${state} (your setting, the page shows ${pageLabel})`,
  thinkingFromTranscript: (state: string) => `thinking ${state} (from the last reply)`,
  thinkingTranscriptNote:
    "Read from the newest reply on the page: it shows a thinking block, or it does not.",
  thinkingAssumed: (state: string) => `thinking ${state} (assumed)`,
  thinkingAssumedNote:
    "Nothing on the page says. claude.ai ships extended thinking on, so the forecast uses the thinking group. Set it here or in options to be sure.",
  thinkingCountsAs: (enabled: boolean) =>
    `counts as extended thinking: ${enabled ? "on" : "off"}`,
  thinkingControlLabel: "Thinking:",

  optionsLink: "Options",

  /* ---- the running turn, and the score it gets afterwards ---- */
  liveKicker: "THIS TURN",
  ledgerKicker: "FORECAST SO FAR",
  liveWritten: (written: string, expected: string) =>
    `\u2248${written} written of about ${expected} expected`,
  liveNine: (p90: string) => `9 in 10 comparable turns finish under ${p90}`,
  liveScaleTurn: "scored against the whole turn, tool calls included",
  liveScaleCall: "scored against this single reply",
  liveEstimate:
    "Estimated from the text on screen with the character heuristic, so it lags the real count and includes anything the reply renders.",
  liveFrozen: "The forecast was frozen when you sent. Only the marker moves.",
  livePill: (written: string, verdict: string) => `\u2248${written} out \u00b7 ${verdict}`,
  liveAbandoned: "Turn ended with nothing written. Not scored.",
  settledWritten: (written: string) => `${written} written`,

  bandOnTrack: "on track",
  bandOnTrackLong: "shorter than typical",
  bandOnTrackWhy: "at or under the p50 mark",
  bandNormal: "longer than typical, still normal",
  bandNormalWhy: "between p50 and p90",
  bandLong: "unusually long",
  bandLongWhy: "between p90 and p99",
  bandOver: "far longer than predicted",
  bandOverWhy: "past p99",

  ledgerLine: (written: string, expected: string, percent: number) =>
    `${written} written \u00b7 ${expected} expected (${percent}% of expected)`,
  ledgerFoot: (scored: number, within: number) =>
    `${scored} turn${scored === 1 ? "" : "s"} scored \u00b7 ${within}/${scored} landed inside the usual range`,
  ledgerNote:
    "One turn landing high says nothing. Most of them landing high says the profile does not match this work.",
  verdictTitle: (written: string, label: string, p50: string, p90: string, scale: string) =>
    `${written} written \u00b7 ${label}.\nPredicted before you sent: half of comparable turns under ${p50}, nine in ten under ${p90} (${scale}).\nThe written figure is estimated from the rendered text, not counted by the API.`,
  verdictOpen: "Open the forecast panel",
} as const;

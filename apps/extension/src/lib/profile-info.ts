/**
 * The honest, user-facing description of the profile the forecast comes from.
 *
 * Both the welcome page and the settings page render this, so the two cannot
 * drift apart, and the strings are testable without a browser.
 */
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  type HistoricalForecastProfile,
} from "@token-forecaster/predictor";

export interface ProfileSummary {
  /** The profile id, e.g. `claude-code-local-2026-08-12`. */
  id: string;
  /** What the quantiles describe. */
  scope: string;
  /** When the profile was fitted, as a date a person can read. */
  fittedOn: string;
  /** Calls the fit was built from, formatted. */
  calls: string;
  /** How many conditioned groups the ladder can choose from. */
  groups: number;
  /**
   * Whether the numbers were fitted on this machine's own history.
   *
   * Always false today: the extension carries one frozen profile and cannot
   * read local transcripts. The field exists so the page has one place to
   * state that, and one place to change when a local trainer ships.
   */
  personal: boolean;
}

function readableDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "an unrecorded date";
  return new Date(parsed).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function summarizeProfile(
  profile: HistoricalForecastProfile = BUNDLED_CLAUDE_CODE_PROFILE,
): ProfileSummary {
  return {
    id: profile.id,
    scope: profile.scope,
    fittedOn: readableDate(profile.generatedAt),
    calls: profile.eligibleObservations.toLocaleString("en-US"),
    groups: Object.keys(profile.groups).length,
    personal: false,
  };
}

/**
 * One sentence about where the numbers come from, and one about what that
 * does not mean. The second sentence is the point: the shipped profile is a
 * population prior fitted on one corpus, not a calibration of this user.
 */
export function profileProvenanceLines(summary: ProfileSummary): [string, string] {
  const first = summary.personal
    ? `Fitted on this machine's own Claude Code history: ${summary.calls} calls, last rebuilt ${summary.fittedOn}.`
    : `The bundled profile: ${summary.calls} Claude Code calls, fitted ${summary.fittedOn}, ${summary.groups} conditioned groups.`;
  const second = summary.personal
    ? "Groups without enough of your own calls still fall back to the bundled profile."
    : "It was fitted on one corpus, so read it as a prior for this kind of work, not as a measurement of how you personally write.";
  return [first, second];
}

/**
 * Deciding whether extended thinking is on, and turning that into the boolean
 * the forecaster conditions on.
 *
 * There are three ways to know, in order of how much they are trusted:
 *
 *   1. the user's own override in options or on the chip,
 *   2. the effort control claude.ai shows next to the model picker ("High"),
 *   3. the newest reply on the page: a thinking block in it means the setting
 *      was on when that reply was written.
 *
 * When none of them answers, the resolver ASSUMES thinking is on, because that
 * is how claude.ai ships and how the surface is used almost all of the time.
 * The assumption is labelled as one everywhere it is shown, and one click on
 * the chip replaces it with a real answer.
 */

/** What the user chose in options. `auto` means "read the page". */
export type ThinkingSetting = "auto" | "on" | "off";

export type ThinkingSource = "override" | "page" | "transcript" | "assumed";

/** What the page said, gathered by `src/content/extract.ts`. */
export interface ThinkingEvidence {
  /** The effort word next to the model picker, or null when it is unreadable. */
  pageLabel: string | null;
  /**
   * Thinking blocks in the newest reply on screen: true when it has one, false
   * when it has none, null when there is no reply to read yet.
   */
  transcript: boolean | null;
}

export interface ResolvedThinking {
  enabled: boolean;
  source: ThinkingSource;
  /** The word the page showed, whichever rung the answer came from. */
  pageLabel: string | null;
}

/**
 * What thinking is when nothing on the page says. claude.ai enables extended
 * thinking by default, and the forecast for the thinking group is the longer
 * of the two, so this errs towards reserving too much context rather than too
 * little.
 */
export const ASSUMED_THINKING = true;

/**
 * Effort levels that mean the model is thinking before it answers. The scale
 * has grown before, so an unrecognized word returns null rather than a guess.
 */
const THINKING_ON = /^(low|medium|high|max|maximum|extended|thinking|deep)$/;
const THINKING_OFF = /^(off|none|no|standard|normal|instant|fast|quick|default)$/;

export function mapEffortToThinking(label: string): boolean | null {
  const word = label.trim().toLowerCase().replace(/\s+effort$/, "");
  if (THINKING_ON.test(word)) return true;
  if (THINKING_OFF.test(word)) return false;
  return null;
}

const NO_EVIDENCE: ThinkingEvidence = { pageLabel: null, transcript: null };

/** An explicit override wins; then the control; then the last reply; then the default. */
export function resolveThinking(
  setting: ThinkingSetting,
  evidence: ThinkingEvidence = NO_EVIDENCE,
): ResolvedThinking {
  const pageLabel = evidence.pageLabel;
  if (setting === "on") return { enabled: true, source: "override", pageLabel };
  if (setting === "off") return { enabled: false, source: "override", pageLabel };

  if (pageLabel !== null) {
    const mapped = mapEffortToThinking(pageLabel);
    if (mapped !== null) return { enabled: mapped, source: "page", pageLabel };
  }
  if (evidence.transcript !== null) {
    return { enabled: evidence.transcript, source: "transcript", pageLabel };
  }
  return { enabled: ASSUMED_THINKING, source: "assumed", pageLabel };
}

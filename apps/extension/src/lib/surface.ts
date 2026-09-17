/**
 * Which claude.ai surface the chip is looking at.
 *
 * It matters for honesty, not for layout: the shipped profile is fitted on
 * Claude Code agent traffic, so `/code` is the surface it actually describes
 * and chat is out of domain.
 */

export type Surface = "code" | "chat";

/** `/code`, `/code/`, and every route under it are the Claude Code surface. */
export function surfaceFromPath(pathname: string): Surface {
  return /^\/code(\/|$)/.test(pathname) ? "code" : "chat";
}

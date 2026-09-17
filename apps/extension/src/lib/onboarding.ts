/**
 * Install-time onboarding: whether a fresh install should be shown the welcome
 * page.
 *
 * Deliberately free of any import that pulls the forecast profile in. The
 * service worker is the only consumer that runs on every browser start, and
 * the 235 KB of quantiles belongs in the pages that display them, not in it.
 * The description of the profile lives in `profile-info.ts` for that reason.
 */
/**
 * Bump only when the welcome page says something a returning user has not
 * been told. An install always shows it; a bump is what lets a future release
 * show it again to somebody who already has the extension.
 */
export const ONBOARDING_VERSION = 2;

/** Extension-relative path of the welcome page. */
export const WELCOME_PATH = "welcome.html";

/**
 * Chrome's `onInstalled` reasons. Typed as an open string because the browser
 * is free to add one, and an unknown reason must not open a tab.
 */
export type InstallReason = "install" | "update" | (string & {});

/**
 * Fresh installs get the welcome page. Updates never do: an extension that
 * steals a tab whenever Chrome auto-updates it is a nuisance, and the user
 * did not ask for anything at that moment.
 */
export function shouldOpenWelcome(reason: InstallReason, seenVersion: number): boolean {
  if (reason !== "install") return false;
  if (!Number.isInteger(seenVersion)) return true;
  return seenVersion < ONBOARDING_VERSION;
}

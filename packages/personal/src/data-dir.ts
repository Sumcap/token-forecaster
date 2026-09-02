import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Where everything this tool derives about you is kept.
 *
 * One rule, in one place, because four processes have to agree on it: the
 * daemon, the CLI, the status line (which cannot import the store — see
 * `apps/companion/src/statusline.ts`), and the Python launcher, which
 * reimplements this function and is held to it by a test.
 *
 * The convention is per-platform rather than uniform. A directory named
 * `Library/Application Support` on Windows would be as wrong as `AppData` on a
 * Mac, and both would be somewhere the operating system does not back up,
 * roam, or clean up the way it does its own.
 */

/** Override the platform, environment and home directory. Tests and nothing else. */
export interface DataDirEnvironment {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/** Trimmed value of `name`, or null when it is unset or blank. */
function envPath(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The application-support directory for this platform.
 *
 * `TOKEN_FORECASTER_DATA_DIR` wins everywhere. It is what lets a second
 * install, a test, or a portable checkout keep its own state, and it is the
 * only way the status line can follow a daemon started with `--data-dir`.
 */
export function defaultDataDir(environment: DataDirEnvironment = {}): string {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  // Windows paths must come out with backslashes even when this runs from a
  // test on a Mac, so the separator follows the target platform, not the host.
  const path = platform === "win32" ? win32 : posix;

  const override = envPath(env, "TOKEN_FORECASTER_DATA_DIR");
  if (override) return override;

  if (platform === "win32") {
    // Local, not Roaming: a SQLite database with a WAL beside it is exactly
    // what roaming profiles are not for.
    const local = envPath(env, "LOCALAPPDATA") ?? path.join(home, "AppData", "Local");
    return path.join(local, "TokenForecaster");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "TokenForecaster");
  }
  // Everything else follows the XDG base directory spec. State, not data: this
  // is a cache of your own history that can be rebuilt from the transcripts.
  const state = envPath(env, "XDG_STATE_HOME") ?? path.join(home, ".local", "state");
  return path.join(state, "token-forecaster");
}

/** Where `tf-claude` publishes the counts for the line being typed. */
export function draftDir(environment: DataDirEnvironment = {}): string {
  const platform = environment.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  return path.join(defaultDataDir(environment), "drafts");
}

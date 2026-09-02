import { fileURLToPath } from "node:url";

/** The CLIs a launcher is shipped for. */
export type LauncherProgram = "claude" | "codex";

/**
 * Absolute path of the draft-aware launcher shipped beside the daemon.
 *
 * There is one launcher per CLI, and both are the same Python program with a
 * different front end: `tf-claude` only has to watch the keystrokes, because
 * Claude Code renders the bar itself, while `tf-codex` also paints it —
 * Codex's status line takes only Codex's own built-in items and no hook of any
 * kind runs a command.
 *
 * Windows cannot run either: `#!` means nothing there, and the shell block has
 * to name something the console will execute. So a `.cmd` ships next to each
 * one and does nothing but find an interpreter and hand it the script.
 *
 * Three callers compute this path — the CLI, the daemon and the API — and a
 * bundled build once shipped without the file at the end of it, writing a dead
 * `claude` into every recipient's shell. One function, so there is one thing to
 * assert about in `build-dist.sh`.
 */
export function launcherPath(
  platform: NodeJS.Platform = process.platform,
  program: LauncherProgram = "claude",
): string {
  const name = platform === "win32" ? `tf-${program}.cmd` : `tf-${program}`;
  return fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
}

/** Every launcher this build ships, by the command it stands in for. */
export function launcherTargets(
  platform: NodeJS.Platform = process.platform,
): Record<LauncherProgram, string> {
  return { claude: launcherPath(platform, "claude"), codex: launcherPath(platform, "codex") };
}

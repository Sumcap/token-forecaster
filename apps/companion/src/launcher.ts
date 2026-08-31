import { fileURLToPath } from "node:url";

/**
 * Absolute path of the draft-aware launcher shipped beside the daemon.
 *
 * The launcher is one Python program, but Windows cannot run it: `#!` means
 * nothing there, and the shell block has to name something the console will
 * execute. So `bin/tf-claude.cmd` ships next to `bin/tf-claude` and does
 * nothing but find an interpreter and hand it the script.
 *
 * Three callers compute this path — the CLI, the daemon and the API — and a
 * bundled build once shipped without the file at the end of it, writing a dead
 * `claude` into every recipient's shell. One function, so there is one thing to
 * assert about in `build-dist.sh`.
 */
export function launcherPath(platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? "tf-claude.cmd" : "tf-claude";
  return fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
}

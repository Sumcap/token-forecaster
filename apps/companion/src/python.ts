import { spawnSync } from "node:child_process";

/**
 * Finding an interpreter for the launcher.
 *
 * `bin/tf-claude` is a Python program. On macOS and Linux its `#!` line finds
 * the interpreter; on Windows nothing does, so `bin/tf-claude.cmd` looks for
 * one and this is the same search, in the same order, from the Node side —
 * which is what lets `install-shell` say that the block it just wrote will not
 * do anything yet, instead of leaving someone to discover it from a forecast
 * that never mentions a draft.
 */

/** How to invoke Python, best first, for `platform`. */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): string[][] {
  // The py launcher ships with python.org installs and resolves the newest
  // 3.x; `python` is what the Microsoft Store install leaves on PATH.
  if (platform === "win32") return [["py", "-3"], ["python"], ["python3"]];
  return [["python3"], ["python"]];
}

/** The first candidate that runs, as a command and its arguments, or null. */
export function findPython(platform: NodeJS.Platform = process.platform): string[] | null {
  for (const candidate of pythonCandidates(platform)) {
    const [command, ...args] = candidate as [string, ...string[]];
    const probe = spawnSync(command, [...args, "--version"], {
      stdio: "ignore",
      timeout: 5_000,
      // `py` and `python` on Windows are shims; without this, spawnSync would
      // need the extension spelled out.
      shell: platform === "win32",
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

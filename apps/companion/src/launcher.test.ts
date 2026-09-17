import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultDataDir, draftDir } from "@token-forecaster/personal/data-dir";
import { describe, expect, it } from "vitest";

import { launcherPath, launcherTargets } from "./launcher.js";
import { findPython, pythonCandidates } from "./python.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

describe("launcherPath", () => {
  it("names the Python program on POSIX and the shim on Windows", () => {
    expect(launcherPath("darwin").endsWith("/bin/tf-claude")).toBe(true);
    expect(launcherPath("linux").endsWith("/bin/tf-claude")).toBe(true);
    expect(launcherPath("win32").endsWith("/bin/tf-claude.cmd")).toBe(true);
  });

  it("points at files that are actually shipped", () => {
    // The daemon writes this path into a shell startup file on first run. A
    // build that ships without the file at the end of it writes a `claude`
    // that does nothing, once, and never gets another chance.
    for (const platform of ["darwin", "win32"] as const) {
      expect(statSync(launcherPath(platform)).isFile()).toBe(true);
    }
  });

  it("keeps the Windows shims runnable by cmd.exe", () => {
    for (const program of ["claude", "codex"] as const) {
      const shim = readFileSync(launcherPath("win32", program), "utf8");
      // `goto` is unreliable in a batch file with bare newlines, and this one
      // branches four ways before it starts anything.
      expect(shim.includes("\r\n")).toBe(true);
      expect(shim.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
      // Whatever else happens, the session still starts.
      expect(shim).toContain(":fallback");
      expect(shim).toContain(`${program} %*`);
    }
  });

  it("ships a launcher for both CLIs", () => {
    // Codex has no status-line hook of any kind, so `tf-codex` is the only
    // thing that can put a forecast under its composer. A build that shipped
    // without it would leave `codex` wrapped by a file that is not there.
    for (const platform of ["darwin", "win32"] as const) {
      const targets = launcherTargets(platform);
      expect(statSync(targets.claude).isFile()).toBe(true);
      expect(statSync(targets.codex).isFile()).toBe(true);
      expect(targets.claude).not.toBe(targets.codex);
    }
  });

  it("gives the launchers everything they import", () => {
    // Both are front ends over the same modules, and a missing one fails at
    // the moment someone types `codex`, not at build time.
    const python = findPython();
    expect(python).not.toBeNull();
    const [command, ...args] = python as [string, ...string[]];
    expect(() =>
      execFileSync(command, [
        ...args,
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(BIN)}); import tf_wrap, tf_reserve, tf_bar, tf_draft, tf_paths`,
      ]),
    ).not.toThrow();
  });
});

/**
 * The path rule crosses a language boundary.
 *
 * `tf-claude` writes the draft file and the status line reads it, and they
 * compute where it lives from two separate implementations. Disagreement has
 * no symptom: both sides work, the bar simply never mentions a draft.
 */
describe("draft directory parity with the Python launcher", () => {
  const CASES = [
    { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, home: "C:\\Users\\ada" },
    { platform: "win32", env: {}, home: "C:\\Users\\ada" },
    { platform: "win32", env: { LOCALAPPDATA: "  " }, home: "C:\\Users\\ada" },
    { platform: "darwin", env: {}, home: "/Users/ada" },
    { platform: "linux", env: {}, home: "/home/ada" },
    { platform: "linux", env: { XDG_STATE_HOME: "/run/state" }, home: "/home/ada" },
    { platform: "darwin", env: { TOKEN_FORECASTER_DATA_DIR: "/tmp/tf" }, home: "/Users/ada" },
    { platform: "win32", env: { TOKEN_FORECASTER_DATA_DIR: "D:\\tf" }, home: "C:\\Users\\ada" },
  ] as const;

  it("resolves the same directory in both languages, on every platform", () => {
    const python = findPython();
    expect(python, "Python 3 is required to run the launcher").not.toBeNull();
    const [command, ...args] = python as [string, ...string[]];
    const out = execFileSync(
      command,
      [
        ...args,
        "-c",
        [
          "import json,sys",
          `sys.path.insert(0, ${JSON.stringify(BIN)})`,
          "from tf_paths import data_dir, draft_dir",
          "cases = json.loads(sys.argv[1])",
          "print(json.dumps([[data_dir(c['platform'], c['env'], c['home']),",
          "                   draft_dir(c['platform'], c['env'], c['home'])] for c in cases]))",
        ].join("\n"),
        JSON.stringify(CASES),
      ],
      { encoding: "utf8" },
    );
    const fromPython = JSON.parse(out) as [string, string][];
    const fromTypeScript = CASES.map((c) => [defaultDataDir(c), draftDir(c)]);
    expect(fromPython).toEqual(fromTypeScript);
  });
});

describe("findPython", () => {
  it("tries the py launcher first on Windows and python3 first elsewhere", () => {
    expect(pythonCandidates("win32")[0]).toEqual(["py", "-3"]);
    expect(pythonCandidates("darwin")[0]).toEqual(["python3"]);
  });

  it("finds an interpreter on the machine running the tests", () => {
    expect(findPython()).not.toBeNull();
  });
});

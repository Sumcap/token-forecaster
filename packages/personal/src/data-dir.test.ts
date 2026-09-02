import { describe, expect, it } from "vitest";

import { defaultDataDir, draftDir } from "./data-dir.js";

/**
 * The directory rule, per platform.
 *
 * These assert exact strings on purpose. Four processes compute this path
 * independently — the daemon, the CLI, the status line and the Python launcher
 * — and a Mac that reads `~/Library/…` while the launcher writes to `~/.local/…`
 * is a bug with no symptom other than a forecast that never mentions a draft.
 */

const WINDOWS = { platform: "win32" as const, home: "C:\\Users\\ada" };
const MAC = { platform: "darwin" as const, home: "/Users/ada" };
const LINUX = { platform: "linux" as const, home: "/home/ada" };

describe("defaultDataDir", () => {
  it("uses Local AppData on Windows", () => {
    expect(defaultDataDir({ ...WINDOWS, env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" } })).toBe(
      "C:\\Users\\ada\\AppData\\Local\\TokenForecaster",
    );
  });

  it("derives Local AppData from the home directory when the variable is missing", () => {
    // A service account, a stripped environment, `runas`: LOCALAPPDATA is not
    // guaranteed, and falling back to the POSIX branch would put the database
    // in a directory named Library on a Windows machine.
    expect(defaultDataDir({ ...WINDOWS, env: {} })).toBe(
      "C:\\Users\\ada\\AppData\\Local\\TokenForecaster",
    );
    expect(defaultDataDir({ ...WINDOWS, env: { LOCALAPPDATA: "   " } })).toBe(
      "C:\\Users\\ada\\AppData\\Local\\TokenForecaster",
    );
  });

  it("uses Application Support on macOS", () => {
    expect(defaultDataDir({ ...MAC, env: {} })).toBe(
      "/Users/ada/Library/Application Support/TokenForecaster",
    );
  });

  it("follows XDG_STATE_HOME elsewhere", () => {
    expect(defaultDataDir({ ...LINUX, env: {} })).toBe("/home/ada/.local/state/token-forecaster");
    expect(defaultDataDir({ ...LINUX, env: { XDG_STATE_HOME: "/run/state" } })).toBe(
      "/run/state/token-forecaster",
    );
  });

  it("lets TOKEN_FORECASTER_DATA_DIR override every platform", () => {
    for (const base of [WINDOWS, MAC, LINUX]) {
      expect(defaultDataDir({ ...base, env: { TOKEN_FORECASTER_DATA_DIR: "D:\\tf" } })).toBe("D:\\tf");
    }
  });

  it("ignores a blank override rather than resolving to the current directory", () => {
    expect(defaultDataDir({ ...MAC, env: { TOKEN_FORECASTER_DATA_DIR: "" } })).toBe(
      "/Users/ada/Library/Application Support/TokenForecaster",
    );
  });

  it("separates draft files with the target platform's separator", () => {
    expect(draftDir({ ...WINDOWS, env: { LOCALAPPDATA: "C:\\a" } })).toBe("C:\\a\\TokenForecaster\\drafts");
    expect(draftDir({ ...MAC, env: {} })).toBe(
      "/Users/ada/Library/Application Support/TokenForecaster/drafts",
    );
  });
});

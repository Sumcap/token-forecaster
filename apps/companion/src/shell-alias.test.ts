import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_SUFFIX,
  aliasInstalled,
  ensureAliasOnFirstRun,
  installAlias,
  rcPathFor,
  uninstallAlias,
  withBlock,
  withoutBlock,
} from "./shell-alias.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rcFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-rc-"));
  dirs.push(dir);
  const path = join(dir, ".zshrc");
  if (content !== null) writeFileSync(path, content);
  return path;
}

/** A path that looks like a launcher but was never shipped. */
const MISSING_TARGET = "/opt/token-forecaster/bin/tf-claude";

/** A real executable, because ensureAliasOnFirstRun refuses to alias a ghost. */
function launcherFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-bin-"));
  dirs.push(dir);
  const path = join(dir, "tf-claude");
  writeFileSync(path, "#!/bin/sh\nexec claude \"$@\"\n", { mode: 0o755 });
  return path;
}

const TARGET = MISSING_TARGET;
const ORIGINAL = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n';

describe("rcPathFor", () => {
  it("knows zsh and bash, and refuses to guess at anything else", () => {
    expect(rcPathFor("/bin/zsh", "/home/x")).toBe("/home/x/.zshrc");
    expect(rcPathFor("/bin/bash", "/home/x")).toBe("/home/x/.bashrc");
    expect(rcPathFor("/usr/local/bin/fish", "/home/x")).toBeNull();
    expect(rcPathFor("", "/home/x")).toBeNull();
  });
});

describe("withBlock / withoutBlock", () => {
  it("round-trips a file back to exactly what it was", () => {
    expect(withoutBlock(withBlock(ORIGINAL, TARGET))).toBe(ORIGINAL);
  });

  it("round-trips an empty file too", () => {
    expect(withoutBlock(withBlock("", TARGET))).toBe("");
  });

  it("updates the existing block rather than stacking another", () => {
    const once = withBlock(ORIGINAL, TARGET);
    const twice = withBlock(once, "/elsewhere/tf-claude");
    expect(twice.match(/>>> token-forecaster >>>/g)).toHaveLength(1);
    expect(twice).toContain("/elsewhere/tf-claude");
    expect(withoutBlock(twice)).toBe(ORIGINAL);
  });

  it("leaves a file it does not own alone", () => {
    expect(withoutBlock(ORIGINAL)).toBe(ORIGINAL);
  });

  it("leaves half a block for a human rather than guessing", () => {
    const damaged = `${ORIGINAL}# >>> token-forecaster >>>\nclaude() { :; }\n`;
    expect(withoutBlock(damaged)).toBe(damaged);
  });
});

describe("surviving a deleted app", () => {
  it("falls back to the real claude when the launcher is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-fallback-"));
    dirs.push(dir);
    // A stand-in `claude` on PATH, and a launcher that does not exist.
    const fake = join(dir, "claude");
    writeFileSync(fake, "#!/bin/sh\necho real-claude \"$@\"\n", { mode: 0o755 });
    const rc = join(dir, ".zshrc");
    writeFileSync(rc, "");
    installAlias(rc, join(dir, "missing", "tf-claude"));
    const output = execFileSync(
      "sh",
      ["-c", `. ${JSON.stringify(rc)}; claude --version`],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` } },
    );
    expect(output.trim()).toBe("real-claude --version");
  });

  it("runs the launcher when it is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-fallback-"));
    dirs.push(dir);
    const launcher = join(dir, "tf-claude");
    writeFileSync(launcher, "#!/bin/sh\necho launcher \"$@\"\n", { mode: 0o755 });
    const rc = join(dir, ".zshrc");
    writeFileSync(rc, "");
    installAlias(rc, launcher);
    const output = execFileSync("sh", ["-c", `. ${JSON.stringify(rc)}; claude --resume`], {
      encoding: "utf8",
    });
    expect(output.trim()).toBe("launcher --resume");
  });
});

describe("installAlias / uninstallAlias", () => {
  it("installs, keeps the original, and restores it on the way out", () => {
    const rc = rcFile(ORIGINAL);
    const installed = installAlias(rc, TARGET);
    expect(installed.changed).toBe(true);
    expect(readFileSync(rc, "utf8")).toContain(TARGET);
    expect(aliasInstalled(rc)).toBe(true);
    expect(readFileSync(`${rc}${BACKUP_SUFFIX}`, "utf8")).toBe(ORIGINAL);

    const removed = uninstallAlias(rc);
    expect(removed.changed).toBe(true);
    expect(readFileSync(rc, "utf8")).toBe(ORIGINAL);
    // Restored, so the copy of the user's shell config is not left behind.
    expect(existsSync(`${rc}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it("is a no-op when run twice", () => {
    const rc = rcFile(ORIGINAL);
    installAlias(rc, TARGET);
    const again = installAlias(rc, TARGET);
    expect(again.changed).toBe(false);
    expect(again.message).toBe("already installed");
  });

  it("keeps edits made after the install", () => {
    const rc = rcFile(ORIGINAL);
    installAlias(rc, TARGET);
    writeFileSync(rc, `${readFileSync(rc, "utf8")}export LATER=1\n`);
    uninstallAlias(rc);
    const after = readFileSync(rc, "utf8");
    expect(after).toBe(`${ORIGINAL}export LATER=1\n`);
    // The file no longer matches the backup, so the backup stays.
    expect(existsSync(`${rc}${BACKUP_SUFFIX}`)).toBe(true);
  });

  it("creates a startup file when the shell has none", () => {
    const rc = rcFile(null);
    expect(installAlias(rc, TARGET).changed).toBe(true);
    expect(readFileSync(rc, "utf8")).toContain(TARGET);
    uninstallAlias(rc);
    expect(readFileSync(rc, "utf8")).toBe("");
  });

  it("says so when there is nothing to remove", () => {
    const rc = rcFile(ORIGINAL);
    expect(uninstallAlias(rc).message).toBe("nothing to remove");
    expect(readFileSync(rc, "utf8")).toBe(ORIGINAL);
  });
});

describe("ensureAliasOnFirstRun", () => {
  it("sets the block up on a clean install, without being asked", () => {
    const rc = rcFile(ORIGINAL);
    let decided = false;
    const result = ensureAliasOnFirstRun({
      alreadyDecided: false,
      rcPath: rc,
      target: launcherFile(),
      markDecided: () => {
        decided = true;
      },
    });
    expect(result?.changed).toBe(true);
    expect(decided).toBe(true);
    expect(aliasInstalled(rc)).toBe(true);
  });

  it("writes nothing, and decides nothing, when the launcher was not shipped", () => {
    // A bundle built without bin/tf-claude used to write a block pointing at a
    // path that will never exist. The `[ -x ]` guard in the block swallowed it,
    // so `claude` kept working and the draft forecast silently never fired --
    // and because the one shot had been spent, a fixed build could not repair
    // it. Refusing to decide is what lets the next launch fix itself.
    const rc = rcFile(ORIGINAL);
    const result = ensureAliasOnFirstRun({
      alreadyDecided: false,
      rcPath: rc,
      target: MISSING_TARGET,
      markDecided: () => {
        throw new Error("must not spend the one shot on a missing launcher");
      },
    });
    expect(result).toBeNull();
    expect(aliasInstalled(rc)).toBe(false);
    expect(readFileSync(rc, "utf8")).toBe(ORIGINAL);
  });

  it("installs on a later start once the launcher is actually there", () => {
    const rc = rcFile(ORIGINAL);
    let decided = false;
    const markDecided = (): void => {
      decided = true;
    };
    // First start: broken bundle, nothing decided.
    ensureAliasOnFirstRun({ alreadyDecided: false, rcPath: rc, target: MISSING_TARGET, markDecided });
    expect(decided).toBe(false);
    // Second start: fixed bundle, and the install still happens.
    const result = ensureAliasOnFirstRun({
      alreadyDecided: decided,
      rcPath: rc,
      target: launcherFile(),
      markDecided,
    });
    expect(result?.changed).toBe(true);
    expect(decided).toBe(true);
    expect(aliasInstalled(rc)).toBe(true);
  });

  it("never puts it back for someone who switched it off", () => {
    const rc = rcFile(ORIGINAL);
    const result = ensureAliasOnFirstRun({
      alreadyDecided: true,
      rcPath: rc,
      target: TARGET,
      markDecided: () => {
        throw new Error("must not re-decide");
      },
    });
    expect(result).toBeNull();
    expect(aliasInstalled(rc)).toBe(false);
  });

  it("counts an unwritable shell as decided rather than retrying every start", () => {
    let decided = false;
    const result = ensureAliasOnFirstRun({
      alreadyDecided: false,
      rcPath: null,
      target: launcherFile(),
      markDecided: () => {
        decided = true;
      },
    });
    expect(result).toBeNull();
    expect(decided).toBe(true);
  });
});

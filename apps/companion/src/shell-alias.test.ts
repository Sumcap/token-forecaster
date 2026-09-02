import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_SUFFIX,
  BEGIN_MARKER,
  aliasInstalled,
  block,
  ensureAliasOnFirstRun,
  installAlias,
  powerShellProfilePath,
  rcPathFor,
  shellTargetFor,
  shippedTargets,
  syntaxFor,
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

/**
 * One launcher, in the shape the writer takes them.
 *
 * The block wraps every CLI it has a launcher for, so the argument is a map;
 * most of what is asserted below is about one wrapper at a time.
 */
function wrapping(target: string) {
  return { claude: target };
}
const ORIGINAL = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n';

describe("rcPathFor", () => {
  it("knows zsh and bash, and refuses to guess at anything else", () => {
    expect(rcPathFor("/bin/zsh", "/home/x")).toBe("/home/x/.zshrc");
    expect(rcPathFor("/bin/bash", "/home/x")).toBe("/home/x/.bashrc");
    expect(rcPathFor("/usr/local/bin/fish", "/home/x")).toBeNull();
    expect(rcPathFor("", "/home/x")).toBeNull();
  });
});

/** A Windows machine, described entirely by what the resolver is allowed to see. */
const WINDOWS = {
  platform: "win32" as const,
  home: "C:\\Users\\ada",
  env: { USERPROFILE: "C:\\Users\\ada" } as Record<string, string | undefined>,
};
const DOCS = "C:\\Users\\ada\\Documents";
const PWSH7 = `${DOCS}\\PowerShell\\Microsoft.PowerShell_profile.ps1`;
const PWSH5 = `${DOCS}\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`;

/** Pretend exactly these paths exist. */
const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe("shellTargetFor on Windows", () => {
  it("writes a PowerShell profile, whatever SHELL happens to say", () => {
    // Git Bash sets SHELL on Windows, but the launcher it would point at is a
    // .cmd and the shell Claude Code is started from is almost never that one.
    const target = shellTargetFor({
      ...WINDOWS,
      env: { ...WINDOWS.env, SHELL: "/usr/bin/bash" },
      exists: only(),
    });
    expect(target).toEqual({ rcPath: PWSH5, syntax: "powershell" });
  });

  it("prefers the PowerShell it is running under", () => {
    // pwsh sets this on every session it starts, including the one that
    // started the daemon. A profile written to the other PowerShell is valid
    // and simply never loaded, which is the failure this avoids.
    expect(
      powerShellProfilePath({
        ...WINDOWS,
        env: { ...WINDOWS.env, POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 11 Pro" },
        exists: only(),
      }),
    ).toBe(PWSH7);
  });

  it("otherwise writes to the profile that already exists", () => {
    expect(powerShellProfilePath({ ...WINDOWS, exists: only(PWSH5) })).toBe(PWSH5);
    expect(powerShellProfilePath({ ...WINDOWS, exists: only(PWSH7) })).toBe(PWSH7);
  });

  it("takes an installed PowerShell 7 over the 5.1 that is always there", () => {
    expect(
      powerShellProfilePath({ ...WINDOWS, exists: only(`${DOCS}\\PowerShell`) }),
    ).toBe(PWSH7);
  });

  it("follows Documents into OneDrive when it has been redirected there", () => {
    // Known Folder Move is on by default on a lot of machines. A profile
    // written to the un-redirected path is a file PowerShell never reads.
    const oneDrive = "C:\\Users\\ada\\OneDrive";
    expect(
      powerShellProfilePath({
        ...WINDOWS,
        env: { ...WINDOWS.env, OneDrive: oneDrive },
        exists: only(`${oneDrive}\\Documents`),
      }),
    ).toBe(`${oneDrive}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`);
  });

  it("still refuses to guess at an unknown POSIX shell", () => {
    expect(shellTargetFor({ platform: "linux", home: "/home/x", env: { SHELL: "/bin/fish" } })).toBeNull();
    expect(shellTargetFor({ platform: "darwin", home: "/home/x", env: { SHELL: "/bin/zsh" } })).toEqual({
      rcPath: "/home/x/.zshrc",
      syntax: "posix",
    });
  });
});

describe("syntaxFor", () => {
  it("reads the language off the file name, so --rc needs no second flag", () => {
    expect(syntaxFor("C:\\Users\\ada\\Microsoft.PowerShell_profile.ps1")).toBe("powershell");
    expect(syntaxFor("/home/x/.zshrc")).toBe("posix");
    expect(syntaxFor("/home/x/.bash_profile")).toBe("posix");
  });
});

describe("the PowerShell block", () => {
  const PS_TARGET = "C:\\Program Files\\TokenForecaster\\bin\\tf-claude.cmd";

  it("round-trips a profile back to exactly what it was", () => {
    const before = "Set-Alias ll Get-ChildItem\n";
    expect(withoutBlock(withBlock(before, wrapping(PS_TARGET), "powershell"))).toBe(before);
  });

  it("leaves no blank line behind in a CRLF profile", () => {
    // PowerShell profiles are usually CRLF, so the blank line this adds ahead
    // of its block is four characters, not two.
    const before = "Set-Alias ll Get-ChildItem\r\n";
    expect(withoutBlock(withBlock(before, wrapping(PS_TARGET), "powershell"))).toBe(before);
  });

  it("quotes a path PowerShell would otherwise interpret", () => {
    // Backslashes are not escapes in PowerShell and a single-quoted string
    // expands nothing, so `$` in a user name is inert -- but a quote in the
    // path would end the string, and that has one escape: doubling it.
    const awkward = "C:\\Users\\o'brien\\$env\\tf-claude.cmd";
    const rendered = block(wrapping(awkward), "powershell");
    expect(rendered).toContain("'C:\\Users\\o''brien\\$env\\tf-claude.cmd'");
  });

  it("cannot recurse into itself when the launcher is missing", () => {
    // `Get-Command -CommandType Application` never resolves to a function, so
    // the fallback reaches the real claude rather than this block again.
    const rendered = block(wrapping(PS_TARGET), "powershell");
    expect(rendered).toContain("-CommandType Application");
    expect(rendered).toContain("Test-Path -LiteralPath $tf -PathType Leaf");
  });
});

/** `pwsh` (or Windows PowerShell), when this machine has one. */
function findPowerShell(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    try {
      execFileSync(candidate, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Not installed, or not this one.
    }
  }
  return null;
}

const POWERSHELL = findPowerShell();

/**
 * The block, actually executed.
 *
 * Skipped on a machine with no PowerShell, which is most Macs — it exists to
 * run on Windows, where every one of these branches is the only thing standing
 * between a deleted app and a `claude` that no longer starts.
 */
describe.skipIf(POWERSHELL === null)("the PowerShell block, run by PowerShell", () => {
  const shell = POWERSHELL ?? "pwsh";
  const windows = process.platform === "win32";

  /** An executable that echoes its name and arguments, in this OS's dialect. */
  function fakeProgram(dir: string, name: string): string {
    const path = join(dir, windows ? `${name}.cmd` : name);
    if (windows) writeFileSync(path, `@echo off\r\necho ${name} %*\r\n`);
    else writeFileSync(path, `#!/bin/sh\necho ${name} "$@"\n`, { mode: 0o755 });
    return path;
  }

  function runWithProfile(profile: string, command: string, pathDir: string): string {
    return execFileSync(shell, ["-NoProfile", "-Command", `. '${profile}'; ${command}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${pathDir}${windows ? ";" : ":"}${process.env["PATH"] ?? ""}`,
      },
    });
  }

  it("runs the launcher when it is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-ps-run-"));
    dirs.push(dir);
    const launcher = fakeProgram(dir, "tf-claude");
    const profile = join(dir, "profile.ps1");
    installAlias(profile, wrapping(launcher));
    expect(runWithProfile(profile, "claude --resume", dir).trim()).toBe("tf-claude --resume");
  });

  it("falls back to the real claude when the launcher is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-ps-gone-"));
    dirs.push(dir);
    fakeProgram(dir, "claude");
    const profile = join(dir, "profile.ps1");
    installAlias(profile, wrapping(join(dir, "missing", "tf-claude.cmd")));
    expect(runWithProfile(profile, "claude --version", dir).trim()).toBe("claude --version");
  });
});

describe("installing into a PowerShell profile", () => {
  it("infers the syntax from the file name and creates the missing directory", () => {
    // A machine that has never run PowerShell 7 has the profile directory
    // missing, not just the profile.
    const dir = mkdtempSync(join(tmpdir(), "tf-ps-"));
    dirs.push(dir);
    const profile = join(dir, "PowerShell", "Microsoft.PowerShell_profile.ps1");
    const installed = installAlias(profile, wrapping("C:\\tf\\tf-claude.cmd"));
    expect(installed.changed).toBe(true);
    const written = readFileSync(profile, "utf8");
    expect(written).toContain("function claude {");
    expect(written).not.toContain("claude() {");
    expect(aliasInstalled(profile)).toBe(true);
    expect(uninstallAlias(profile).changed).toBe(true);
    expect(readFileSync(profile, "utf8")).toBe("");
  });
});

describe("wrapping both CLIs", () => {
  it("writes one function per launcher, in one block", () => {
    // One block, not two: install, update and uninstall all find their work by
    // the same pair of markers, and a second block would be a second thing to
    // remove from someone's shell config.
    const rendered = block({ claude: "/tf/tf-claude", codex: "/tf/tf-codex" });
    expect(rendered).toContain("claude() {");
    expect(rendered).toContain("codex() {");
    expect(rendered.indexOf(BEGIN_MARKER)).toBe(0);
    expect(rendered.split(BEGIN_MARKER)).toHaveLength(2);
  });

  it("falls back to the real command per CLI, without recursing", () => {
    const rendered = block({ claude: "/tf/tf-claude", codex: "/tf/tf-codex" });
    expect(rendered).toContain('command codex "$@"');
    expect(rendered).toContain('command claude "$@"');
  });

  it("writes no wrapper for a CLI this build has no launcher for", () => {
    // A bundle built before tf-codex existed still installs a working `claude`.
    // What it must not write is a `codex` function around a file that is not
    // there, which would shell out through the guard on every invocation.
    const rendered = block({ claude: "/tf/tf-claude", codex: null });
    expect(rendered).toContain("claude() {");
    expect(rendered).not.toContain("codex() {");
  });

  it("keeps only the launchers that were actually shipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-shipped-"));
    dirs.push(dir);
    const claude = join(dir, "tf-claude");
    writeFileSync(claude, "#!/bin/sh\n", { mode: 0o755 });
    expect(shippedTargets({ claude, codex: join(dir, "tf-codex") }, "darwin")).toEqual({ claude });
  });
});

describe("withBlock / withoutBlock", () => {
  it("round-trips a file back to exactly what it was", () => {
    expect(withoutBlock(withBlock(ORIGINAL, wrapping(TARGET)))).toBe(ORIGINAL);
  });

  it("round-trips an empty file too", () => {
    expect(withoutBlock(withBlock("", wrapping(TARGET)))).toBe("");
  });

  it("updates the existing block rather than stacking another", () => {
    const once = withBlock(ORIGINAL, wrapping(TARGET));
    const twice = withBlock(once, wrapping("/elsewhere/tf-claude"));
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
    installAlias(rc, wrapping(join(dir, "missing", "tf-claude")));
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
    installAlias(rc, wrapping(launcher));
    const output = execFileSync("sh", ["-c", `. ${JSON.stringify(rc)}; claude --resume`], {
      encoding: "utf8",
    });
    expect(output.trim()).toBe("launcher --resume");
  });
});

describe("installAlias / uninstallAlias", () => {
  it("installs, keeps the original, and restores it on the way out", () => {
    const rc = rcFile(ORIGINAL);
    const installed = installAlias(rc, wrapping(TARGET));
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
    installAlias(rc, wrapping(TARGET));
    const again = installAlias(rc, wrapping(TARGET));
    expect(again.changed).toBe(false);
    expect(again.message).toBe("already installed");
  });

  it("keeps edits made after the install", () => {
    const rc = rcFile(ORIGINAL);
    installAlias(rc, wrapping(TARGET));
    writeFileSync(rc, `${readFileSync(rc, "utf8")}export LATER=1\n`);
    uninstallAlias(rc);
    const after = readFileSync(rc, "utf8");
    expect(after).toBe(`${ORIGINAL}export LATER=1\n`);
    // The file no longer matches the backup, so the backup stays.
    expect(existsSync(`${rc}${BACKUP_SUFFIX}`)).toBe(true);
  });

  it("creates a startup file when the shell has none", () => {
    const rc = rcFile(null);
    expect(installAlias(rc, wrapping(TARGET)).changed).toBe(true);
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
      targets: wrapping(launcherFile()),
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
      targets: wrapping(MISSING_TARGET),
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
    ensureAliasOnFirstRun({ alreadyDecided: false, rcPath: rc, targets: wrapping(MISSING_TARGET), markDecided });
    expect(decided).toBe(false);
    // Second start: fixed bundle, and the install still happens.
    const result = ensureAliasOnFirstRun({
      alreadyDecided: decided,
      rcPath: rc,
      targets: wrapping(launcherFile()),
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
      targets: wrapping(TARGET),
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
      targets: wrapping(launcherFile()),
      markDecided: () => {
        decided = true;
      },
    });
    expect(result).toBeNull();
    expect(decided).toBe(true);
  });
});

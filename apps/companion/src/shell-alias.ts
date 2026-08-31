import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, win32 } from "node:path";

/**
 * Point `claude` at the draft-aware launcher, reversibly.
 *
 * The draft forecast needs Claude Code started through `bin/tf-claude`, and
 * nobody is going to type that every time — so this writes an alias into the
 * shell's startup file. Everything it writes sits between two markers and a
 * copy of the original is kept beside it, because a tool that edits your shell
 * config has to be able to put it back exactly as it found it.
 *
 * Two syntaxes, because the same job on Windows is a PowerShell profile rather
 * than an rc file. The markers are identical — `#` starts a comment in both —
 * so everything that finds, replaces or removes the block is shared, and only
 * the six lines in the middle differ.
 */

export const BEGIN_MARKER = "# >>> token-forecaster >>>";
export const END_MARKER = "# <<< token-forecaster <<<";
/** Suffix for the copy taken before the first edit. */
export const BACKUP_SUFFIX = ".token-forecaster-backup";

/** Which language the block has to be written in. */
export type ShellSyntax = "posix" | "powershell";

/** A startup file, and the syntax its shell reads. */
export interface ShellTarget {
  rcPath: string;
  syntax: ShellSyntax;
}

/** The startup file for `shell`, or null when its syntax is not ours to write. */
export function rcPathFor(shell: string, home: string = homedir()): string | null {
  const name = shell.split("/").pop() ?? "";
  if (name.includes("zsh")) return join(home, ".zshrc");
  if (name.includes("bash")) {
    // macOS logs in through .bash_profile; Linux distributions use .bashrc.
    const profile = join(home, ".bash_profile");
    return existsSync(profile) ? profile : join(home, ".bashrc");
  }
  // fish and friends need different syntax, and guessing at it would leave a
  // broken startup file behind.
  return null;
}

/** Overrides for {@link shellTargetFor}. Tests and nothing else. */
export interface ShellLookup {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Injectable so the Windows rules can be tested from a Mac. */
  exists?: (path: string) => boolean;
}

/**
 * Windows keeps PowerShell profiles under Documents, which is not always
 * under the home directory: OneDrive's Known Folder Move redirects it, and a
 * profile written to the un-redirected path is a file PowerShell never reads.
 */
function documentsDir(env: Record<string, string | undefined>, home: string, exists: (p: string) => boolean): string {
  const oneDrive = env["OneDrive"] ?? env["OneDriveConsumer"] ?? env["OneDriveCommercial"];
  if (oneDrive && oneDrive.trim()) {
    const redirected = win32.join(oneDrive.trim(), "Documents");
    if (exists(redirected)) return redirected;
  }
  return win32.join(env["USERPROFILE"]?.trim() || home, "Documents");
}

/**
 * The PowerShell profile to write.
 *
 * Two PowerShells are installed on a normal Windows machine and they do not
 * share a profile: PowerShell 7 (`pwsh`) reads `Documents\PowerShell`, Windows
 * PowerShell 5.1 reads `Documents\WindowsPowerShell`. Picking the wrong one is
 * silent — the profile is valid, it is simply never loaded — so this prefers,
 * in order: the shell we are actually running under, a profile that already
 * exists, an installed PowerShell 7, and finally 5.1, which is always there.
 */
export function powerShellProfilePath(lookup: ShellLookup = {}): string {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();
  const exists = lookup.exists ?? existsSync;
  const documents = documentsDir(env, home, exists);
  const seven = win32.join(documents, "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const five = win32.join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");

  // pwsh sets this on every session it starts, including the one that started
  // this daemon. Nothing else does.
  if (env["POWERSHELL_DISTRIBUTION_CHANNEL"]) return seven;
  if (exists(seven)) return seven;
  if (exists(five)) return five;
  if (exists(win32.dirname(seven))) return seven;
  return five;
}

/**
 * Where to write the block on this machine, and in which language.
 *
 * On Windows the answer is a PowerShell profile even when `SHELL` is set:
 * `SHELL` under Git Bash describes a shell that Claude Code is rarely started
 * from, and the launcher this points at is a `.cmd` either way.
 */
export function shellTargetFor(lookup: ShellLookup = {}): ShellTarget | null {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  if (platform === "win32") {
    return { rcPath: powerShellProfilePath(lookup), syntax: "powershell" };
  }
  const rcPath = rcPathFor(env["SHELL"] ?? "", lookup.home ?? homedir());
  return rcPath === null ? null : { rcPath, syntax: "posix" };
}

/** The syntax implied by a startup file's name, for a `--rc` path given by hand. */
export function syntaxFor(rcPath: string): ShellSyntax {
  return extname(rcPath).toLowerCase() === ".ps1" ? "powershell" : "posix";
}

const HEADING = [
  "# Runs Claude Code through the draft-aware launcher, so the status line can",
  "# forecast the prompt being typed. Remove with: token-forecaster uninstall-shell",
];

/** `text` as a PowerShell single-quoted string, which has exactly one escape. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The block this tool owns, for `target`.
 *
 * A function rather than an alias, because the app can be dragged to the Trash
 * without anyone remembering to run the uninstall first: a bare
 * `alias claude=/path/that/is/gone` would break `claude` outright. This falls
 * back to the real thing whenever the launcher is missing, so the worst case of
 * a deleted app is a status line that stops forecasting drafts. `command`
 * bypasses this function, so the fallback cannot recurse.
 */
export function block(target: string, syntax: ShellSyntax = "posix"): string {
  if (syntax === "powershell") {
    return [
      BEGIN_MARKER,
      ...HEADING,
      "function claude {",
      `  $tf = ${psQuote(target)}`,
      "  if (Test-Path -LiteralPath $tf -PathType Leaf) {",
      "    & $tf @args",
      "  } else {",
      // -CommandType Application cannot resolve to this function, so the
      // fallback cannot recurse -- the PowerShell equivalent of `command`.
      "    $real = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |",
      "      Select-Object -First 1",
      "    if ($real) { & $real.Source @args }",
      "    else { Write-Error 'claude was not found on PATH' }",
      "  }",
      "}",
      END_MARKER,
    ].join("\n");
  }
  return [
    BEGIN_MARKER,
    ...HEADING,
    "claude() {",
    `  if [ -x ${JSON.stringify(target)} ]; then`,
    `    command ${JSON.stringify(target)} "$@"`,
    "  else",
    '    command claude "$@"',
    "  fi",
    "}",
    END_MARKER,
  ].join("\n");
}

/** `content` with our block added or updated, leaving everything else alone. */
export function withBlock(content: string, target: string, syntax: ShellSyntax = "posix"): string {
  const without = withoutBlock(content);
  const body = without.length === 0 || /\n$/.test(without) ? without : `${without}\n`;
  return `${body}${body.length === 0 ? "" : "\n"}${block(target, syntax)}\n`;
}

/** `content` with our block removed, and no trace of the gap it left. */
export function withoutBlock(content: string): string {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return content;
  const endMarker = content.indexOf(END_MARKER, start);
  if (endMarker === -1) return content; // Half a block: leave it for a human.
  let end = content.indexOf("\n", endMarker + END_MARKER.length);
  end = end === -1 ? content.length : end + 1;
  // Take the blank line we added ahead of the block with us. PowerShell
  // profiles are usually CRLF, so the blank line may be four characters.
  let head = content.slice(0, start);
  if (head.endsWith("\r\n\r\n")) head = head.slice(0, -2);
  else if (head.endsWith("\n\n")) head = head.slice(0, -1);
  return head + content.slice(end);
}

/** Whether this tool's block is currently in `rcPath`. */
export function aliasInstalled(rcPath: string): boolean {
  try {
    return readFileSync(rcPath, "utf8").includes(BEGIN_MARKER);
  } catch {
    return false;
  }
}

/**
 * Put the block in place on a clean install, once.
 *
 * Forecasting the prompt being typed is what this app is for, and it cannot do
 * it for a session that was not started through the launcher — so a fresh
 * install sets it up rather than offering to. It runs exactly once: the flag is
 * set whether or not the write succeeded, so someone who turns it off in
 * Settings never finds it back the next morning.
 */
export function ensureAliasOnFirstRun(options: {
  alreadyDecided: boolean;
  rcPath: string | null;
  target: string;
  markDecided: () => void;
  platform?: NodeJS.Platform;
}): AliasResult | null {
  if (options.alreadyDecided) return null;
  // A build that shipped without the launcher must not burn the one shot: the
  // block would point at a path that will never exist, the `[ -x ]` guard would
  // swallow it, and a later fixed build would never rewrite it because the flag
  // was already set. No launcher means no decision yet.
  if (!isExecutableFile(options.target, options.platform ?? process.platform)) return null;
  options.markDecided();
  if (!options.rcPath) return null;
  try {
    return installAlias(options.rcPath, options.target);
  } catch {
    // A read-only or exotic home directory is not a reason to fail to start.
    return null;
  }
}

/** Extensions Windows will run without being told how. */
const WINDOWS_EXECUTABLE = new Set([".cmd", ".bat", ".exe", ".com"]);

/** True when `path` is a regular file the current user can execute. */
function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // NTFS has no execute bit, and `access(X_OK)` on Windows answers a question
    // about reading. What decides whether a file can be run is its extension.
    if (platform === "win32") return WINDOWS_EXECUTABLE.has(extname(path).toLowerCase());
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AliasResult {
  rcPath: string;
  backupPath: string | null;
  changed: boolean;
  message: string;
}

/**
 * Write the alias into the shell startup file. Safe to run twice.
 *
 * The syntax follows the file's name: a `.ps1` is PowerShell, anything else is
 * a POSIX rc file. That is the whole rule, so `--rc some/path.ps1` needs no
 * second flag to go with it.
 */
export function installAlias(
  rcPath: string,
  target: string,
  syntax: ShellSyntax = syntaxFor(rcPath),
): AliasResult {
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  const updated = withBlock(existing, target, syntax);
  if (updated === existing) {
    return { rcPath, backupPath: null, changed: false, message: "already installed" };
  }
  // One backup, taken before the first edit, so it is the file as it was
  // before this tool ever touched it.
  const backupPath = `${rcPath}${BACKUP_SUFFIX}`;
  let backedUp: string | null = null;
  if (existsSync(rcPath) && !existsSync(backupPath)) {
    copyFileSync(rcPath, backupPath);
    backedUp = backupPath;
  } else if (existsSync(backupPath)) {
    backedUp = backupPath;
  }
  // A machine that has never run PowerShell 7 has no profile *directory*, let
  // alone a profile; the rc-file case has had one since the home directory
  // existed, so this only ever does anything on Windows.
  mkdirSync(dirname(rcPath), { recursive: true });
  writeFileSync(rcPath, updated);
  return { rcPath, backupPath: backedUp, changed: true, message: "installed" };
}

/** Take the alias back out, leaving any other edits untouched. */
export function uninstallAlias(rcPath: string): AliasResult {
  if (!existsSync(rcPath)) {
    return { rcPath, backupPath: null, changed: false, message: "nothing to remove" };
  }
  const existing = readFileSync(rcPath, "utf8");
  const updated = withoutBlock(existing);
  const backupPath = `${rcPath}${BACKUP_SUFFIX}`;
  if (updated === existing) {
    return { rcPath, backupPath: null, changed: false, message: "nothing to remove" };
  }
  writeFileSync(rcPath, updated);
  // The backup exists to prove the file can be restored; once the file matches
  // it again, keeping a stale copy of someone's shell config is just litter.
  let kept: string | null = backupPath;
  if (existsSync(backupPath)) {
    if (readFileSync(backupPath, "utf8") === updated) {
      unlinkSync(backupPath);
      kept = null;
    }
  } else {
    kept = null;
  }
  return { rcPath, backupPath: kept, changed: true, message: "removed" };
}

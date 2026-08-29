import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Point `claude` at the draft-aware launcher, reversibly.
 *
 * The draft forecast needs Claude Code started through `bin/tf-claude`, and
 * nobody is going to type that every time — so this writes an alias into the
 * shell's startup file. Everything it writes sits between two markers and a
 * copy of the original is kept beside it, because a tool that edits your shell
 * config has to be able to put it back exactly as it found it.
 */

export const BEGIN_MARKER = "# >>> token-forecaster >>>";
export const END_MARKER = "# <<< token-forecaster <<<";
/** Suffix for the copy taken before the first edit. */
export const BACKUP_SUFFIX = ".token-forecaster-backup";

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
export function block(target: string): string {
  return [
    BEGIN_MARKER,
    "# Runs Claude Code through the draft-aware launcher, so the status line can",
    "# forecast the prompt being typed. Remove with: token-forecaster uninstall-shell",
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
export function withBlock(content: string, target: string): string {
  const without = withoutBlock(content);
  const body = without.length === 0 || without.endsWith("\n") ? without : `${without}\n`;
  return `${body}${body.length === 0 ? "" : "\n"}${block(target)}\n`;
}

/** `content` with our block removed, and no trace of the gap it left. */
export function withoutBlock(content: string): string {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return content;
  const endMarker = content.indexOf(END_MARKER, start);
  if (endMarker === -1) return content; // Half a block: leave it for a human.
  let end = content.indexOf("\n", endMarker + END_MARKER.length);
  end = end === -1 ? content.length : end + 1;
  // Take the blank line we added ahead of the block with us.
  let head = content.slice(0, start);
  if (head.endsWith("\n\n")) head = head.slice(0, -1);
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
}): AliasResult | null {
  if (options.alreadyDecided) return null;
  options.markDecided();
  if (!options.rcPath) return null;
  try {
    return installAlias(options.rcPath, options.target);
  } catch {
    // A read-only or exotic home directory is not a reason to fail to start.
    return null;
  }
}

export interface AliasResult {
  rcPath: string;
  backupPath: string | null;
  changed: boolean;
  message: string;
}

/** Write the alias into the shell startup file. Safe to run twice. */
export function installAlias(rcPath: string, target: string): AliasResult {
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  const updated = withBlock(existing, target);
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

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the Codex sessions root: `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export function defaultCodexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["CODEX_HOME"];
  if (home && home.length > 0) return join(home, "sessions");
  return join(homedir(), ".codex", "sessions");
}

/** A transcript file found on disk, with the identity fields used for indexing. */
export interface TranscriptFile {
  path: string;
  /** Device+inode, so a rename does not force a re-scan. */
  fileKey: string;
  size: number;
  mtimeMs: number;
}

/**
 * Recursively list `*.jsonl` transcripts under `root`.
 *
 * Returns an empty list when `root` does not exist — an absent history
 * directory is a normal "source unavailable" state, not an error.
 */
export async function listTranscripts(root: string): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  await walk(root, out);
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

async function walk(dir: string, out: TranscriptFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const s = await stat(full);
      out.push({
        path: full,
        fileKey: `${s.dev}:${s.ino}`,
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // Raced with a delete; the next scan will settle it.
    }
  }
}

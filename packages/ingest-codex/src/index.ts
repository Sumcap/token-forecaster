import { readFile } from "node:fs/promises";

import {
  emptyImportStats,
  mergeImportStats,
  type ImportStats,
  type UsageObservation,
} from "@token-forecaster/core";

import { parseCodexRollout } from "./parse.js";
import { defaultCodexSessionsDir, listTranscripts, type TranscriptFile } from "./scan.js";

export { parseCodexRollout } from "./parse.js";
export type { ParseCodexOptions, ParseCodexResult } from "./parse.js";
export { defaultCodexSessionsDir, listTranscripts } from "./scan.js";
export type { TranscriptFile } from "./scan.js";

/** Options for {@link importCodexHistory}. */
export interface ImportCodexOptions {
  /** Sessions root. Defaults to `$CODEX_HOME/sessions` or `~/.codex/sessions`. */
  sessionsDir?: string;
  /** Per-install salt for prompt-feature hashes. */
  salt: string;
  /**
   * Resume state from a previous run, keyed by `fileKey`. A file whose size and
   * mtime are unchanged is skipped entirely; a file that grew is parsed from its
   * recorded offset.
   */
  cursors?: ReadonlyMap<string, { size: number; mtimeMs: number; offset: number }>;
  /** Called after each file so a long backfill can report progress. */
  onFile?: (file: TranscriptFile, index: number, total: number) => void;
}

/** Result of a full or incremental Codex import. */
export interface ImportCodexResult {
  observations: UsageObservation[];
  stats: ImportStats;
  /** New cursor state to persist, keyed by `fileKey`. */
  cursors: Map<string, { size: number; mtimeMs: number; offset: number }>;
  sessionsDir: string;
  /** Files that were unchanged since the last run and therefore not re-read. */
  filesSkippedUnchanged: number;
}

/**
 * Import Codex rollout transcripts into privacy-safe usage observations.
 *
 * Reads only; never writes to or deletes anything under the sessions
 * directory. Prompt text is reduced to features inside {@link parseCodexRollout}
 * and never leaves it.
 */
export async function importCodexHistory(
  options: ImportCodexOptions,
): Promise<ImportCodexResult> {
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir();
  const files = await listTranscripts(sessionsDir);
  const stats = emptyImportStats();
  const observations: UsageObservation[] = [];
  const cursors = new Map<string, { size: number; mtimeMs: number; offset: number }>(
    options.cursors ?? [],
  );
  let filesSkippedUnchanged = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    options.onFile?.(file, i, files.length);
    const prior = cursors.get(file.fileKey);
    if (prior && prior.size === file.size && prior.mtimeMs === file.mtimeMs) {
      filesSkippedUnchanged += 1;
      continue;
    }

    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch {
      stats.filesFailed += 1;
      continue;
    }

    // A truncated or rewritten file (smaller than the cursor) must be re-read
    // in full rather than resumed at a stale offset.
    const fromOffset = prior && file.size >= prior.size ? prior.offset : 0;
    const result = parseCodexRollout(text, {
      sourceFile: file.path,
      salt: options.salt,
      fromOffset,
    });
    observations.push(...result.observations);
    mergeImportStats(stats, result.stats);
    cursors.set(file.fileKey, {
      size: file.size,
      mtimeMs: file.mtimeMs,
      offset: result.endOffset,
    });
  }

  // Report the transcripts this source has, not just the ones re-read: a status
  // line saying "0 files" after a no-op incremental scan reads as a broken
  // connection rather than an up-to-date one.
  stats.filesScanned = files.length;
  return { observations, stats, cursors, sessionsDir, filesSkippedUnchanged };
}

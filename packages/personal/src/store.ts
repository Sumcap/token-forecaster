import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";

// `node:sqlite` is loaded through createRequire rather than a static import:
// bundlers that predate the module (Vite, which vitest runs on) strip the
// `node:` prefix and fail to resolve it. The type-only import above is erased,
// so nothing but Node itself ever sees the specifier.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncInstance;

import type { ImportStats, UsageObservation, UsageProvider, UsageScale } from "@token-forecaster/core";

import type { PersonalEvaluation } from "./evaluate.js";
import type { PersonalProfile } from "./profile.js";
import type { SufficiencyReport } from "./sufficiency.js";

/**
 * Local, transactional store for derived data only.
 *
 * The schema has no column that can hold prompt or response text. Prompt
 * information is present exclusively as the counts and salted hash of
 * `PromptFeatures`. If a future migration adds a text column, that is a bug.
 */

/** Default application-support directory, outside the repository. */
export function defaultDataDir(): string {
  return join(homedir(), "Library", "Application Support", "TokenForecaster");
}

const SCHEMA_VERSION = 3;

/**
 * How many finished turns to keep.
 *
 * Enough to draw a graph that shows a trend and to compute a coverage rate
 * that means something, and small enough that the table stays a rounding error
 * next to the observations it sits beside.
 */
const TURN_OUTCOME_LIMIT = 200;

const MIGRATIONS: readonly string[] = [
  // v1 — initial schema.
  `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Incremental index cursors. A file whose size and mtime are unchanged is
  -- never reopened, so a restart costs a stat() per transcript, not a re-read.
  CREATE TABLE IF NOT EXISTS files (
    file_key   TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    path       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime_ms   REAL NOT NULL,
    offset     INTEGER NOT NULL,
    scanned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
    id                      TEXT PRIMARY KEY,
    provider                TEXT NOT NULL,
    session_id              TEXT NOT NULL,
    turn_index              INTEGER NOT NULL,
    call_index              INTEGER NOT NULL,
    scale                   TEXT NOT NULL,
    ts_ms                   INTEGER NOT NULL,
    timestamp               TEXT NOT NULL,
    model                   TEXT,
    reasoning               TEXT,
    usage_source            TEXT NOT NULL,
    input_tokens            INTEGER,
    cached_input_tokens     INTEGER,
    output_tokens           INTEGER NOT NULL,
    reasoning_output_tokens INTEGER,
    total_tokens            INTEGER,
    context_window          INTEGER,
    source_file             TEXT NOT NULL,
    source_offset           INTEGER NOT NULL,
    pf_chars                INTEGER,
    pf_words                INTEGER,
    pf_lines                INTEGER,
    pf_code_fences          INTEGER,
    pf_urls                 INTEGER,
    pf_paths                INTEGER,
    pf_has_question         INTEGER,
    pf_has_imperative       INTEGER,
    pf_images               INTEGER,
    pf_hash                 TEXT
  );
  CREATE INDEX IF NOT EXISTS observations_slice
    ON observations (provider, scale, ts_ms);
  CREATE INDEX IF NOT EXISTS observations_session
    ON observations (provider, session_id, ts_ms);

  CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    json       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    json       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    stats_json  TEXT NOT NULL
  );
  `,
  // v2 — data-sufficiency reports, so the stats page can answer "is this
  // enough history?" without recomputing the learning curves on every load.
  `
  CREATE TABLE IF NOT EXISTS sufficiency (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    json       TEXT NOT NULL
  );
  `,
  // v3 — how each finished turn actually landed against the forecast it was
  // given at the time. The holdout evaluation answers "is the model
  // calibrated on my history"; this answers "is it calibrated on me, now",
  // which is the only accuracy question a user can check for themselves.
  //
  // Numbers only: no session id, no path, no prompt. A row cannot be traced
  // back to a conversation, which is why it is safe to keep across restarts
  // when the live turn itself is not.
  `
  CREATE TABLE IF NOT EXISTS turn_outcomes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    ts_ms         INTEGER NOT NULL,
    provider      TEXT NOT NULL,
    output_tokens INTEGER NOT NULL,
    calls         INTEGER NOT NULL,
    p50           REAL,
    p90           REAL,
    verdict       TEXT NOT NULL,
    used_fallback INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turn_outcomes_ts ON turn_outcomes (ts_ms);
  `,
];

/** A persisted incremental cursor for one transcript file. */
export interface FileCursor {
  size: number;
  mtimeMs: number;
  offset: number;
}

/** Summary of what the store holds, for the menu bar and the API. */
export interface StoreSummary {
  observations: number;
  files: number;
  providers: {
    provider: UsageProvider;
    scale: UsageScale;
    count: number;
    firstAt: string | null;
    lastAt: string | null;
    models: number;
  }[];
}

/**
 * How one finished turn landed against the forecast it was given.
 *
 * Recorded when a live turn stops growing, so it measures the forecast the
 * user actually saw rather than one recomputed after the fact.
 */
export interface TurnOutcome {
  at: string;
  provider: UsageProvider;
  outputTokens: number;
  calls: number;
  p50: number | null;
  p90: number | null;
  verdict: "under" | "near" | "over" | "unknown";
  usedFallback: boolean;
}

/** Transactional local store for derived forecasting data. */
export class PersonalStore {
  readonly dbPath: string;
  #db: DatabaseSync;

  private constructor(dbPath: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.#db = db;
  }

  /** Open (creating if needed) the store at `dataDir/forecaster.db`. */
  static open(dataDir: string = defaultDataDir()): PersonalStore {
    const dbPath = join(dataDir, "forecaster.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new PersonalStore(dbPath, db);
    store.#migrate();
    return store;
  }

  #migrate(): void {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const current = row ? Number.parseInt(row.value, 10) : 0;
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      this.#db.exec(MIGRATIONS[version]!);
    }
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  /**
   * Per-install salt for prompt hashes, generated on first open.
   *
   * Keeping it local and per-install means a hash cannot be compared against
   * another machine's, and cannot be checked against a guessed prompt without
   * also stealing this file.
   */
  salt(): string {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'prompt_salt'").get() as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const salt = randomBytes(32).toString("hex");
    this.#db.prepare("INSERT INTO meta (key, value) VALUES ('prompt_salt', ?)").run(salt);
    return salt;
  }

  /** Read a settings value. */
  get(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Write a settings value. */
  set(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** All persisted file cursors for a provider, keyed by `fileKey`. */
  cursors(provider: UsageProvider): Map<string, FileCursor> {
    const rows = this.#db
      .prepare("SELECT file_key, size, mtime_ms, offset FROM files WHERE provider = ?")
      .all(provider) as { file_key: string; size: number; mtime_ms: number; offset: number }[];
    return new Map(
      rows.map((r) => [r.file_key, { size: r.size, mtimeMs: r.mtime_ms, offset: r.offset }]),
    );
  }

  /** Persist file cursors and observations in a single transaction. */
  ingest(
    provider: UsageProvider,
    observations: readonly UsageObservation[],
    cursors: ReadonlyMap<string, FileCursor & { path?: string }>,
    stats: ImportStats,
  ): { inserted: number } {
    const insertObservation = this.#db.prepare(`
      INSERT INTO observations (
        id, provider, session_id, turn_index, call_index, scale, ts_ms, timestamp,
        model, reasoning, usage_source, input_tokens, cached_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, context_window,
        source_file, source_offset,
        pf_chars, pf_words, pf_lines, pf_code_fences, pf_urls, pf_paths,
        pf_has_question, pf_has_imperative, pf_images, pf_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        total_tokens = excluded.total_tokens,
        source_offset = excluded.source_offset
    `);
    const insertFile = this.#db.prepare(`
      INSERT INTO files (file_key, provider, path, size, mtime_ms, offset, scanned_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(file_key) DO UPDATE SET
        path = excluded.path, size = excluded.size, mtime_ms = excluded.mtime_ms,
        offset = excluded.offset, scanned_at = excluded.scanned_at
    `);
    const now = new Date().toISOString();

    this.#db.exec("BEGIN");
    try {
      for (const o of observations) {
        const f = o.promptFeatures;
        insertObservation.run(
          o.id,
          o.provider,
          o.sessionId,
          o.turnIndex,
          o.callIndex,
          o.scale,
          Date.parse(o.timestamp) || 0,
          o.timestamp,
          o.model,
          o.reasoning,
          o.usageSource,
          o.inputTokens,
          o.cachedInputTokens,
          o.outputTokens,
          o.reasoningOutputTokens,
          o.totalTokens,
          o.contextWindow,
          o.sourceFile,
          o.sourceOffset,
          f?.chars ?? null,
          f?.words ?? null,
          f?.lines ?? null,
          f?.codeFences ?? null,
          f?.urls ?? null,
          f?.paths ?? null,
          f ? (f.hasQuestion ? 1 : 0) : null,
          f ? (f.hasImperative ? 1 : 0) : null,
          f?.images ?? null,
          f?.hash ?? null,
        );
      }
      for (const [fileKey, cursor] of cursors) {
        insertFile.run(
          fileKey,
          provider,
          cursor.path ?? "",
          cursor.size,
          cursor.mtimeMs,
          cursor.offset,
          now,
        );
      }
      this.#db
        .prepare("INSERT INTO import_runs (provider, finished_at, stats_json) VALUES (?,?,?)")
        .run(provider, now, JSON.stringify(stats));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { inserted: observations.length };
  }

  /** Load observations for training, oldest first. */
  observations(filter: { provider?: UsageProvider; scale?: UsageScale } = {}): UsageObservation[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.provider) {
      where.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.scale) {
      where.push("scale = ?");
      params.push(filter.scale);
    }
    const sql = `SELECT * FROM observations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts_ms ASC`;
    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToObservation);
  }

  /** Counts and spans for the status UI. */
  summary(): StoreSummary {
    const observations = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }
    ).n;
    const files = (this.#db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    const rows = this.#db
      .prepare(
        `SELECT provider, scale, COUNT(*) AS n, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
                COUNT(DISTINCT model) AS models
         FROM observations GROUP BY provider, scale ORDER BY provider, scale`,
      )
      .all() as {
      provider: string;
      scale: string;
      n: number;
      first_at: string | null;
      last_at: string | null;
      models: number;
    }[];
    return {
      observations,
      files,
      providers: rows.map((r) => ({
        provider: r.provider as UsageProvider,
        scale: r.scale as UsageScale,
        count: r.n,
        firstAt: r.first_at,
        lastAt: r.last_at,
        models: r.models,
      })),
    };
  }

  /**
   * The most recent session for a provider, with its running output total.
   * Used for the "current session" row; a session is considered active when its
   * last call is recent, which the caller decides.
   */
  latestSession(provider: UsageProvider): {
    sessionId: string;
    calls: number;
    outputTokens: number;
    startedAt: string;
    lastAt: string;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT session_id, COUNT(*) AS calls, SUM(output_tokens) AS output,
                MIN(timestamp) AS started, MAX(timestamp) AS last, MAX(ts_ms) AS last_ms
         FROM observations WHERE provider = ? AND scale = 'call'
         GROUP BY session_id ORDER BY last_ms DESC LIMIT 1`,
      )
      .get(provider) as
      | { session_id: string; calls: number; output: number; started: string; last: string }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      calls: row.calls,
      outputTokens: row.output,
      startedAt: row.started,
      lastAt: row.last,
    };
  }

  /** Store a trained profile and return its row id. */
  saveProfile(profile: PersonalProfile): number {
    const info = this.#db
      .prepare("INSERT INTO profiles (created_at, json) VALUES (?, ?)")
      .run(profile.generatedAt, JSON.stringify(profile));
    return Number(info.lastInsertRowid);
  }

  /** The most recently trained profile, or null before the first rebuild. */
  latestProfile(): PersonalProfile | null {
    const row = this.#db
      .prepare("SELECT json FROM profiles ORDER BY id DESC LIMIT 1")
      .get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PersonalProfile) : null;
  }

  /** Store an evaluation report. */
  saveEvaluation(evaluation: PersonalEvaluation): void {
    this.#db
      .prepare("INSERT INTO evaluations (created_at, json) VALUES (?, ?)")
      .run(evaluation.generatedAt, JSON.stringify(evaluation));
  }

  /** The most recent evaluation report. */
  latestEvaluation(): PersonalEvaluation | null {
    const row = this.#db
      .prepare("SELECT json FROM evaluations ORDER BY id DESC LIMIT 1")
      .get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PersonalEvaluation) : null;
  }

  /**
   * Observation counts bucketed by ISO week, per provider, for the history
   * timeline. Aggregated in SQL so the UI never loads 46k rows to draw a chart.
   */
  weeklyCounts(): { week: string; provider: UsageProvider; count: number }[] {
    return this.#db
      .prepare(
        `SELECT strftime('%Y-%W', timestamp) AS week, provider, COUNT(*) AS n
         FROM observations WHERE scale = 'call'
         GROUP BY week, provider ORDER BY week ASC`,
      )
      .all()
      .map((row) => {
        const r = row as { week: string; provider: string; n: number };
        return { week: r.week, provider: r.provider as UsageProvider, count: r.n };
      });
  }

  /**
   * Append one finished turn's outcome, keeping only the most recent
   * `TURN_OUTCOME_LIMIT` rows.
   *
   * The trim is part of the write rather than a background sweep: the table is
   * a rolling window for a graph, and an unbounded one would grow forever for
   * no one's benefit.
   */
  recordTurnOutcome(outcome: TurnOutcome): void {
    this.#db
      .prepare(
        `INSERT INTO turn_outcomes
           (at, ts_ms, provider, output_tokens, calls, p50, p90, verdict, used_fallback)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.at,
        Date.parse(outcome.at) || Date.now(),
        outcome.provider,
        Math.round(outcome.outputTokens),
        Math.round(outcome.calls),
        outcome.p50,
        outcome.p90,
        outcome.verdict,
        outcome.usedFallback ? 1 : 0,
      );
    this.#db
      .prepare(
        `DELETE FROM turn_outcomes WHERE id NOT IN
           (SELECT id FROM turn_outcomes ORDER BY id DESC LIMIT ?)`,
      )
      .run(TURN_OUTCOME_LIMIT);
  }

  /** The most recent turn outcomes, oldest first so a chart can plot them left to right. */
  recentTurnOutcomes(limit = TURN_OUTCOME_LIMIT): TurnOutcome[] {
    const rows = this.#db
      .prepare("SELECT * FROM turn_outcomes ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(TURN_OUTCOME_LIMIT, Math.round(limit)))) as {
      at: string;
      provider: string;
      output_tokens: number;
      calls: number;
      p50: number | null;
      p90: number | null;
      verdict: string;
      used_fallback: number;
    }[];
    return rows.reverse().map((row) => ({
      at: row.at,
      provider: row.provider as UsageProvider,
      outputTokens: row.output_tokens,
      calls: row.calls,
      p50: row.p50,
      p90: row.p90,
      verdict: row.verdict as TurnOutcome["verdict"],
      usedFallback: row.used_fallback === 1,
    }));
  }

  /** Store a data-sufficiency report. */
  saveSufficiency(report: SufficiencyReport): void {
    this.#db
      .prepare("INSERT INTO sufficiency (created_at, json) VALUES (?, ?)")
      .run(report.generatedAt, JSON.stringify(report));
  }

  /** The most recent data-sufficiency report. */
  latestSufficiency(): SufficiencyReport | null {
    const row = this.#db
      .prepare("SELECT json FROM sufficiency ORDER BY id DESC LIMIT 1")
      .get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as SufficiencyReport) : null;
  }

  /** Distinct sessions seen per provider, for the stats page. */
  sessionCounts(): Record<string, number> {
    const rows = this.#db
      .prepare(
        `SELECT provider, COUNT(DISTINCT session_id) AS n FROM observations GROUP BY provider`,
      )
      .all() as { provider: string; n: number }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.provider] = row.n;
    return out;
  }

  /** Import stats from the last run per provider. */
  lastImportStats(): Record<string, { finishedAt: string; stats: ImportStats }> {
    const rows = this.#db
      .prepare(
        `SELECT provider, finished_at, stats_json FROM import_runs
         WHERE id IN (SELECT MAX(id) FROM import_runs GROUP BY provider)`,
      )
      .all() as { provider: string; finished_at: string; stats_json: string }[];
    const out: Record<string, { finishedAt: string; stats: ImportStats }> = {};
    for (const row of rows) {
      out[row.provider] = {
        finishedAt: row.finished_at,
        stats: JSON.parse(row.stats_json) as ImportStats,
      };
    }
    return out;
  }

  /**
   * Delete every derived row while keeping the install's identity.
   *
   * The salt is rotated too: after a reset, old hashes could not be correlated
   * with new ones even if a copy of the file survived somewhere.
   */
  reset(): void {
    this.#db.exec("BEGIN");
    try {
      for (const table of [
        "observations",
        "files",
        "profiles",
        "evaluations",
        "import_runs",
        "sufficiency",
        "turn_outcomes",
      ]) {
        this.#db.exec(`DELETE FROM ${table}`);
      }
      this.#db.exec("DELETE FROM meta WHERE key = 'prompt_salt'");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#db.exec("VACUUM");
  }

  /**
   * The full DDL of every table, for the privacy assertion in the tests: the
   * schema must contain no column capable of holding prompt or response text.
   */
  schemaSql(): string {
    const rows = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all() as { sql: string }[];
    return rows.map((r) => r.sql).join("\n");
  }

  close(): void {
    this.#db.close();
  }

  /** Close and delete the database file entirely. */
  destroy(): void {
    this.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${this.dbPath}${suffix}`, { force: true });
    }
  }
}

function rowToObservation(row: Record<string, unknown>): UsageObservation {
  const chars = row["pf_chars"] as number | null;
  return {
    provider: row["provider"] as UsageProvider,
    id: row["id"] as string,
    sourceFile: row["source_file"] as string,
    sourceOffset: row["source_offset"] as number,
    sessionId: row["session_id"] as string,
    turnIndex: row["turn_index"] as number,
    callIndex: row["call_index"] as number,
    scale: row["scale"] as UsageScale,
    timestamp: row["timestamp"] as string,
    model: (row["model"] as string | null) ?? null,
    reasoning: (row["reasoning"] as string | null) ?? null,
    usageSource: row["usage_source"] as UsageObservation["usageSource"],
    inputTokens: (row["input_tokens"] as number | null) ?? null,
    cachedInputTokens: (row["cached_input_tokens"] as number | null) ?? null,
    outputTokens: row["output_tokens"] as number,
    reasoningOutputTokens: (row["reasoning_output_tokens"] as number | null) ?? null,
    totalTokens: (row["total_tokens"] as number | null) ?? null,
    contextWindow: (row["context_window"] as number | null) ?? null,
    promptFeatures:
      chars === null
        ? null
        : {
            chars,
            words: (row["pf_words"] as number | null) ?? 0,
            lines: (row["pf_lines"] as number | null) ?? 0,
            codeFences: (row["pf_code_fences"] as number | null) ?? 0,
            urls: (row["pf_urls"] as number | null) ?? 0,
            paths: (row["pf_paths"] as number | null) ?? 0,
            hasQuestion: row["pf_has_question"] === 1,
            hasImperative: row["pf_has_imperative"] === 1,
            images: (row["pf_images"] as number | null) ?? 0,
            hash: (row["pf_hash"] as string | null) ?? "",
          },
  };
}

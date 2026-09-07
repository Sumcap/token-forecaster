import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { mergeImportStats, type ImportStats, type UsageProvider } from "@token-forecaster/core";

import { meterFill } from "./meter.js";
import {
  SETTING_INGEST_TOKEN,
  SETTING_INGEST_URL,
  SETTING_UPLOAD_MODE,
  telemetrySettings,
  uploadPendingObservations,
  type TelemetrySettings,
  type TelemetryUploadMode,
  type UploadResult,
} from "./telemetry.js";
import { importClaudeHistory } from "@token-forecaster/ingest-claude";
import { defaultCodexSessionsDir, importCodexHistory } from "@token-forecaster/ingest-codex";
import {
  PersonalStore,
  evaluatePersonalModel,
  measureSufficiency,
  personalForecast,
  trainPersonalProfile,
  type PersonalEvaluation,
  type PersonalForecastRequest,
  type PersonalForecastResult,
  type PersonalProfile,
  type SufficiencyReport,
  type TurnOutcome,
} from "@token-forecaster/personal";

/**
 * The companion's whole brain, independent of transport.
 *
 * The HTTP server and the CLI are both thin wrappers around this class, so a
 * behaviour only has to be right once. Nothing here reads or writes anything
 * under the user's history directories except opening transcripts for reading.
 */

/** Live indexing status, surfaced in the menu bar. */
export interface IndexingStatus {
  state: "idle" | "scanning" | "training";
  filesScanned: number;
  filesTotal: number;
  rowsUsed: number;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

/** One configured history source. */
export interface SourceStatus {
  provider: UsageProvider;
  label: string;
  path: string;
  available: boolean;
  files: number;
  usableCalls: number;
  lastScanAt: string | null;
  /** Transcript bytes present on disk. What we read, not what we kept. */
  bytesOnDisk: number;
  /** Rows read from the transcripts on the last import. */
  rowsRead: number;
  /** Sessions represented in the store for this provider. */
  sessions: number;
  /** Skipped-row accounting from the last import of this source. */
  skipped: Record<string, number>;
}

/**
 * A live-turn report from a client that can see the turn as it happens.
 *
 * The daemon cannot see this for itself: it scans transcripts on demand, and
 * the tokens produced by a turn still in flight are known only to whatever is
 * watching the transcript right now. Today that is the Claude Code status line,
 * which already parses the live turn and already talks to this daemon. The slot
 * is deliberately source-agnostic — a transcript watcher could fill it for
 * Codex later without changing the wire format.
 *
 * Token counts, a session id and a forecast. No prompt or response text.
 */
export interface LiveTurnReport {
  sessionId: string;
  /**
   * Human-readable name for the session, so the menu can say which chat the
   * number belongs to. The workspace directory name today. Never persisted —
   * it lives as long as the turn does and no longer.
   */
  label?: string | null;
  provider: UsageProvider;
  outputTokens: number;
  calls: number;
  p50: number | null;
  p90: number | null;
  /** True when the forecast came from the bundled generic profile. */
  usedFallback: boolean;
  /**
   * Whether the reported turn is still running, when the reporter knows.
   *
   * The reporter reads it straight off the transcript — a turn is over when its
   * last message ended it — and that is worth far more than the token delta
   * this used to be inferred from. With several terminals open, every idle one
   * posts its last finished turn on the same timer as the busy one; the first
   * such post from a session looks exactly like a turn that has just produced
   * its first tokens, which is how one running turn came to be shown as every
   * session running at once.
   *
   * Optional: an older reporter that does not send it falls back to the delta.
   */
  inFlight?: boolean;
}

/** The live turn as the menu bar sees it. Never carries the raw session id. */
export interface LiveTurnStatus {
  /** Salted hash of the session id, so one turn is distinguishable from the next. */
  session: string;
  provider: UsageProvider;
  /** `in_flight` while the turn is still growing; `settled` during the verdict hold. */
  state: "in_flight" | "settled";
  /** At or under P50, between P50 and P90, past P90, or unjudgeable. */
  verdict: "under" | "near" | "over" | "unknown";
  outputTokens: number;
  calls: number;
  p50: number | null;
  p90: number | null;
  /** Bar fill 0..1, on the same curve as the status line meter. */
  fill: number;
  usedFallback: boolean;
  /** Milliseconds since the turn last grew. */
  sinceGrowthMs: number;
  /** Name of the session this turn belongs to, when the reporter sent one. */
  label: string | null;
  /** How many sessions are reporting a turn right now, this one included. */
  sessions: number;
}

/** The rolling record of how recent turns landed against their forecasts. */
export interface AccuracySummary {
  /** Turns scored, oldest first. */
  points: {
    at: string;
    provider: UsageProvider;
    outputTokens: number;
    p50: number | null;
    p90: number | null;
    verdict: TurnOutcome["verdict"];
    usedFallback: boolean;
    /** Actual over forecast median. The one number the chart plots. */
    ratio: number | null;
  }[];
  /** Turns with a usable forecast — the denominator of both rates below. */
  n: number;
  /** Fraction that landed at or under P50. Well calibrated is ~0.5. */
  withinP50: number | null;
  /** Fraction that landed at or under P90. Well calibrated is ~0.9. */
  withinP90: number | null;
  /** Median actual/P50 ratio. Above 1 means the forecast runs low. */
  medianRatio: number | null;
}

/**
 * A post is recent enough to mean "something is still reporting".
 *
 * The status line runs on every assistant message, and once a second when
 * `refreshInterval` is configured, so a gap this long means it stopped.
 */
const LIVE_POST_WINDOW_MS = 10_000;

/**
 * How long a turn can go without growing and still count as in flight.
 *
 * A single long tool call produces no output tokens, so a shorter window would
 * flap between the face and the idle bar in the middle of a turn.
 */
const LIVE_GROWTH_WINDOW_MS = 12_000;

/** How long the final verdict stays up after the turn stops growing. */
const LIVE_VERDICT_HOLD_MS = 10_000;

/** Past this, the report is stale and the menu bar goes back to the idle bar. */
const LIVE_STALE_MS = 60_000;

/**
 * How long a silent session is tracked before its turn is called finished.
 *
 * Deliberately far longer than the display windows above. A turn that has
 * stopped growing is not necessarily over — a single long tool call produces
 * no output tokens for as long as it runs — so the menu bar gives up on it
 * after seconds, while the accuracy record waits until the reporter itself has
 * gone quiet. Scoring a turn early would file a half-finished turn as a small
 * one and then file the rest of it again as a second turn.
 */
const LIVE_RETIRE_MS = 10 * 60_000;

/** One session's live turn, as held in memory. */
interface LiveEntry {
  report: LiveTurnReport;
  lastPostMs: number;
  lastGrowthMs: number;
  /** True once this turn's outcome has been written, so it is written once. */
  recorded: boolean;
}

/**
 * Where a turn landed relative to its own forecast.
 *
 * P50 and P90 are the boundaries because the forecast is already expressed in
 * them: at or under your median, between median and P90, or past the point
 * where only one turn in ten lands.
 */
function verdictFor(report: LiveTurnReport): "under" | "near" | "over" | "unknown" {
  const { p50, p90, outputTokens } = report;
  if (typeof p50 !== "number" || p50 <= 0 || typeof p90 !== "number" || p90 <= 0) return "unknown";
  if (outputTokens > p90) return "over";
  if (outputTokens > p50) return "near";
  return "under";
}

/**
 * Total bytes of `*.jsonl` under `root`.
 *
 * Stat-only: file contents are never opened here. Returns 0 for a missing
 * directory, which is the normal "source unavailable" state.
 */
function transcriptBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          total += statSync(full).size;
        } catch {
          // Raced with a delete; skip it.
        }
      }
    }
  };
  walk(root);
  return total;
}

/**
 * A cheap "has anything changed" stamp for a transcript tree.
 *
 * Stat-only, like {@link transcriptBytes}: a few milliseconds of `readdir` and
 * `stat`, against the tens of seconds it costs to actually re-read every
 * transcript. Size and mtime of every `*.jsonl` are folded into one hash, so
 * an appended line, a new session file and a deleted one all change it, while
 * an unrelated wake-up does not.
 *
 * It is deliberately not a content hash: this exists so the importer can be
 * skipped, and a stamp that costs as much as the work it guards saves nothing.
 */
export function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = statSync(full);
          hash.update(`${full}\0${info.size}\0${info.mtimeMs}\n`);
        } catch {
          // Raced with a delete; skip it.
        }
      }
    }
  };
  walk(root);
  return hash.digest("hex").slice(0, 32);
}

/** Default Claude Code projects directory. */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

const SETTING_CODEX_DIR = "codex_dir";
const SETTING_CLAUDE_DIR = "claude_dir";
const SETTING_PAUSED = "paused";
const SETTING_STATUS_STYLE = "status_style";
const SETTING_DRAFT_CONDITIONING = "draft_conditioning";
const SETTING_ALIAS_OFFERED = "shell_alias_offered";

/** Per-provider stamp of the transcript tree as of the last real import. */
const SETTING_FINGERPRINT = (provider: UsageProvider): string => `tree_fingerprint_${provider}`;

/** How recent a session's last call must be to count as "current". */
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

export class CompanionService {
  readonly store: PersonalStore;
  #indexing: IndexingStatus = {
    state: "idle",
    filesScanned: 0,
    filesTotal: 0,
    rowsUsed: 0,
    startedAt: null,
    finishedAt: null,
    message: null,
  };
  #profile: PersonalProfile | null;
  #running = false;
  /** One upload at a time: a slow collector must not stack up runs. */
  #uploading = false;
  /**
   * One slot per reporting session, not one slot in total.
   *
   * Two chats running side by side both post here every second. A single slot
   * made the menu bar show whichever posted last, so the icon flipped between
   * two unrelated turns several times a second — which read as a glitch rather
   * than as two sessions.
   */
  #liveTurns = new Map<string, LiveEntry>();
  /** The session the menu bar is currently showing, so it stops jumping. */
  #featured: string | null = null;

  constructor(store: PersonalStore) {
    this.store = store;
    this.#profile = store.latestProfile();
  }

  get indexing(): IndexingStatus {
    return { ...this.#indexing };
  }

  get profile(): PersonalProfile | null {
    return this.#profile;
  }

  get paused(): boolean {
    return this.store.get(SETTING_PAUSED) === "true";
  }

  setPaused(paused: boolean): void {
    this.store.set(SETTING_PAUSED, paused ? "true" : "false");
  }

  /**
   * How much the terminal status line says: "simple" (the default) or
   * "detailed", which adds the percentiles behind the verdict.
   *
   * Stored here rather than in the status line's own config because the menu
   * bar is where the user changes it, and the status line already talks to
   * this daemon once a turn.
   */
  get statusStyle(): "simple" | "detailed" {
    return this.store.get(SETTING_STATUS_STYLE) === "detailed" ? "detailed" : "simple";
  }

  setStatusStyle(style: "simple" | "detailed"): void {
    this.store.set(SETTING_STATUS_STYLE, style);
  }

  /**
   * Condition the forecast on the prompt, including one still being typed.
   *
   * Off by default, because the adoption gate decides it from held-out data
   * and usually says no: prompt rungs sharpen P50 and P90 and lose it again at
   * P99, which nets out below the 2% margin. Turning it on is a deliberate
   * trade — a bar that tracks the draft, bought with a slightly worse tail —
   * and it is honest about it, so nothing here overrides the *reason* the
   * evaluation recorded; it only overrides the decision.
   */
  get draftConditioning(): boolean {
    // On unless switched off. The gate's verdict is recorded in the profile's
    // reason either way, so the trade is visible; defaulting it off would ship
    // an app whose main feature does nothing until someone finds a menu.
    return this.store.get(SETTING_DRAFT_CONDITIONING) !== "false";
  }

  setDraftConditioning(enabled: boolean): void {
    this.store.set(SETTING_DRAFT_CONDITIONING, enabled ? "true" : "false");
  }

  /**
   * What, if anything, this machine sends to a research collector.
   *
   * `none` by default and after every fresh install: nothing is uploaded until
   * somebody says so, and saying so means naming a collector as well as a
   * tier. See ADR 0002 for what each tier sends.
   */
  get telemetry(): TelemetrySettings {
    return telemetrySettings(this.store);
  }

  setTelemetry(settings: {
    mode?: TelemetryUploadMode;
    url?: string;
    /** `keychain:<service>[/<account>]` reads from the macOS keychain instead. */
    token?: string;
  }): void {
    if (settings.mode !== undefined) this.store.set(SETTING_UPLOAD_MODE, settings.mode);
    if (settings.url !== undefined) this.store.set(SETTING_INGEST_URL, settings.url.trim());
    if (settings.token !== undefined) this.store.set(SETTING_INGEST_TOKEN, settings.token.trim());
  }

  /** Forget that anything was uploaded, so the next run sends it all again. */
  resetUploadCursor(): void {
    this.store.clearUploadCursor();
  }

  /**
   * Send whatever the chosen tier allows, then return the counts.
   *
   * Called after an index run, never awaited by anything a user is looking at.
   */
  async uploadTelemetry(log?: (message: string) => void): Promise<UploadResult> {
    if (this.#uploading) {
      return { uploaded: 0, batches: 0, failed: 0, remaining: 0, skipped: "nothing_pending" };
    }
    this.#uploading = true;
    try {
      return await uploadPendingObservations({
        store: this.store,
        claudeDir: this.claudeDir,
        codexDir: this.codexDir,
        predictorVersion: this.#profile?.id ?? "personal-untrained",
        forecast: (request) => {
          const result = this.forecast(request);
          return {
            p50: result.p50,
            p90: result.p90,
            p99: result.p99,
            source: result.source,
            sampleSize: result.sampleSize,
          };
        },
        ...(log ? { log } : {}),
      });
    } finally {
      this.#uploading = false;
    }
  }

  /**
   * Whether the shell block has already been dealt with once.
   *
   * A clean install writes it; after that the answer is whatever the user last
   * chose, and this app never touches their startup file again on its own.
   */
  get shellAliasOffered(): boolean {
    return this.store.get(SETTING_ALIAS_OFFERED) === "true";
  }

  markShellAliasOffered(): void {
    this.store.set(SETTING_ALIAS_OFFERED, "true");
  }

  get codexDir(): string {
    return this.store.get(SETTING_CODEX_DIR) ?? defaultCodexSessionsDir();
  }

  get claudeDir(): string {
    return this.store.get(SETTING_CLAUDE_DIR) ?? defaultClaudeProjectsDir();
  }

  /**
   * Point the companion at different history directories.
   *
   * Cursors are keyed by device+inode, so re-pointing at a directory that was
   * already indexed does not re-read it.
   */
  setDirectories(dirs: { codexDir?: string; claudeDir?: string }): void {
    if (dirs.codexDir) this.store.set(SETTING_CODEX_DIR, dirs.codexDir);
    if (dirs.claudeDir) this.store.set(SETTING_CLAUDE_DIR, dirs.claudeDir);
  }

  /**
   * Import both histories incrementally, then retrain.
   *
   * Concurrent calls are collapsed: a second caller gets `skipped` rather than
   * a second scan racing the first over the same cursors.
   *
   * A provider whose transcript tree is byte-for-byte where it was at the last
   * import is not read at all. This matters far more than it sounds: the
   * Claude importer has no per-file cursor — a turn's ancestry crosses session
   * files, so the loader reads the whole tree or none of it — and the daemon
   * watches that tree, which changes on every assistant message. Without this
   * check, working for an hour means re-reading every transcript ever written,
   * and retraining on all of it, over and over.
   *
   * `force` re-reads regardless, for the "rebuild now" button: it is the one
   * way back if a fingerprint ever went stale against the store.
   */
  async index(options: { train?: boolean; force?: boolean } = {}): Promise<
    | { skipped: true }
    | {
        skipped: false;
        stats: Record<string, ImportStats>;
        profile: PersonalProfile | null;
        /** Providers actually read this run; empty means nothing had changed. */
        scanned: UsageProvider[];
        inserted: number;
      }
  > {
    if (this.#running) return { skipped: true };
    this.#running = true;
    this.#indexing = {
      state: "scanning",
      filesScanned: 0,
      filesTotal: 0,
      rowsUsed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
    };
    const stats: Record<string, ImportStats> = {};
    const scanned: UsageProvider[] = [];
    let inserted = 0;
    try {
      const salt = this.store.salt();

      const codexDir = this.codexDir;
      const codexPrint = existsSync(codexDir) ? treeFingerprint(codexDir) : null;
      if (codexPrint === null) {
        stats["openai"] = unavailableStats();
      } else if (options.force !== true && codexPrint === this.store.get(SETTING_FINGERPRINT("openai"))) {
        stats["openai"] = unchangedStats();
      } else {
        const cursors = this.store.cursors("openai");
        const result = await importCodexHistory({
          sessionsDir: codexDir,
          salt,
          cursors,
          onFile: (_file, index, total) => {
            this.#indexing.filesScanned = index + 1;
            this.#indexing.filesTotal = total;
          },
        });
        const withPaths = new Map(
          [...result.cursors].map(([key, cursor]) => [key, { ...cursor, path: codexDir }]),
        );
        inserted += this.store.ingest("openai", result.observations, withPaths, result.stats).inserted;
        this.#accumulateRowsRead("openai", result.stats.rowsRead);
        stats["openai"] = result.stats;
        this.#indexing.rowsUsed += result.stats.rowsUsed;
        scanned.push("openai");
        this.store.set(SETTING_FINGERPRINT("openai"), codexPrint);
      }

      const claudeDir = this.claudeDir;
      const claudePrint = existsSync(claudeDir) ? treeFingerprint(claudeDir) : null;
      if (claudePrint === null) {
        stats["anthropic"] = unavailableStats();
      } else if (options.force !== true && claudePrint === this.store.get(SETTING_FINGERPRINT("anthropic"))) {
        stats["anthropic"] = unchangedStats();
      } else {
        this.#indexing.message = "reading Claude Code history";
        const result = await importClaudeHistory({ projectsDir: claudeDir, salt });
        inserted += this.store.ingest("anthropic", result.observations, new Map(), result.stats).inserted;
        this.#accumulateRowsRead("anthropic", result.stats.rowsRead);
        stats["anthropic"] = result.stats;
        this.#indexing.rowsUsed += result.stats.rowsUsed;
        scanned.push("anthropic");
        this.store.set(SETTING_FINGERPRINT("anthropic"), claudePrint);
      }

      let profile = this.#profile;
      // Training is the expensive half — a chronological holdout over every
      // observation in the store — so it runs when the store actually moved,
      // and when there is no profile yet to serve forecasts from.
      if (options.train !== false && (inserted > 0 || this.#profile === null || options.force === true)) {
        this.#indexing.state = "training";
        this.#indexing.message = "training personal profile";
        profile = this.rebuild();
      }
      return { skipped: false, stats, profile, scanned, inserted };
    } finally {
      this.#indexing.state = "idle";
      this.#indexing.finishedAt = new Date().toISOString();
      this.#indexing.message = null;
      this.#running = false;
    }
  }

  /**
   * Running total of transcript rows parsed for a provider.
   *
   * The last run's count is not the answer to "how much did we read": after an
   * incremental scan where nothing changed it is zero, which reads as a broken
   * importer rather than an up-to-date one.
   */
  #accumulateRowsRead(provider: UsageProvider, rows: number): void {
    const key = `rows_read_${provider}`;
    const previous = Number.parseInt(this.store.get(key) ?? "0", 10);
    this.store.set(key, String((Number.isFinite(previous) ? previous : 0) + rows));
  }

  /**
   * Evaluate on a chronological holdout, then fit the final profile on
   * everything using only the feature set the holdout supported.
   *
   * The evaluation is what decides whether prompt features ship. Fitting the
   * final profile on all data is safe precisely because no score is ever taken
   * from it.
   */
  rebuild(): PersonalProfile {
    const observations = this.store.observations();
    const forced = this.draftConditioning;
    // The evaluation scores the configuration that is actually about to ship,
    // forcing included, so its serve verdict judges the real thing.
    const evaluation = evaluatePersonalModel(observations, { promptTiersForced: forced });
    this.store.saveEvaluation(evaluation);

    const profile = trainPersonalProfile(observations, {
      id: `personal-${new Date().toISOString().slice(0, 10)}`,
      withPromptTiers: evaluation.adoptPromptTiers || forced,
      promptTiersReason:
        forced && !evaluation.adoptPromptTiers
          ? `prompt rungs switched on by hand for live draft forecasting; the evaluation said: ${evaluation.adoptPromptTiersReason}`
          : evaluation.adoptPromptTiersReason,
      // The per-slice decisions still gate *which* slices get prompt rungs
      // from measurement; forcing overrides them wholesale, so drop them.
      ...(forced ? {} : { decisions: evaluation.decisions }),
      // The serve gate is never dropped. Forcing prompt rungs is a choice about
      // how to condition; it is not a licence to serve a slice that lost to the
      // profile shipped in the box.
      serve: evaluation.serve,
      serveReasons: evaluation.serveReasons,
    });
    this.store.saveProfile(profile);
    this.#profile = profile;

    // Measured on the same chronological split, so "is this enough history?"
    // and "does personalization help?" are answered from one experiment.
    this.store.saveSufficiency(
      measureSufficiency(observations, { decisions: evaluation.decisions }),
    );
    return profile;
  }

  /** The most recent data-sufficiency report, or null before the first rebuild. */
  sufficiency(): SufficiencyReport | null {
    return this.store.latestSufficiency();
  }

  /** The most recent evaluation report, or null before the first rebuild. */
  evaluation(): PersonalEvaluation | null {
    return this.store.latestEvaluation();
  }

  forecast(request: PersonalForecastRequest): PersonalForecastResult {
    // Live callers ask about a prompt, often one still being typed, so the
    // size rungs are read as a curve. Evaluation calls `personalForecast`
    // directly and keeps scoring the rungs exactly as they were fitted.
    return personalForecast(this.#profile, { interpolatePromptSize: true, ...request });
  }

  /** Per-source connection status for the menu bar. */
  sources(): SourceStatus[] {
    const summary = this.store.summary();
    const imports = this.store.lastImportStats();
    const sessions = this.store.sessionCounts();
    const build = (
      provider: UsageProvider,
      label: string,
      path: string,
    ): SourceStatus => {
      const slices = summary.providers.filter((p) => p.provider === provider);
      const calls = slices.find((s) => s.scale === "call")?.count ?? 0;
      const run = imports[provider];
      const skipped: Record<string, number> = {};
      for (const [reason, count] of Object.entries(run?.stats.skipped ?? {})) {
        if (count) skipped[reason] = count;
      }
      const available = existsSync(path);
      return {
        provider,
        label,
        path,
        available,
        files: run?.stats.filesScanned ?? 0,
        usableCalls: calls,
        lastScanAt: run?.finishedAt ?? null,
        bytesOnDisk: available ? transcriptBytes(path) : 0,
        rowsRead: Number.parseInt(this.store.get(`rows_read_${provider}`) ?? "0", 10) || 0,
        sessions: sessions[provider] ?? 0,
        skipped,
      };
    };
    return [
      build("openai", "Codex", this.codexDir),
      build("anthropic", "Claude Code", this.claudeDir),
    ];
  }

  /** A session counts as current when its most recent call is recent. */
  currentSession(): {
    provider: UsageProvider;
    sessionId: string;
    calls: number;
    outputTokens: number;
    startedAt: string;
  } | null {
    let best: {
      provider: UsageProvider;
      sessionId: string;
      calls: number;
      outputTokens: number;
      startedAt: string;
      lastMs: number;
    } | null = null;
    for (const provider of ["openai", "anthropic"] as const) {
      const session = this.store.latestSession(provider);
      if (!session) continue;
      const lastMs = Date.parse(session.lastAt);
      if (!Number.isFinite(lastMs) || Date.now() - lastMs > ACTIVE_SESSION_WINDOW_MS) continue;
      if (!best || lastMs > best.lastMs) {
        best = {
          provider,
          sessionId: session.sessionId,
          calls: session.calls,
          outputTokens: session.outputTokens,
          startedAt: session.startedAt,
          lastMs,
        };
      }
    }
    if (!best) return null;
    const { lastMs: _lastMs, ...rest } = best;
    return rest;
  }

  /**
   * Record the state of the turn currently in flight in one session.
   *
   * Kept in memory only: this is a few numbers about the next ten seconds, not
   * history, and it must not survive a restart or land in the store. What does
   * get written is the outcome once the turn is over — see `#retire`.
   *
   * A report whose token count went backwards is a new turn in the same
   * session, so the one before it is retired and the growth clock restarts.
   */
  recordLiveTurn(report: LiveTurnReport): void {
    const now = Date.now();
    const previous = this.#liveTurns.get(report.sessionId);
    const isSameTurn = previous !== undefined && report.outputTokens >= previous.report.outputTokens;
    if (previous && !isSameTurn) this.#retire(previous);
    // Growth is what keeps a turn on screen. A reporter that says the turn has
    // finished never restarts that clock, and a first sighting only starts it
    // when the turn is actually running: a session that has been idle for an
    // hour must not light up simply because its status line spoke for the
    // first time.
    const grewTokens = isSameTurn
      ? report.outputTokens > previous.report.outputTokens
      : report.inFlight !== false;
    const grew = report.inFlight === false ? false : grewTokens;
    const carried = isSameTurn ? previous.lastGrowthMs : 0;
    this.#liveTurns.set(report.sessionId, {
      // A reporter that names the session once has named it for good: losing
      // the name on the next post would blank the menu row mid-turn.
      report: { ...report, label: report.label ?? previous?.report.label ?? null },
      lastPostMs: now,
      lastGrowthMs: grew ? now : carried,
      recorded: false,
    });
    this.#prune(now);
  }

  /**
   * The turn worth showing, or null when nothing is reporting one.
   *
   * Null is the honest answer whenever the status line is not installed, the
   * work is happening in Codex, or every report has gone stale — the menu bar
   * falls back to the idle bar rather than showing a stale verdict.
   *
   * With several sessions reporting, one of them is featured and stays
   * featured for as long as its turn is in flight. A turn takes seconds and
   * the bar is 22 points wide; showing one turn to its end says something,
   * where alternating between two says nothing. `sessions` carries the fact
   * that there are others, and the menu names the one on screen.
   */
  liveTurn(): LiveTurnStatus | null {
    const now = Date.now();
    this.#prune(now);
    const entry = this.#pickFeatured(now);
    if (!entry) return null;
    const phase = this.#phase(entry, now);
    if (phase === "expired") return null;

    const { report } = entry;
    const { p50, p90 } = report;
    const judgeable = typeof p50 === "number" && p50 > 0 && typeof p90 === "number" && p90 > 0;
    return {
      session: this.#hashSession(report.sessionId),
      provider: report.provider,
      state: phase,
      verdict: verdictFor(report),
      outputTokens: report.outputTokens,
      calls: report.calls,
      p50,
      p90,
      fill: judgeable ? meterFill(report.outputTokens, p50, p90) : 0,
      usedFallback: report.usedFallback,
      sinceGrowthMs: now - entry.lastGrowthMs,
      label: report.label ?? null,
      sessions: this.#displayable(now),
    };
  }

  /**
   * How recent turns landed against the forecasts they were given.
   *
   * This is the accuracy a user can check for themselves: every point is a
   * turn they watched happen, scored against the number that was on screen at
   * the time. The holdout evaluation answers a different and more academic
   * question, and the two are not interchangeable.
   */
  accuracy(limit = 40): AccuracySummary {
    const outcomes = this.store.recentTurnOutcomes(limit);
    const points = outcomes.map((o) => ({
      at: o.at,
      provider: o.provider,
      outputTokens: o.outputTokens,
      p50: o.p50,
      p90: o.p90,
      verdict: o.verdict,
      usedFallback: o.usedFallback,
      ratio: o.p50 !== null && o.p50 > 0 ? o.outputTokens / o.p50 : null,
    }));
    // Only turns that had a forecast can be scored; an unjudgeable turn is not
    // a miss, so it is left out of the denominator rather than counted wrong.
    const judged = points.filter((p) => p.verdict !== "unknown" && p.ratio !== null);
    const n = judged.length;
    const rate = (predicate: (v: string) => boolean): number | null =>
      n === 0 ? null : judged.filter((p) => predicate(p.verdict)).length / n;
    const ratios = judged.map((p) => p.ratio as number).sort((a, b) => a - b);
    return {
      points,
      n,
      withinP50: rate((v) => v === "under"),
      withinP90: rate((v) => v === "under" || v === "near"),
      medianRatio: ratios.length === 0 ? null : (ratios[Math.floor((ratios.length - 1) / 2)] ?? null),
    };
  }

  /** Where a reported turn is in its life: growing, held, or gone. */
  #phase(entry: LiveEntry, now: number): "in_flight" | "settled" | "expired" {
    const sincePost = now - entry.lastPostMs;
    const sinceGrowth = now - entry.lastGrowthMs;
    if (sincePost > LIVE_STALE_MS) return "expired";
    // A reporter that can see the turn is over is believed immediately: the
    // growth window exists to cover a long tool call, not to keep a finished
    // turn on screen after the transcript has closed it.
    const running = entry.report.inFlight !== false;
    if (running && sinceGrowth <= LIVE_GROWTH_WINDOW_MS && sincePost <= LIVE_POST_WINDOW_MS) {
      return "in_flight";
    }
    if (sinceGrowth <= LIVE_GROWTH_WINDOW_MS + LIVE_VERDICT_HOLD_MS) return "settled";
    return "expired";
  }

  /** Sessions with something worth showing right now. */
  #displayable(now: number): number {
    let n = 0;
    for (const entry of this.#liveTurns.values()) {
      if (this.#phase(entry, now) !== "expired") n += 1;
    }
    return n;
  }

  /**
   * Forget the sessions that have gone quiet, recording how their last turn
   * landed on the way out.
   *
   * An entry stays here long after it has stopped being shown: dropping it at
   * the display window would score a turn that is merely between tool calls.
   */
  #prune(now: number): void {
    for (const [sessionId, entry] of this.#liveTurns) {
      if (now - entry.lastPostMs <= LIVE_RETIRE_MS) continue;
      this.#retire(entry);
      this.#liveTurns.delete(sessionId);
      if (this.#featured === sessionId) this.#featured = null;
    }
  }

  /**
   * The session to show: the one already on screen while its turn is still in
   * flight, otherwise whichever live turn grew most recently.
   */
  #pickFeatured(now: number): LiveEntry | null {
    const current = this.#featured ? this.#liveTurns.get(this.#featured) : undefined;
    if (current && this.#phase(current, now) === "in_flight") return current;

    let best: LiveEntry | null = null;
    let bestRank = -1;
    for (const entry of this.#liveTurns.values()) {
      const phase = this.#phase(entry, now);
      if (phase === "expired") continue;
      const rank = phase === "in_flight" ? 1 : 0;
      if (rank > bestRank || (rank === bestRank && best !== null && entry.lastGrowthMs > best.lastGrowthMs)) {
        best = entry;
        bestRank = rank;
      }
    }
    this.#featured = best?.report.sessionId ?? null;
    return best;
  }

  /**
   * Write a finished turn's outcome, once.
   *
   * A turn that was never judgeable, or that produced nothing, is not worth a
   * row: it would sit in the accuracy graph as a point that says nothing.
   */
  #retire(entry: LiveEntry): void {
    if (entry.recorded) return;
    entry.recorded = true;
    const { report } = entry;
    if (report.outputTokens <= 0) return;
    const verdict = verdictFor(report);
    if (verdict === "unknown") return;
    this.store.recordTurnOutcome({
      at: new Date(entry.lastGrowthMs).toISOString(),
      provider: report.provider,
      outputTokens: report.outputTokens,
      calls: report.calls,
      p50: report.p50,
      p90: report.p90,
      verdict,
      usedFallback: report.usedFallback,
    });
  }

  /** Session ids are salted before they leave the daemon, like every other id. */
  #hashSession(sessionId: string): string {
    return createHash("sha256")
      .update(this.store.salt())
      .update(sessionId)
      .digest("hex")
      .slice(0, 12);
  }

  /**
   * A single headline P50 for the status-bar title: the turn total this user's
   * busiest provider would typically produce. Null when nothing is known.
   */
  defaultP50(): number | null {
    const summary = this.store.summary();
    const turnSlices = summary.providers
      .filter((p) => p.scale === "turn")
      .sort((a, b) => b.count - a.count);
    const slice = turnSlices[0];
    if (!slice || !this.#profile) return null;
    return this.forecast({ provider: slice.provider, scale: "turn" }).p50;
  }

  /** Delete every derived row. History files are untouched. */
  reset(): void {
    this.store.reset();
    this.#profile = null;
    this.#liveTurns.clear();
    this.#featured = null;
  }
}

/**
 * What a provider reports when its transcripts are exactly where we left them.
 *
 * Distinct from {@link unavailableStats}: the source is there and healthy,
 * there was simply nothing new to read, and a UI that cannot tell those two
 * apart tells the user their history has gone missing every quiet minute.
 */
function unchangedStats(): ImportStats {
  return mergeImportStats(
    {
      filesScanned: 0,
      filesFailed: 0,
      rowsRead: 0,
      rowsUsed: 0,
      skipped: {},
      schemaVariants: { source_unchanged: 1 },
      unknownEvents: {},
    },
    {
      filesScanned: 0,
      filesFailed: 0,
      rowsRead: 0,
      rowsUsed: 0,
      skipped: {},
      schemaVariants: {},
      unknownEvents: {},
    },
  );
}

function unavailableStats(): ImportStats {
  return mergeImportStats(
    {
      filesScanned: 0,
      filesFailed: 0,
      rowsRead: 0,
      rowsUsed: 0,
      skipped: {},
      schemaVariants: { source_unavailable: 1 },
      unknownEvents: {},
    },
    {
      filesScanned: 0,
      filesFailed: 0,
      rowsRead: 0,
      rowsUsed: 0,
      skipped: {},
      schemaVariants: {},
      unknownEvents: {},
    },
  );
}

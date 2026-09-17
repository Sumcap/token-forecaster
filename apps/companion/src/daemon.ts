import { watch, type FSWatcher } from "node:fs";
import { existsSync, rmSync } from "node:fs";

import { PersonalStore, defaultDataDir } from "@token-forecaster/personal";

import { CompanionService } from "./service.js";
import { launcherTargets } from "./launcher.js";
import { runtimeFilePath, startServer, type RunningServer } from "./server.js";
import { ensureAliasOnFirstRun, shellTargetFor } from "./shell-alias.js";

/**
 * The long-running background process.
 *
 * It backfills once at startup, then watches both history directories and
 * re-indexes incrementally after activity settles. Watching is coalesced: a
 * burst of writes during an active agent loop produces one scan, not hundreds.
 */

/** Quiet period after the last filesystem event before re-indexing. */
const DEBOUNCE_MS = 20_000;

/**
 * Floor on how often a watcher event may start a scan.
 *
 * The debounce alone is not enough. An agent loop writes to its transcript
 * every few seconds for as long as it runs, so a quiet period that short never
 * arrives while the user is working — and the Claude importer has no per-file
 * cursor, so every one of those scans re-reads the entire history and retrains
 * on it. History that arrived in the last few minutes changes a profile built
 * from tens of thousands of observations by nothing anyone can see, so the
 * work is deferred rather than skipped: the trailing scan still runs, once.
 *
 * Startup and the "rebuild now" button bypass this.
 */
const MIN_SCAN_INTERVAL_MS = 10 * 60_000;

export interface DaemonOptions {
  dataDir?: string;
  port?: number;
  /** Skip the startup backfill. Used by tests. */
  skipInitialIndex?: boolean;
  log?: (message: string) => void;
}

export interface RunningDaemon {
  service: CompanionService;
  server: RunningServer;
  stop: () => Promise<void>;
}

/** Start the companion daemon. */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const store = PersonalStore.open(dataDir);
  const service = new CompanionService(store);

  // First run: wire `claude` and `codex` to their launchers, so the very first
  // session already forecasts what is being typed.
  const aliasResult = ensureAliasOnFirstRun({
    alreadyDecided: service.shellAliasOffered,
    rcPath: shellTargetFor()?.rcPath ?? null,
    targets: launcherTargets(),
    markDecided: () => service.markShellAliasOffered(),
  });
  if (aliasResult?.changed) {
    log(`[setup] wrote the launcher block to ${aliasResult.rcPath}`);
    if (aliasResult.backupPath) log(`[setup] original kept at ${aliasResult.backupPath}`);
  }

  let pending: NodeJS.Timeout | null = null;
  let queued = false;
  let lastScanAt = 0;

  const runIndex = (reason: string, options: { force?: boolean } = {}): void => {
    if (service.paused) {
      log(`[skip] ${reason}: watching is paused`);
      return;
    }
    lastScanAt = Date.now();
    void service
      .index(options.force === true ? { force: true } : {})
      .then((result) => {
        if (result.skipped) {
          // A scan was already running; make sure the change it may have missed
          // is picked up right after it finishes.
          queued = true;
          return;
        }
        lastScanAt = Date.now();
        if (result.scanned.length === 0) {
          // The fingerprint said nothing moved, so nothing was read. Worth a
          // line — a silent daemon and an idle one look identical in a log.
          log(`[index] ${reason}: no transcript changes, nothing re-read`);
        } else {
          const summary = service.store.summary();
          log(
            `[index] ${reason}: read ${result.scanned.join(", ")}, ` +
              `+${result.inserted.toLocaleString()} rows, ` +
              `${summary.observations.toLocaleString()} observations, ` +
              `${Object.keys(service.profile?.scales ?? {}).length} profile slices`,
          );
        }
        // Uploading is the last thing an index run does, and nothing waits on
        // it: the profile is already trained and being served by the time the
        // first row leaves. A collector that is down costs a log line.
        void service
          .uploadTelemetry(log)
          .then((upload) => {
            if (upload.skipped === undefined) {
              log(
                `[telemetry] uploaded ${upload.uploaded.toLocaleString()} rows in ` +
                  `${upload.batches} batches, ${upload.remaining.toLocaleString()} pending`,
              );
            }
          })
          .catch((error: unknown) => {
            log(
              `[telemetry] upload error: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        if (queued) {
          queued = false;
          schedule("queued change");
        }
      })
      .catch((error: unknown) => {
        log(`[error] index failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /**
   * Run after the writes settle, and never more often than the floor allows.
   *
   * A change that lands inside the cooldown is not dropped: the timer is simply
   * set to the end of it, so the last event in a busy hour still gets its scan.
   */
  const schedule = (reason: string): void => {
    const sinceLast = Date.now() - lastScanAt;
    const delay = Math.max(DEBOUNCE_MS, MIN_SCAN_INTERVAL_MS - sinceLast);
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      runIndex(reason);
    }, delay);
    pending.unref?.();
  };

  const server = await startServer({
    service,
    dataDir,
    ...(options.port === undefined ? {} : { port: options.port }),
    onRebuild: () => runIndex("client requested rebuild", { force: true }),
  });
  log(`[ready] http://127.0.0.1:${server.port} (token in ${runtimeFilePath(dataDir)})`);

  const watchers: FSWatcher[] = [];
  for (const dir of [service.codexDir, service.claudeDir]) {
    if (!existsSync(dir)) {
      log(`[warn] history directory not found, skipping watch: ${dir}`);
      continue;
    }
    try {
      // Read-only: the watcher never writes to or modifies the history tree.
      const watcher = watch(dir, { recursive: true, persistent: true }, () => {
        schedule("history changed");
      });
      watcher.on("error", (error) => log(`[warn] watcher error on ${dir}: ${error.message}`));
      watchers.push(watcher);
    } catch (error) {
      log(`[warn] could not watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.skipInitialIndex !== true) runIndex("startup backfill");

  return {
    service,
    server,
    stop: async () => {
      if (pending) clearTimeout(pending);
      for (const watcher of watchers) watcher.close();
      await server.close();
      rmSync(runtimeFilePath(dataDir), { force: true });
      store.close();
    },
  };
}

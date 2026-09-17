#!/usr/bin/env node
import { PersonalStore, defaultDataDir } from "@token-forecaster/personal";

import { startDaemon } from "./daemon.js";
import { launcherPath, launcherTargets } from "./launcher.js";
import { findPython } from "./python.js";
import {
  installAlias,
  shellTargetFor,
  shippedTargets,
  syntaxFor,
  uninstallAlias,
} from "./shell-alias.js";
import { CompanionService } from "./service.js";
import { isUploadMode } from "./telemetry.js";

/**
 * Command line front end. Every command is a thin wrapper over
 * {@link CompanionService}; nothing here has behaviour of its own.
 */

const USAGE = `token-forecaster <command> [options]

Commands
  start                 Run the background daemon: backfill, watch, serve the API.
  index                 Import new history once and retrain, then exit.
  evaluate              Print the chronological holdout report.
  status                Print sources, profile and coverage.
  forecast              Print a forecast. Requires --provider and --scale.
  telemetry             Show or change what this machine uploads, if anything.
  reset                 Delete all derived data. History files are untouched.
  install-shell         Alias \`claude\` to the draft-aware launcher in your shell rc.
  uninstall-shell       Remove that alias and restore the shell rc.

Options
  --data-dir <path>     Override the application-support directory.
  --port <n>            Bind a fixed port (default: an OS-assigned free port).
  --provider <openai|anthropic>
  --scale <call|turn>
  --model <id>
  --reasoning <level>
  --json                Machine-readable output where supported.
  --rc <path>           Shell startup file for install-shell/uninstall-shell.

Telemetry options (all optional; with none of them, the command only reports)
  --mode <none|hash_only|redacted|full_opt_in>
                        What a row may carry. Default none: nothing is sent.
  --url <origin>        Collector origin. https, or http on localhost.
  --token <value>       Bearer token, or keychain:<service>[/<account>] on macOS.
  --resend              Forget what was already uploaded and send it again.
  --now                 Upload immediately instead of waiting for an index run.
`;

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const command = argv[0] ?? "help";
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), "true");
    }
  }
  return { command, flags };
}

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const num = (value: number): string => value.toLocaleString("en-US");
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dataDir = flags.get("data-dir") ?? defaultDataDir();
  const json = flags.get("json") === "true";

  if (command === "start") {
    const portFlag = flags.get("port");
    const daemon = await startDaemon({
      dataDir,
      ...(portFlag ? { port: Number.parseInt(portFlag, 10) } : {}),
    });
    const shutdown = (): void => {
      void daemon.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return -1; // Keep running.
  }

  if (command === "install-shell" || command === "uninstall-shell") {
    // An explicit --rc wins, and its own extension says which language it is
    // written in: a .ps1 is PowerShell, anything else is an rc file.
    const explicit = flags.get("rc");
    const target = explicit ? { rcPath: explicit, syntax: syntaxFor(explicit) } : shellTargetFor();
    if (!target) {
      out(
        `unsupported shell: ${process.env["SHELL"] ?? "(unset)"}. Pass --rc <path>, or add these lines yourself:`,
      );
      out(`  alias claude="${launcherPath(process.platform, "claude")}"`);
      out(`  alias codex="${launcherPath(process.platform, "codex")}"`);
      return 2;
    }
    const result =
      command === "install-shell"
        ? installAlias(target.rcPath, shippedTargets(launcherTargets()), target.syntax)
        : uninstallAlias(target.rcPath);
    out(`${result.message}: ${result.rcPath}`);
    if (result.backupPath) out(`original kept at ${result.backupPath}`);
    if (result.changed) {
      out(
        target.syntax === "powershell"
          ? `open a new PowerShell, or run: . $PROFILE`
          : `open a new terminal, or run: source ${result.rcPath}`,
      );
    }
    // The block is in place and both CLIs still work either way, so this is a
    // warning rather than a failure — but the draft forecast it was written
    // for cannot run without an interpreter, and nothing else would say so.
    if (command === "install-shell" && findPython() === null) {
      out("warning: no Python 3 on PATH, so the draft forecast will stay off until there is one");
    }
    return 0;
  }

  const store = PersonalStore.open(dataDir);
  const service = new CompanionService(store);
  try {
    switch (command) {
      case "index": {
        const started = Date.now();
        // Typing the command is an explicit ask to read the transcripts, so it
        // ignores the unchanged-tree check the daemon's watcher relies on.
        const result = await service.index({ force: true });
        if (result.skipped) {
          out("another index run is already in progress");
          return 1;
        }
        if (json) {
          out(JSON.stringify({ stats: result.stats, summary: store.summary() }, null, 2));
          return 0;
        }
        const summary = store.summary();
        out(`indexed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        for (const [provider, stats] of Object.entries(result.stats)) {
          const skipped = Object.entries(stats.skipped)
            .filter(([, n]) => n)
            .map(([reason, n]) => `${reason}=${n}`)
            .join(" ");
          out(
            `  ${provider}: ${num(stats.filesScanned)} files, ${num(stats.rowsUsed)} usable rows` +
              (skipped ? `, skipped ${skipped}` : ""),
          );
        }
        for (const slice of summary.providers) {
          out(
            `  stored ${slice.provider} ${slice.scale}: ${num(slice.count)} observations, ` +
              `${slice.models} models, ${slice.firstAt?.slice(0, 10) ?? "?"} → ${slice.lastAt?.slice(0, 10) ?? "?"}`,
          );
        }
        return 0;
      }

      case "evaluate": {
        const evaluation = service.evaluation() ?? (service.rebuild(), service.evaluation());
        if (!evaluation) {
          out("no evaluation available");
          return 1;
        }
        if (json) {
          out(JSON.stringify(evaluation, null, 2));
          return 0;
        }
        out(`chronological holdout — train fraction ${evaluation.trainFraction}`);
        for (const slice of evaluation.slices) {
          out("");
          out(
            `${slice.provider} · ${slice.scale} — fit on ${num(slice.trainN)}, scored on ${num(slice.holdoutN)}`,
          );
          out(
            "  candidate         n      P50cov  P90cov  P99cov  pinball   P90-P50   medP50",
          );
          for (const c of slice.candidates) {
            out(
              `  ${c.name.padEnd(16)}${num(c.n).padStart(6)}  ` +
                `${pct(c.coverageP50).padStart(6)}  ${pct(c.coverageP90).padStart(6)}  ` +
                `${pct(c.coverageP99).padStart(6)}  ${c.pinballMean.toFixed(1).padStart(7)}  ` +
                `${num(Math.round(c.meanIntervalWidth)).padStart(8)}  ${num(c.medianP50).padStart(7)}` +
                (c.name === slice.best ? "  <- best" : ""),
            );
          }
          out(
            `  conditioning beats this user's flat baseline: ${slice.conditioningHelps ? "yes" : "no"}` +
              `; prompt rungs help: ${slice.promptTiersHelp ? "yes" : "no"}`,
          );
        }
        out("");
        out(`prompt rungs adopted: ${evaluation.adoptPromptTiers} — ${evaluation.adoptPromptTiersReason}`);
        const excluded = Object.entries(evaluation.excluded).filter(([, n]) => n);
        if (excluded.length) {
          out(`excluded: ${excluded.map(([r, n]) => `${r}=${num(n)}`).join(", ")}`);
        }
        return 0;
      }

      case "status": {
        const summary = store.summary();
        if (json) {
          out(JSON.stringify({ summary, sources: service.sources(), profile: service.profile }, null, 2));
          return 0;
        }
        out(`data dir: ${dataDir}`);
        out(`paused:   ${service.paused}`);
        for (const source of service.sources()) {
          out(
            `${source.label.padEnd(12)} ${source.available ? "connected  " : "unavailable"} ` +
              `${num(source.files).padStart(6)} files  ${num(source.usableCalls).padStart(8)} calls  ${source.path}`,
          );
        }
        const profile = service.profile;
        out(
          profile
            ? `profile: ${profile.id}, built ${profile.generatedAt}, prompt rungs ${profile.promptTiersAdopted ? "on" : "off"}`
            : "profile: not built yet",
        );
        for (const slice of summary.providers) {
          out(`  ${slice.provider} ${slice.scale}: ${num(slice.count)} observations`);
        }
        return 0;
      }

      case "forecast": {
        const provider = flags.get("provider");
        const scale = flags.get("scale");
        if (provider !== "openai" && provider !== "anthropic") {
          out("--provider must be openai or anthropic");
          return 2;
        }
        if (scale !== "call" && scale !== "turn") {
          out("--scale must be call or turn");
          return 2;
        }
        const result = service.forecast({
          provider,
          scale,
          model: flags.get("model") ?? null,
          reasoning: flags.get("reasoning") ?? null,
        });
        if (json) {
          out(JSON.stringify(result, null, 2));
          return 0;
        }
        out(`P50 ${num(result.p50)}   P90 ${num(result.p90)}   P99 ${num(result.p99)}`);
        out(`source: ${result.source} — ${result.reason}`);
        return 0;
      }

      case "telemetry": {
        const mode = flags.get("mode");
        if (mode !== undefined && !isUploadMode(mode)) {
          out(`--mode must be one of none, hash_only, redacted, full_opt_in`);
          return 2;
        }
        service.setTelemetry({
          ...(isUploadMode(mode) ? { mode } : {}),
          ...(flags.has("url") ? { url: flags.get("url")! } : {}),
          ...(flags.has("token") ? { token: flags.get("token")! } : {}),
        });
        if (flags.get("resend") === "true") service.resetUploadCursor();

        const settings = service.telemetry;
        if (json) {
          out(JSON.stringify({ ...settings, pending: store.pendingUploadCount() }, null, 2));
        } else {
          out(`mode            ${settings.mode}`);
          out(`collector       ${settings.url || "(none)"}`);
          out(`token           ${settings.tokenConfigured ? "configured" : "(none)"}`);
          out(`installation    ${settings.installationId}`);
          out(`rows pending    ${num(store.pendingUploadCount())}`);
          if (settings.mode === "none") {
            out("");
            out("nothing is uploaded. `--mode redacted --url … --token …` turns it on.");
          }
        }
        if (flags.get("now") === "true") {
          const result = await service.uploadTelemetry((message) => out(message));
          out(
            result.skipped
              ? `not uploaded: ${result.skipped}`
              : `uploaded ${num(result.uploaded)} rows in ${result.batches} batches, ` +
                  `${num(result.remaining)} pending`,
          );
        }
        return 0;
      }

      case "reset": {
        service.reset();
        out("all derived data deleted; your Codex and Claude history files were not touched");
        return 0;
      }

      default:
        out(USAGE);
        return command === "help" || command === "--help" ? 0 : 2;
    }
  } finally {
    if (command !== "start") store.close();
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });

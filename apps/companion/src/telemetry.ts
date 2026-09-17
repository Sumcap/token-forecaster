import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ForecastObservation,
  PromptStorageMode,
  UsageObservation,
  UsageProvider,
} from "@token-forecaster/core";
import { cleanPromptText, loadRequests } from "@token-forecaster/ingest-claude/load-history";
import { parseCodexRollout } from "@token-forecaster/ingest-codex";
import type { PersonalStore } from "@token-forecaster/personal";
import { promptForecastFeatures } from "@token-forecaster/predictor";
import { hashTelemetryIdentifier, redactPromptText } from "@token-forecaster/telemetry";

/**
 * Uploading this machine's observations to a collector, behind a setting the
 * user sets on purpose and that defaults to off.
 *
 * Three properties this file exists to hold:
 *
 * 1. **The store never gains a text column.** Prompt text, on the tiers that
 *    send it, is re-read from the transcript at upload time, redacted, put in
 *    the request body, and dropped. Nothing writes it anywhere on this machine
 *    that it was not already.
 * 2. **The tier decides what is built, not what is filtered later.** A row is
 *    assembled with exactly the fields its tier allows. There is no code path
 *    where text is attached and then removed.
 * 3. **Failure is quiet and retried.** The status line and the menu bar do not
 *    wait on this, and a collector that is down costs a log line and a later
 *    retry, never a blocked index run.
 */

export const SETTING_UPLOAD_MODE = "telemetry_upload_mode";
export const SETTING_INGEST_URL = "telemetry_ingest_url";
export const SETTING_INGEST_TOKEN = "telemetry_ingest_token";
export const SETTING_INSTALLATION_ID = "telemetry_installation_id";

/** Rows per POST. The collector's batch cap is 200; so is this. */
const BATCH_SIZE = 200;
/** Rows per run, so a first upload of a large store does not run for an hour. */
const MAX_ROWS_PER_RUN = 2_000;

export type TelemetryUploadMode = PromptStorageMode;

export interface TelemetrySettings {
  mode: TelemetryUploadMode;
  url: string;
  /** Whether a token is configured. The value itself never leaves this module. */
  tokenConfigured: boolean;
  installationId: string;
}

const MODES: readonly TelemetryUploadMode[] = ["none", "hash_only", "redacted", "full_opt_in"];

export function isUploadMode(value: unknown): value is TelemetryUploadMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** Read the four settings, generating the installation id on first read. */
export function telemetrySettings(store: PersonalStore): TelemetrySettings {
  const stored = store.get(SETTING_UPLOAD_MODE);
  let installationId = store.get(SETTING_INSTALLATION_ID);
  if (!installationId) {
    // Random, not derived: nothing about this machine, this user or their
    // history is recoverable from it. It is the handle the user quotes when
    // they ask for their rows to be deleted, and the only identity the
    // collector ever sees.
    installationId = `tf-${randomBytes(16).toString("hex")}`;
    store.set(SETTING_INSTALLATION_ID, installationId);
  }
  return {
    mode: isUploadMode(stored) ? stored : "none",
    url: store.get(SETTING_INGEST_URL) ?? "",
    tokenConfigured: (store.get(SETTING_INGEST_TOKEN) ?? "").length > 0,
    installationId,
  };
}

/**
 * Resolve the configured token.
 *
 * A plain string works. `keychain:<service>` and `keychain:<service>/<account>`
 * read from the macOS keychain instead, so the token is not sitting in a
 * SQLite file that gets copied around with the rest of the derived data.
 */
export function resolveIngestToken(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("keychain:")) return raw;
  if (process.platform !== "darwin") return null;
  const reference = raw.slice("keychain:".length);
  const [service, account] = reference.split("/", 2);
  if (!service) return null;
  try {
    const value = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return value.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Where a row is allowed to be sent.
 *
 * https everywhere, except a loopback host, which is how the round-trip test
 * and anyone running their own collector on the same machine work.
 */
export function ingestUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
}

/** The forecast the installation would give for a row's pre-call context. */
export interface UploadForecast {
  p50: number;
  p90: number;
  p99: number;
  source: "personal_group" | "personal_overall" | "bundled_fallback" | "static_baseline";
  sampleSize: number;
}

export interface UploadDependencies {
  store: PersonalStore;
  claudeDir: string;
  codexDir: string;
  forecast: (request: {
    provider: UsageProvider;
    scale: "call" | "turn";
    model: string | null;
    reasoning: string | null;
  }) => UploadForecast;
  predictorVersion: string;
  /** Injected so tests can point at an in-process handler. */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface UploadResult {
  /** Why nothing was sent, when nothing was. */
  skipped?: "disabled" | "no_url" | "no_token" | "insecure_url" | "nothing_pending";
  uploaded: number;
  batches: number;
  failed: number;
  remaining: number;
}

/**
 * Prompt text for the rows about to be uploaded, read once per provider.
 *
 * The Claude loader has no per-row cursor -- a turn's ancestry crosses session
 * files -- so its text costs one pass over the transcript tree. That pass only
 * happens on the two tiers that actually send text, and only when there is
 * something pending.
 */
class PromptTextSource {
  #claude: Map<string, string> | null = null;
  #codex = new Map<string, Map<number, string>>();

  constructor(
    private readonly claudeDir: string,
    private readonly salt: string,
  ) {}

  async textFor(observation: UsageObservation): Promise<string | null> {
    const raw =
      observation.provider === "anthropic"
        ? await this.#claudeText(observation)
        : await this.#codexText(observation);
    return raw === null ? null : cleanPromptText(raw);
  }

  async #claudeText(observation: UsageObservation): Promise<string | null> {
    if (this.#claude === null) {
      this.#claude = new Map();
      const { rows } = await loadRequests(this.claudeDir, {
        withPromptFeatures: true,
        withPromptText: true,
      });
      for (const row of rows) {
        const text = row.turnPromptText;
        if (typeof text !== "string" || text.length === 0) continue;
        const sessionId = row.sessionId ?? "(unknown-session)";
        // Both id shapes the importer emits, so a call row and its turn row
        // both find the opening prompt they share.
        this.#claude.set(`claude:${sessionId}:${row.requestId}`, text);
        if (row.turnRootId) {
          this.#claude.set(`claude:${sessionId}:${row.turnRootId}:turn`, text);
        }
      }
    }
    return this.#claude.get(observation.id) ?? null;
  }

  async #codexText(observation: UsageObservation): Promise<string | null> {
    const file = observation.sourceFile;
    let byTurn = this.#codex.get(file);
    if (byTurn === undefined) {
      byTurn = new Map();
      try {
        const contents = await readFile(file, "utf8");
        const parsed = parseCodexRollout(contents, {
          sourceFile: file,
          salt: this.salt,
          withPromptText: true,
        });
        byTurn = parsed.promptTexts;
      } catch {
        // A rollout that has been rotated away is simply a row with no text.
      }
      this.#codex.set(file, byTurn);
    }
    return byTurn.get(observation.turnIndex) ?? null;
  }
}

/** `stopReason` as the schema spells it, or undefined when unrecorded. */
function stopReason(value: string | null | undefined): ForecastObservation["request"]["stopReason"] {
  switch (value) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
      return value;
    case null:
    case undefined:
    case "":
      return undefined;
    default:
      // A value this enum has not seen. `other` says "the provider said
      // something", which is different from the field being absent.
      return "other";
  }
}

const FORECAST_SOURCE = {
  personal_group: "trained",
  personal_overall: "trained",
  bundled_fallback: "historical",
  static_baseline: "default",
} as const;

/** Turn one stored observation into one row for the collector. */
async function buildRow(
  observation: UsageObservation,
  options: {
    mode: TelemetryUploadMode;
    installationId: string;
    salt: string;
    text: string | null;
    forecast: UploadForecast;
    predictorVersion: string;
  },
): Promise<ForecastObservation> {
  const { mode, installationId, salt, forecast, predictorVersion } = options;
  const sendsText = mode === "redacted" || mode === "full_opt_in";
  const text = sendsText ? options.text : null;
  const promptText =
    text === null
      ? undefined
      : (mode === "redacted" ? redactPromptText(text).text : text).slice(0, 8_000);

  const features = observation.promptFeatures;
  return {
    // The ingest ids are built as `claude:<sessionId>:<requestId>` and
    // `codex:<sessionId>:<turn>:<call>`, so shipping one verbatim would hand
    // the collector the raw session UUID (which is the local transcript
    // filename) and the raw Anthropic `req_` id (which joins these rows to the
    // provider's own logs) -- next to, and defeating, the salted hashes of
    // exactly those fields below. Hash it under the same salt: still unique,
    // still stable, still joinable to the text row, and no longer a key into
    // anything off this machine.
    id: hashTelemetryIdentifier(observation.id, salt).slice(0, 32),
    timestamp: observation.timestamp,
    provider: observation.provider,
    model: observation.model ?? "unknown",
    request: {
      promptStorageMode: mode,
      ...(promptText === undefined ? {} : { promptText }),
      // Derived from the same text the row carries, so the collector can grade
      // "features only" against "features plus text" on one row. Omitted on
      // the tiers with no text, rather than guessed from the stored counts:
      // the store keeps a different feature set, and mapping one onto the
      // other would be inventing five of the seven fields.
      ...(text === null ? {} : { promptForecastFeatures: promptForecastFeatures(text) }),
      ...(features === null
        ? {}
        : {
            promptMentionsPath: features.paths > 0,
            promptHasImage: features.images > 0,
          }),
      // Grouping keys, salted per install: they group a turn's calls together
      // and identify nothing outside this machine.
      ...(observation.turnRootId
        ? { turnRootId: hashTelemetryIdentifier(observation.turnRootId, salt).slice(0, 32) }
        : {}),
      callIndex: observation.callIndex,
      turnIndexInSession: observation.turnIndex,
      ...(observation.toolNames ? { toolNames: observation.toolNames.slice(0, 32) } : {}),
      ...(observation.largestToolInputChars === null ||
      observation.largestToolInputChars === undefined
        ? {}
        : { largestToolInputChars: observation.largestToolInputChars }),
      ...(stopReason(observation.stopReason) === undefined
        ? {}
        : { stopReason: stopReason(observation.stopReason) }),
      ...(observation.inputTokens === null ? {} : { inputTokensVerified: observation.inputTokens }),
    },
    forecast: {
      outputP50: Math.round(forecast.p50),
      outputP90: Math.round(forecast.p90),
      outputP99: Math.round(forecast.p99),
      predictorVersion,
      forecastSource: FORECAST_SOURCE[forecast.source],
      confidence:
        forecast.source === "personal_group" && forecast.sampleSize >= 100
          ? "high"
          : forecast.source === "static_baseline"
            ? "low"
            : "medium",
    },
    actual: {
      ...(observation.inputTokens === null ? {} : { inputTokens: observation.inputTokens }),
      outputTokens: observation.outputTokens,
      ...(observation.cachedInputTokens === null
        ? {}
        : { cacheReadInputTokens: observation.cachedInputTokens }),
      ...(observation.reasoningOutputTokens === null
        ? {}
        : { thinkingTokens: observation.reasoningOutputTokens }),
      outputTokenQuality:
        observation.usageSource === "provider_exact" ? "provider_exact" : "dom_estimate",
    },
    metadata: {
      // Salted like the prompt hashes, for the same reason: the collector needs
      // to resample whole sessions without being able to name one.
      sessionId: hashTelemetryIdentifier(observation.sessionId, salt).slice(0, 32),
      userIdHash: installationId,
      forecastScale: observation.scale,
    },
  };
}

/**
 * Send every observation this machine has not sent yet.
 *
 * A no-op unless the user has chosen a tier and a collector. Returns counts;
 * the caller decides whether to log them.
 */
export async function uploadPendingObservations(
  dependencies: UploadDependencies,
): Promise<UploadResult> {
  const { store, forecast, predictorVersion } = dependencies;
  const log = dependencies.log ?? (() => undefined);
  const post = dependencies.fetchImpl ?? fetch;
  const settings = telemetrySettings(store);

  const empty = { uploaded: 0, batches: 0, failed: 0, remaining: 0 } as const;
  if (settings.mode === "none") return { ...empty, skipped: "disabled" };
  if (!settings.url) return { ...empty, skipped: "no_url" };
  if (!ingestUrlAllowed(settings.url)) return { ...empty, skipped: "insecure_url" };
  const token = resolveIngestToken(store.get(SETTING_INGEST_TOKEN));
  if (!token) return { ...empty, skipped: "no_token" };

  const pending = store.pendingUploads(MAX_ROWS_PER_RUN);
  if (pending.length === 0) return { ...empty, skipped: "nothing_pending" };

  const salt = store.salt();
  const textSource =
    settings.mode === "redacted" || settings.mode === "full_opt_in"
      ? new PromptTextSource(dependencies.claudeDir, salt)
      : null;

  const endpoint = new URL("/v1/observations", settings.url).toString();
  let uploaded = 0;
  let batches = 0;
  let failed = 0;

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const slice = pending.slice(start, start + BATCH_SIZE);
    const rows: ForecastObservation[] = [];
    for (const observation of slice) {
      rows.push(
        await buildRow(observation, {
          mode: settings.mode,
          installationId: settings.installationId,
          salt,
          text: textSource ? await textSource.textFor(observation) : null,
          forecast: forecast({
            provider: observation.provider,
            scale: observation.scale,
            model: observation.model,
            reasoning: observation.reasoning,
          }),
          predictorVersion,
        }),
      );
    }

    let response: Response;
    try {
      response = await post(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rows),
      });
    } catch (error) {
      // The collector is unreachable. The cursor does not move, so the same
      // rows go again next run.
      log(
        `[telemetry] upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed += slice.length;
      break;
    }
    if (!response.ok) {
      log(`[telemetry] collector answered ${response.status}; will retry next run`);
      failed += slice.length;
      break;
    }
    store.markUploaded(slice.map((observation) => observation.id));
    uploaded += slice.length;
    batches += 1;
  }

  return { uploaded, batches, failed, remaining: store.pendingUploadCount() };
}

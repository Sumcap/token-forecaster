import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  DEFAULT_PROMPT_STORAGE_MODE,
  forecastObservationSchema,
  promptStorageModeSchema,
} from "@token-forecaster/core";
import type {
  ForecastObservation,
  PromptStorageMode,
} from "@token-forecaster/core";

export {
  DEFAULT_PROMPT_STORAGE_MODE,
  forecastObservationSchema,
  promptStorageModeSchema,
};
export type { ForecastObservation, PromptStorageMode };
export { createTelemetryIngestHandler } from "./http-ingest.js";
export type { TelemetryIngestOptions } from "./http-ingest.js";
export {
  JsonlExtensionTelemetryWriter,
  JsonlInstallationRegistry,
  createExtensionTelemetryIngestHandler,
  readExtensionTelemetryJsonl,
  telemetryTokensEqual,
} from "./extension-ingest.js";
export type {
  AnonymousInstallationCredentials,
  ExtensionTelemetryIngestOptions,
  StoredExtensionTelemetryEvent,
} from "./extension-ingest.js";

export function hashTelemetryIdentifier(value: string, salt: string): string {
  if (!salt) throw new Error("telemetry hash salt must not be empty");
  return createHash("sha256")
    .update("token-forecaster-telemetry\0")
    .update(salt)
    .update("\0")
    .update(value)
    .digest("hex");
}

export interface JsonlTelemetryWriterOptions {
  filePath: string;
  /** fsync is intentionally left to the host/shipper; each line is one append. */
  mode?: PromptStorageMode;
}

/**
 * Append-only, schema-valid JSONL. Calls are serialized so concurrent response
 * completions cannot interleave bytes and corrupt a line.
 */
export class JsonlTelemetryWriter {
  readonly filePath: string;
  readonly mode: PromptStorageMode;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: JsonlTelemetryWriterOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error("telemetry filePath must be absolute");
    }
    this.filePath = options.filePath;
    this.mode = promptStorageModeSchema.parse(
      options.mode ?? DEFAULT_PROMPT_STORAGE_MODE,
    );
  }

  append(observation: ForecastObservation): Promise<void> {
    const parsed = forecastObservationSchema.parse(observation);
    const line = `${JSON.stringify(parsed)}\n`;
    const write = this.pending.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    });
    // Keep the queue usable after a failed append while still rejecting this
    // caller's promise with the original error.
    this.pending = write.catch(() => undefined);
    return write;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export async function* readTelemetryJsonl(
  filePath: string,
): AsyncGenerator<ForecastObservation> {
  const lines = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    yield forecastObservationSchema.parse(JSON.parse(line));
  }
}

const pinball = (actual: number, forecast: number, probability: number): number =>
  actual >= forecast
    ? probability * (actual - forecast)
    : (1 - probability) * (forecast - actual);

export interface AccuracySummary {
  calls: number;
  totalPinballLoss: number;
  p50: { coverage: number; pinballLoss: number; averageWidthFromP50: 0 };
  p90: { coverage: number; pinballLoss: number; averageWidthFromP50: number };
  p99: {
    coverage: number | null;
    pinballLoss: number | null;
    averageWidthFromP50: number | null;
  };
}

/** Compare pre-call forecasts with completed outcomes; unfinished rows skip. */
export function summarizeForecastAccuracy(
  observations: readonly ForecastObservation[],
): AccuracySummary {
  const complete = observations.filter(
    (observation) => observation.actual !== undefined && !observation.actual.isCensored,
  );
  if (complete.length === 0) {
    throw new Error("at least one uncensored completed observation is required");
  }
  let p50Loss = 0;
  let p90Loss = 0;
  let p99Loss = 0;
  let p50Covered = 0;
  let p90Covered = 0;
  let p99Covered = 0;
  let p90Width = 0;
  let p99Width = 0;
  let p99Calls = 0;
  for (const observation of complete) {
    const actual = observation.actual!.outputTokens;
    const p50 = observation.forecast.outputP50;
    const p90 = observation.forecast.outputP90;
    p50Loss += pinball(actual, p50, 0.5);
    p90Loss += pinball(actual, p90, 0.9);
    p50Covered += actual <= p50 ? 1 : 0;
    p90Covered += actual <= p90 ? 1 : 0;
    p90Width += p90 - p50;
    if (observation.forecast.outputP99 !== undefined) {
      const p99 = observation.forecast.outputP99;
      p99Calls++;
      p99Loss += pinball(actual, p99, 0.99);
      p99Covered += actual <= p99 ? 1 : 0;
      p99Width += p99 - p50;
    }
  }
  const calls = complete.length;
  return {
    calls,
    totalPinballLoss:
      p50Loss / calls + p90Loss / calls + (p99Calls ? p99Loss / p99Calls : 0),
    p50: { coverage: p50Covered / calls, pinballLoss: p50Loss / calls, averageWidthFromP50: 0 },
    p90: {
      coverage: p90Covered / calls,
      pinballLoss: p90Loss / calls,
      averageWidthFromP50: p90Width / calls,
    },
    p99: {
      coverage: p99Calls ? p99Covered / p99Calls : null,
      pinballLoss: p99Calls ? p99Loss / p99Calls : null,
      averageWidthFromP50: p99Calls ? p99Width / p99Calls : null,
    },
  };
}

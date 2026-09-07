import { timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { forecastObservationSchema } from "@token-forecaster/core";
import type { ForecastObservation } from "@token-forecaster/core";
import type { JsonlTelemetryWriter } from "./index.js";

export interface TelemetryIngestOptions {
  /**
   * Where feature rows land. Every accepted row is written here, prompt text
   * removed, so the feature file alone is a complete dataset and grading text
   * against features is a join on `id`.
   */
  writer: JsonlTelemetryWriter;
  /**
   * Where prompt text lands, when the operator has opted the deployment in.
   *
   * A separate file so its permissions, retention and backup can differ from
   * the features'. With no text writer configured, a row carrying text is
   * still accepted -- its features are worth keeping -- and the text is
   * dropped. Silently: the client already knows what it sent.
   */
  textWriter?: JsonlTelemetryWriter;
  bearerToken: string;
  /** Reject unexpectedly large single rows before parsing. Defaults to 256 KiB. */
  maxBodyBytes?: number;
  /** Reject unexpectedly large batches. Defaults to 2 MiB. */
  maxBatchBytes?: number;
  /** Longest accepted batch. Defaults to 200 observations. */
  maxBatchSize?: number;
  /**
   * Where deletion tombstones are appended. Defaults to `deletions.jsonl`
   * beside the feature file.
   */
  deletionsFilePath?: string;
}

class BodyTooLargeError extends Error {}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function respond(
  response: ServerResponse,
  status: number,
  payload?: Record<string, unknown>,
): void {
  if (payload === undefined) {
    response.writeHead(status).end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The same row with no prompt text and no claim to be carrying any. */
function withoutPromptText(observation: ForecastObservation): ForecastObservation {
  if (observation.request.promptText === undefined) return observation;
  const request = { ...observation.request };
  delete request.promptText;
  return { ...observation, request };
}

/**
 * An installation id is an opaque local identifier, so the only thing worth
 * checking is that it cannot escape into a path or a log line.
 */
const INSTALLATION_ID = /^[A-Za-z0-9._~-]{8,128}$/;

/**
 * Minimal VM ingest surface. Put it behind TLS; it never logs request bodies.
 *
 * Routes:
 * - `POST /v1/observations` — one observation, or an array of up to
 *   `maxBatchSize` of them.
 * - `DELETE /v1/installations/:installationId` — records a tombstone and
 *   answers 202. The rows themselves go when `scripts/purge-installation.mjs`
 *   next runs; an append-only JSONL cannot be rewritten under live appends,
 *   and pretending otherwise would be a delete path that quietly loses rows.
 * - `GET /healthz` — the only unauthenticated route.
 *
 * Zod strips unrecognized fields and now also enforces the prompt-storage
 * contract, so a row claiming `hash_only` while carrying a prompt is a 400
 * rather than a file that has to be cleaned up afterwards.
 */
export function createTelemetryIngestHandler(
  options: TelemetryIngestOptions,
): RequestListener {
  if (!options.bearerToken) throw new Error("telemetry bearerToken must not be empty");
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const maxBatchBytes = options.maxBatchBytes ?? 2 * 1024 * 1024;
  const maxBatchSize = options.maxBatchSize ?? 200;
  for (const [name, value] of [
    ["maxBodyBytes", maxBodyBytes],
    ["maxBatchBytes", maxBatchBytes],
    ["maxBatchSize", maxBatchSize],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  const deletionsFilePath =
    options.deletionsFilePath ??
    path.join(path.dirname(options.writer.filePath), "deletions.jsonl");

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        respond(response, 204);
        return;
      }

      const deletion = /^\/v1\/installations\/([^/]+)$/.exec(url.pathname);
      const isObservations =
        request.method === "POST" && url.pathname === "/v1/observations";
      if (!isObservations && !(request.method === "DELETE" && deletion)) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request.headers.authorization, options.bearerToken)) {
        response.setHeader("www-authenticate", "Bearer");
        respond(response, 401, { error: "unauthorized" });
        return;
      }

      if (deletion) {
        const installationId = decodeURIComponent(deletion[1]!);
        if (!INSTALLATION_ID.test(installationId)) {
          respond(response, 400, { error: "invalid_installation_id" });
          return;
        }
        try {
          await mkdir(path.dirname(deletionsFilePath), { recursive: true });
          await appendFile(
            deletionsFilePath,
            `${JSON.stringify({
              type: "deletion_requested",
              installationId,
              requestedAt: new Date().toISOString(),
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        } catch {
          respond(response, 500, { error: "deletion_failed" });
          return;
        }
        respond(response, 202, { accepted: true, purgePending: true });
        return;
      }

      if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
        respond(response, 415, { error: "application_json_required" });
        return;
      }

      let observations: ForecastObservation[];
      try {
        const raw = await readBody(request, maxBatchBytes);
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) {
            respond(response, 400, { error: "empty_batch" });
            return;
          }
          if (parsed.length > maxBatchSize) {
            respond(response, 413, { error: "batch_too_large" });
            return;
          }
          observations = parsed.map((row) => forecastObservationSchema.parse(row));
        } else {
          // A single row keeps the tighter cap it has always had; the larger
          // one exists for batches, not for one enormous observation.
          if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
            respond(response, 413, { error: "observation_too_large" });
            return;
          }
          observations = [forecastObservationSchema.parse(parsed)];
        }
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          respond(response, 413, { error: "observation_too_large" });
        } else {
          // Do not echo validation details: they can contain submitted values.
          respond(response, 400, { error: "invalid_observation" });
        }
        return;
      }

      try {
        let textRows = 0;
        for (const observation of observations) {
          if (observation.request.promptText !== undefined && options.textWriter) {
            await options.textWriter.append(observation);
            textRows += 1;
          }
          await options.writer.append(withoutPromptText(observation));
        }
        respond(response, 202, {
          accepted: true,
          observations: observations.length,
          textRows,
        });
      } catch {
        respond(response, 500, { error: "ingest_failed" });
      }
    })().catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "ingest_failed" });
      else response.end();
    });
  };
}

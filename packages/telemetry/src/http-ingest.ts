import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { forecastObservationSchema } from "@token-forecaster/core";
import type { ForecastObservation } from "@token-forecaster/core";
import type { JsonlTelemetryWriter } from "./index.js";

export interface TelemetryIngestOptions {
  writer: JsonlTelemetryWriter;
  bearerToken: string;
  /** Reject unexpectedly large rows before parsing. Defaults to 256 KiB. */
  maxBodyBytes?: number;
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

/**
 * Minimal VM ingest surface. Put it behind TLS; it never logs request bodies.
 * Zod strips unrecognized fields, so a mistakenly submitted raw prompt is not
 * persisted by the JSONL writer.
 */
export function createTelemetryIngestHandler(
  options: TelemetryIngestOptions,
): RequestListener {
  if (!options.bearerToken) throw new Error("telemetry bearerToken must not be empty");
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer");
  }

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        respond(response, 204);
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/observations") {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request.headers.authorization, options.bearerToken)) {
        response.setHeader("www-authenticate", "Bearer");
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
        respond(response, 415, { error: "application_json_required" });
        return;
      }

      let observation: ForecastObservation;
      try {
        const raw = await readBody(request, maxBodyBytes);
        observation = forecastObservationSchema.parse(JSON.parse(raw));
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
        await options.writer.append(observation);
        respond(response, 202, { accepted: true });
      } catch {
        respond(response, 500, { error: "ingest_failed" });
      }
    })().catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "ingest_failed" });
      else response.end();
    });
  };
}

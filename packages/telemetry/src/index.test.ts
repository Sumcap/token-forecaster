import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForecastObservation } from "@token-forecaster/core";
import {
  JsonlTelemetryWriter,
  createTelemetryIngestHandler,
  hashTelemetryIdentifier,
  readTelemetryJsonl,
  summarizeForecastAccuracy,
} from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function observation(id: string, actual: number): ForecastObservation {
  return {
    id,
    timestamp: "2026-08-06T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    request: { messageCount: 1, toolCount: 0, maxTokens: 8_000 },
    forecast: {
      outputP50: 500,
      outputP90: 1_000,
      outputP99: 2_000,
      predictorVersion: "test",
      forecastSource: "trained",
      confidence: "medium",
    },
    actual: { inputTokens: 100, outputTokens: actual, isCensored: false },
  };
}

describe("JSONL telemetry", () => {
  it("serializes concurrent appends into independently valid lines", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-telemetry-"));
    directories.push(directory);
    const filePath = path.join(directory, "observations.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath });
    await Promise.all([writer.append(observation("a", 400)), writer.append(observation("b", 1_500))]);
    const read = [];
    for await (const row of readTelemetryJsonl(filePath)) read.push(row);
    expect(read.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("hashes identifiers with a required deployment salt", () => {
    expect(hashTelemetryIdentifier("user-a", "salt")).toHaveLength(64);
    expect(hashTelemetryIdentifier("user-a", "salt")).not.toBe(
      hashTelemetryIdentifier("user-a", "different"),
    );
    expect(() => hashTelemetryIdentifier("user-a", "")).toThrow(/salt/);
  });

  it("summarizes loss, coverage, and sharpness", () => {
    const summary = summarizeForecastAccuracy([observation("a", 400), observation("b", 1_500)]);
    expect(summary.calls).toBe(2);
    expect(summary.p50.coverage).toBe(0.5);
    expect(summary.p90.coverage).toBe(0.5);
    expect(summary.p99.coverage).toBe(1);
    expect(summary.p90.averageWidthFromP50).toBe(500);
  });

  it("authenticates VM ingest and strips accidental raw fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-ingest-"));
    directories.push(directory);
    const filePath = path.join(directory, "observations.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath });
    const server = createServer(
      createTelemetryIngestHandler({ writer, bearerToken: "test-secret" }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      ...observation("remote", 700),
      request: {
        ...observation("remote", 700).request,
        rawPrompt: "this must never reach disk",
      },
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(unauthorized.status).toBe(401);

      const accepted = await fetch(`http://127.0.0.1:${port}/v1/observations`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        },
        body,
      });
      expect(accepted.status).toBe(202);
      await writer.flush();
      expect(await readFile(filePath, "utf8")).not.toContain("must never reach disk");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

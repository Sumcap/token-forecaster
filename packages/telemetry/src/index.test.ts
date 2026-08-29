import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForecastObservation } from "@token-forecaster/core";
import {
  JsonlExtensionTelemetryWriter,
  JsonlInstallationRegistry,
  JsonlTelemetryWriter,
  createExtensionTelemetryIngestHandler,
  createTelemetryIngestHandler,
  hashTelemetryIdentifier,
  readTelemetryJsonl,
  summarizeForecastAccuracy,
} from "./index.js";
import {
  EXTENSION_TELEMETRY_SCHEMA_VERSION,
  type ExtensionTelemetryClientEvent,
} from "@token-forecaster/core";

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

function diagnosticEvent(id: string): ExtensionTelemetryClientEvent {
  return {
    schemaVersion: EXTENSION_TELEMETRY_SCHEMA_VERSION,
    id: `diagnostic-${id}-00000000`,
    timestamp: "2026-08-27T12:00:00.000Z",
    extensionVersion: "0.1.0",
    consentVersion: 1,
    kind: "diagnostic",
    name: "extension_ready",
    outcome: "success",
    code: "ok",
    surface: "claude_code",
  };
}

describe("anonymous extension ingest", () => {
  it("registers per-install credentials, strips unknown data, and physically deletes rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-extension-ingest-"));
    directories.push(directory);
    const filePath = path.join(directory, "events.jsonl");
    const registryFile = path.join(directory, "installations.jsonl");
    const writer = new JsonlExtensionTelemetryWriter({ filePath });
    const registry = new JsonlInstallationRegistry({
      filePath: registryFile,
      tokenSecret: "test-secret-that-is-at-least-32-characters-long",
    });
    const server = createServer(createExtensionTelemetryIngestHandler({ writer, registry }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const registration = await fetch(`http://127.0.0.1:${port}/v1/installations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionVersion: "0.1.0", consentVersion: 1 }),
      });
      expect(registration.status).toBe(201);
      const credentials = (await registration.json()) as {
        accessToken: string;
        deletionToken: string;
      };
      expect(credentials.accessToken).toHaveLength(43);
      expect(await readFile(registryFile, "utf8")).not.toContain(credentials.accessToken);

      const submitted = { ...diagnosticEvent("one"), rawPrompt: "must never persist" };
      const accepted = await fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: [submitted] }),
      });
      expect(accepted.status).toBe(202);
      const retried = await fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: [submitted] }),
      });
      expect(retried.status).toBe(202);
      await writer.flush();
      const stored = await readFile(filePath, "utf8");
      expect(stored).toContain("extension_ready");
      expect(stored).not.toContain("must never persist");
      expect(stored.trim().split("\n")).toHaveLength(1);

      const removed = await fetch(`http://127.0.0.1:${port}/v1/installations/current`, {
        method: "DELETE",
        headers: { authorization: `Deletion ${credentials.deletionToken}` },
      });
      expect(removed.status).toBe(204);
      await writer.flush();
      expect(await readFile(filePath, "utf8")).toBe("");

      const replay = await fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: [diagnosticEvent("two")] }),
      });
      expect(replay.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

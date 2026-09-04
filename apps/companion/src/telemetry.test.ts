import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseCodexRollout } from "@token-forecaster/ingest-codex";
import { PersonalStore } from "@token-forecaster/personal";
import { JsonlTelemetryWriter, createTelemetryIngestHandler } from "@token-forecaster/telemetry";

import {
  SETTING_INGEST_TOKEN,
  SETTING_INGEST_URL,
  SETTING_UPLOAD_MODE,
  ingestUrlAllowed,
  uploadPendingObservations,
  type TelemetryUploadMode,
} from "./telemetry.js";

/**
 * The uploader against a real collector: the shipped ingest handler, real
 * JSONL writers, real files. A mocked collector would pass whatever the
 * uploader sent, which is exactly the thing under test.
 *
 * The corpus is one synthetic Codex rollout, parsed by the shipped parser, so
 * the rows in the store are the rows the daemon would have.
 */

const TOKEN = "round-trip-token-0123456789";

/** A prompt with one of each thing the `redacted` tier promises to remove. */
const PROMPT =
  "Fix the loader in /Users/somebody/work/repo/src/load.ts, " +
  "it is documented at https://wiki.internal.example.com/loader " +
  "and the key is sk-ant-api03-QqWwEeRrTtYyUuIiOoPp.";

const temporaries: string[] = [];
afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "tf-upload-"));
  temporaries.push(directory);
  return directory;
}

/** A minimal rollout: one turn, one call, real usage. */
function writeRollout(directory: string): string {
  const at = "2026-09-04T10:00:00.000Z";
  const rows = [
    { timestamp: at, type: "session_meta", payload: { id: "sess-0001", cli_version: "1.0.0" } },
    { timestamp: at, type: "turn_context", payload: { model: "gpt-5.4", effort: "medium" } },
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: PROMPT } },
    {
      timestamp: at,
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: "run the tests" },
    },
    {
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 400_000,
          last_token_usage: {
            input_tokens: 1_200,
            cached_input_tokens: 900,
            output_tokens: 640,
            reasoning_output_tokens: 300,
            total_tokens: 1_840,
          },
          total_token_usage: { total_tokens: 1_840 },
        },
      },
    },
  ];
  const file = join(directory, "rollout-2026-09-04T10-00-00-sess-0001.jsonl");
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return file;
}

interface Collector {
  url: string;
  featureFile: string;
  textFile: string;
  close: () => Promise<void>;
}

async function startCollector(directory: string): Promise<Collector> {
  const featureFile = join(directory, "observations.jsonl");
  const textFile = join(directory, "observations-text.jsonl");
  const writer = new JsonlTelemetryWriter({ filePath: featureFile, mode: "hash_only" });
  // Deliberately the most permissive server mode, so what lands in the text
  // file is what the CLIENT chose to send, not what the server cleaned up.
  const textWriter = new JsonlTelemetryWriter({ filePath: textFile, mode: "full_opt_in" });
  const server: Server = createServer(
    createTelemetryIngestHandler({ writer, textWriter, bearerToken: TOKEN }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    featureFile,
    textFile,
    close: async () => {
      await writer.flush();
      await textWriter.flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runUpload(mode: TelemetryUploadMode) {
  const directory = temporary();
  const rolloutFile = writeRollout(directory);
  const store = PersonalStore.open(join(directory, "data"));
  const parsed = parseCodexRollout(readFileSync(rolloutFile, "utf8"), {
    sourceFile: rolloutFile,
    salt: store.salt(),
  });
  store.ingest("openai", parsed.observations, new Map(), parsed.stats);

  const collector = await startCollector(directory);
  store.set(SETTING_UPLOAD_MODE, mode);
  store.set(SETTING_INGEST_URL, collector.url);
  store.set(SETTING_INGEST_TOKEN, TOKEN);

  const result = await uploadPendingObservations({
    store,
    claudeDir: join(directory, "no-claude-history"),
    codexDir: directory,
    predictorVersion: "test-profile",
    forecast: () => ({ p50: 500, p90: 2_000, p99: 8_000, source: "bundled_fallback", sampleSize: 0 }),
  });
  await collector.close();
  const read = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, never>)
      : [];
  const features = read(collector.featureFile);
  const texts = read(collector.textFile);
  store.close();
  return { result, features, texts, storedRows: parsed.observations.length };
}

describe("telemetry upload", () => {
  it("sends nothing at all when the tier is none", async () => {
    const { result, features, texts } = await runUpload("none");
    expect(result.skipped).toBe("disabled");
    expect(result.uploaded).toBe(0);
    expect(features).toHaveLength(0);
    expect(texts).toHaveLength(0);
  });

  it("sends features and no text under hash_only", async () => {
    const { result, features, texts, storedRows } = await runUpload("hash_only");
    expect(result.skipped).toBeUndefined();
    expect(result.uploaded).toBe(storedRows);
    expect(features).toHaveLength(storedRows);
    expect(texts).toHaveLength(0);
    for (const row of features) {
      expect(row).not.toHaveProperty("request.promptText");
      expect(JSON.stringify(row)).not.toContain("sk-ant-");
    }
  });

  it("sends redacted text under redacted, with the features beside it", async () => {
    const { result, features, texts, storedRows } = await runUpload("redacted");
    expect(result.skipped).toBeUndefined();
    expect(features).toHaveLength(storedRows);
    expect(texts.length).toBeGreaterThan(0);

    const featureIds = new Set(features.map((row) => (row as { id: string }).id));
    for (const row of texts) {
      const typed = row as unknown as {
        id: string;
        request: { promptText: string; promptStorageMode: string; promptForecastFeatures: unknown };
      };
      // The text row joins to a feature row by id: that join is the whole
      // point of splitting the two files.
      expect(featureIds.has(typed.id)).toBe(true);
      expect(typed.request.promptStorageMode).toBe("redacted");
      expect(typed.request.promptText).toContain("<path>");
      expect(typed.request.promptText).toContain("<url>");
      expect(typed.request.promptText).toContain("<secret>");
      expect(typed.request.promptText).not.toContain("/Users/somebody");
      expect(typed.request.promptText).not.toContain("sk-ant-api03");
      expect(typed.request.promptText).toContain("Fix the loader in");
      // Features are computed from the same text, so the collector can grade
      // one against the other on one row.
      expect(typed.request.promptForecastFeatures).toBeTruthy();
    }
    // Nothing verbatim reached the feature file either.
    expect(JSON.stringify(features)).not.toContain("/Users/somebody");
  });

  it("sends the prompt verbatim under full_opt_in", async () => {
    const { texts } = await runUpload("full_opt_in");
    expect(texts.length).toBeGreaterThan(0);
    for (const row of texts) {
      const typed = row as unknown as {
        request: { promptText: string; promptStorageMode: string };
      };
      expect(typed.request.promptStorageMode).toBe("full_opt_in");
      expect(typed.request.promptText).toBe(PROMPT);
    }
  });

  it("carries the loop-structure columns the importers now fill in", async () => {
    const { features } = await runUpload("hash_only");
    const call = features.find(
      (row) => (row as { metadata: { forecastScale: string } }).metadata.forecastScale === "call",
    ) as unknown as {
      request: { toolNames: string[]; largestToolInputChars: number; callIndex: number };
      actual: { outputTokens: number };
    };
    expect(call.request.toolNames).toEqual(["exec"]);
    expect(call.request.largestToolInputChars).toBe("run the tests".length);
    expect(call.request.callIndex).toBe(0);
    expect(call.actual.outputTokens).toBe(640);
  });

  it("does not re-send a row it has already sent", async () => {
    const directory = temporary();
    const rolloutFile = writeRollout(directory);
    const store = PersonalStore.open(join(directory, "data"));
    const parsed = parseCodexRollout(readFileSync(rolloutFile, "utf8"), {
      sourceFile: rolloutFile,
      salt: store.salt(),
    });
    store.ingest("openai", parsed.observations, new Map(), parsed.stats);
    const collector = await startCollector(directory);
    store.set(SETTING_UPLOAD_MODE, "hash_only");
    store.set(SETTING_INGEST_URL, collector.url);
    store.set(SETTING_INGEST_TOKEN, TOKEN);
    const dependencies = {
      store,
      claudeDir: join(directory, "no-claude-history"),
      codexDir: directory,
      predictorVersion: "test-profile",
      forecast: () =>
        ({ p50: 500, p90: 2_000, p99: 8_000, source: "bundled_fallback", sampleSize: 0 }) as const,
    };
    const first = await uploadPendingObservations(dependencies);
    const second = await uploadPendingObservations(dependencies);
    await collector.close();
    store.close();
    expect(first.uploaded).toBeGreaterThan(0);
    expect(second.skipped).toBe("nothing_pending");
  });
});

describe("ingestUrlAllowed", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(ingestUrlAllowed("https://telemetry.example.com")).toBe(true);
    expect(ingestUrlAllowed("http://127.0.0.1:8787")).toBe(true);
    expect(ingestUrlAllowed("http://localhost:8787")).toBe(true);
    expect(ingestUrlAllowed("http://telemetry.example.com")).toBe(false);
    expect(ingestUrlAllowed("ftp://example.com")).toBe(false);
    expect(ingestUrlAllowed("not a url")).toBe(false);
  });
});

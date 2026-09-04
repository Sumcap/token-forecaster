import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ForecastObservation } from "@token-forecaster/core";

import { createTelemetryIngestHandler } from "./http-ingest.js";
import { JsonlTelemetryWriter } from "./index.js";

/**
 * The gate the plan names: nothing ships to a collector until a `hash_only`
 * row serialised by the writer provably contains no prompt text.
 *
 * These assertions are on FILE BYTES, not on parsed objects. A schema that
 * drops a field and a serialiser that writes it anyway would both pass an
 * object comparison; only reading the file back catches the second.
 */

const root = mkdtempSync(path.join(tmpdir(), "tf-leak-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SECRET_PROMPT = [
  "Fix the importer in /Users/polpedu/Projects/token-forecaster/packages/core/src/schemas.ts.",
  "It is documented at https://internal.example.com/runbooks/ingest and owned by ada@example.org.",
  "The fixture digest is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "and the upload token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9AAbbCC112233445566.",
  "Use ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv when you run it.",
].join("\n");

/** Every substring that must not appear in any file this test writes. */
const FORBIDDEN = [
  "/Users/polpedu/Projects/token-forecaster/packages/core/src/schemas.ts",
  "internal.example.com",
  "ada@example.org",
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9AAbbCC112233445566",
  "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
];

function observation(overrides: Partial<ForecastObservation["request"]> = {}): ForecastObservation {
  return {
    id: "leak-test-row",
    timestamp: "2026-09-04T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    request: {
      messageCount: 12,
      turnRootId: "5c0b3f3e-0000-4000-8000-000000000001",
      callIndex: 3,
      toolNames: ["Read", "Edit"],
      largestToolInputChars: 4_210,
      stopReason: "tool_use",
      turnIndexInSession: 7,
      ...overrides,
    },
    forecast: {
      outputP50: 900,
      outputP90: 4_000,
      predictorVersion: "leak-test",
      forecastSource: "historical",
      confidence: "medium",
    },
    actual: { outputTokens: 1_234, outputTokenQuality: "provider_exact" },
  };
}

describe("prompt text cannot reach a file that did not opt in", () => {
  it("a hash_only writer strips the text and the field name with it", async () => {
    const filePath = path.join(root, "hash-only.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "hash_only" });
    await writer.append(
      observation({ promptText: SECRET_PROMPT, promptStorageMode: "full_opt_in" }),
    );
    await writer.flush();

    const bytes = readFileSync(filePath, "utf8");
    expect(bytes).not.toContain("promptText");
    for (const fragment of FORBIDDEN) expect(bytes).not.toContain(fragment);
    // The row itself survives, and says which tier the file holds.
    const row = JSON.parse(bytes.trim()) as ForecastObservation;
    expect(row.id).toBe("leak-test-row");
    expect(row.request.promptStorageMode).toBe("hash_only");
    expect(row.request.toolNames).toEqual(["Read", "Edit"]);
  });

  it("the ingest handler with no text writer keeps the features and drops the text", async () => {
    const filePath = path.join(root, "ingest-features.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "hash_only" });
    const handler = createTelemetryIngestHandler({ writer, bearerToken: "leak-test-token" });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/observations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer leak-test-token",
      },
      body: JSON.stringify(
        observation({ promptText: SECRET_PROMPT, promptStorageMode: "full_opt_in" }),
      ),
    });
    expect(response.status).toBe(202);
    await writer.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const bytes = readFileSync(filePath, "utf8");
    expect(bytes).not.toContain("promptText");
    for (const fragment of FORBIDDEN) expect(bytes).not.toContain(fragment);
    expect(JSON.parse(bytes.trim()).id).toBe("leak-test-row");
  });

  it("a row that claims hash_only while carrying text is rejected, not cleaned up later", async () => {
    const filePath = path.join(root, "ingest-rejected.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "full_opt_in" });
    const handler = createTelemetryIngestHandler({ writer, bearerToken: "leak-test-token" });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    for (const mode of ["none", "hash_only", undefined] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/observations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer leak-test-token",
        },
        body: JSON.stringify(
          observation({
            promptText: SECRET_PROMPT,
            ...(mode === undefined ? {} : { promptStorageMode: mode }),
          }),
        ),
      });
      expect(response.status).toBe(400);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(() => readFileSync(filePath, "utf8")).toThrow();
  });

  it("a redacted writer removes paths, urls, mail, hex, base64 and keys", async () => {
    const filePath = path.join(root, "redacted.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "redacted" });
    // The client claims it already redacted. It did not. The file still must
    // not contain any of it.
    await writer.append(
      observation({ promptText: SECRET_PROMPT, promptStorageMode: "redacted" }),
    );
    await writer.flush();

    const bytes = readFileSync(filePath, "utf8");
    for (const fragment of FORBIDDEN) expect(bytes).not.toContain(fragment);
    const row = JSON.parse(bytes.trim()) as ForecastObservation;
    expect(row.request.promptStorageMode).toBe("redacted");
    expect(row.request.promptText).toContain("<path>");
    expect(row.request.promptText).toContain("<url>");
    expect(row.request.promptText).toContain("<email>");
    expect(row.request.promptText).toContain("<hex>");
    expect(row.request.promptText).toContain("<secret>");
    // Prose survives: this is a redactor, not a shredder.
    expect(row.request.promptText).toContain("Fix the importer in");
  });

  it("a full_opt_in writer passes the text through unchanged", async () => {
    const filePath = path.join(root, "full.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "full_opt_in" });
    await writer.append(
      observation({ promptText: SECRET_PROMPT, promptStorageMode: "full_opt_in" }),
    );
    await writer.flush();
    const row = JSON.parse(readFileSync(filePath, "utf8").trim()) as ForecastObservation;
    expect(row.request.promptText).toBe(SECRET_PROMPT);
  });

  it("records a delete request as a tombstone and defers the rewrite", async () => {
    const filePath = path.join(root, "deletable.jsonl");
    const deletionsFilePath = path.join(root, "deletions.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath, mode: "hash_only" });
    const handler = createTelemetryIngestHandler({ writer, bearerToken: "leak-test-token" });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${port}/v1/installations/install-abcdef0123`,
      { method: "DELETE", headers: { authorization: "Bearer leak-test-token" } },
    );
    expect(response.status).toBe(202);

    const unauthorized = await fetch(
      `http://127.0.0.1:${port}/v1/installations/install-abcdef0123`,
      { method: "DELETE" },
    );
    expect(unauthorized.status).toBe(401);

    // `..` never reaches the handler: the URL parser normalises it away and
    // the route stops matching, so traversal is not a case this has to defend.
    // A syntactically impossible id is.
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/installations/no%20such%2Fid`, {
      method: "DELETE",
      headers: { authorization: "Bearer leak-test-token" },
    });
    expect(rejected.status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const tombstones = readFileSync(deletionsFilePath, "utf8").trim().split("\n");
    expect(tombstones).toHaveLength(1);
    expect(JSON.parse(tombstones[0]!)).toMatchObject({
      type: "deletion_requested",
      installationId: "install-abcdef0123",
    });
  });

  it("text and features are split across two files, joinable on id", async () => {
    const featureFile = path.join(root, "split-features.jsonl");
    const textFile = path.join(root, "split-text.jsonl");
    const writer = new JsonlTelemetryWriter({ filePath: featureFile, mode: "hash_only" });
    const textWriter = new JsonlTelemetryWriter({ filePath: textFile, mode: "redacted" });
    const handler = createTelemetryIngestHandler({
      writer,
      textWriter,
      bearerToken: "leak-test-token",
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/observations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer leak-test-token",
      },
      body: JSON.stringify([
        observation({ promptText: SECRET_PROMPT, promptStorageMode: "redacted" }),
      ]),
    });
    expect(response.status).toBe(202);
    await writer.flush();
    await textWriter.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const featureBytes = readFileSync(featureFile, "utf8");
    const textBytes = readFileSync(textFile, "utf8");
    expect(featureBytes).not.toContain("promptText");
    for (const fragment of FORBIDDEN) {
      expect(featureBytes).not.toContain(fragment);
      expect(textBytes).not.toContain(fragment);
    }
    expect(JSON.parse(featureBytes.trim()).id).toBe(JSON.parse(textBytes.trim()).id);
  });
});

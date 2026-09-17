import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { importClaudeHistory } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Fixture prompt. Synthetic and redacted: it exists only so the tests can prove
 * it does NOT appear anywhere in the emitted observations.
 */
const FIXTURE_PROMPT = "fix the flaky retry helper in packages/core/src/retry.ts";

const SALT = "test-salt";

async function writeSession(entries: unknown[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "token-forecaster-ingest-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "session.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return directory;
}

function assistantRow(overrides: {
  uuid: string;
  parentUuid: string;
  requestId: string;
  timestamp: string;
  outputTokens: number;
  content?: unknown[];
}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: overrides.uuid,
    parentUuid: overrides.parentUuid,
    requestId: overrides.requestId,
    sessionId: "session-1",
    timestamp: overrides.timestamp,
    message: {
      model: "claude-opus-5",
      usage: { output_tokens: overrides.outputTokens },
      stop_reason: "tool_use",
      content: overrides.content ?? [{ type: "text", text: "..." }],
    },
  };
}

describe("importClaudeHistory", () => {
  it("emits one call observation per request and one turn observation summing them", async () => {
    const directory = await writeSession([
      {
        type: "user",
        uuid: "turn-root",
        parentUuid: null,
        isMeta: false,
        timestamp: "2026-08-05T10:00:00.000Z",
        message: { content: FIXTURE_PROMPT },
      },
      assistantRow({
        uuid: "call-1",
        parentUuid: "turn-root",
        requestId: "request-1",
        timestamp: "2026-08-05T10:00:01.000Z",
        outputTokens: 400,
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }],
      }),
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "call-1",
        timestamp: "2026-08-05T10:00:02.000Z",
        message: {
          content: [{ type: "tool_result", content: "ok", is_error: false }],
        },
      },
      assistantRow({
        uuid: "call-2",
        parentUuid: "result-1",
        requestId: "request-2",
        timestamp: "2026-08-05T10:00:03.000Z",
        outputTokens: 150,
      }),
    ]);

    const { observations, stats } = await importClaudeHistory({
      projectsDir: directory,
      salt: SALT,
    });

    const calls = observations.filter((observation) => observation.scale === "call");
    const turns = observations.filter((observation) => observation.scale === "turn");

    expect(calls).toHaveLength(2);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.outputTokens).toBe(550);
    expect(turns[0]?.id).toBe("claude:session-1:turn-root:turn");
    expect(turns[0]?.turnIndex).toBe(0);
    expect(turns[0]?.callIndex).toBe(0);

    expect(calls.map((observation) => observation.callIndex)).toEqual([0, 1]);
    expect(calls.map((observation) => observation.turnIndex)).toEqual([0, 0]);
    expect(calls.map((observation) => observation.id)).toEqual([
      "claude:session-1:request-1",
      "claude:session-1:request-2",
    ]);

    for (const observation of observations) {
      expect(observation.provider).toBe("anthropic");
      expect(observation.usageSource).toBe("provider_exact");
      expect(observation.model).toBe("claude-opus-5");
      expect(observation.sessionId).toBe("session-1");
      expect(observation.sourceFile).toBe(directory);
      expect(observation.sourceOffset).toBe(0);
      expect(observation.inputTokens).toBeNull();
      expect(observation.contextWindow).toBeNull();
    }

    expect(stats.filesScanned).toBe(1);
    expect(stats.rowsRead).toBe(2);
    expect(stats.rowsUsed).toBe(2);
  });

  it("derives prompt features and retains no prompt text", async () => {
    const directory = await writeSession([
      {
        type: "user",
        uuid: "turn-root",
        parentUuid: null,
        isMeta: false,
        timestamp: "2026-08-05T10:00:00.000Z",
        message: {
          content: [
            { type: "text", text: FIXTURE_PROMPT },
            { type: "image", source: { type: "base64", data: "" } },
          ],
        },
      },
      assistantRow({
        uuid: "call-1",
        parentUuid: "turn-root",
        requestId: "request-1",
        timestamp: "2026-08-05T10:00:01.000Z",
        outputTokens: 400,
        content: [{ type: "thinking", thinking: "..." }],
      }),
    ]);

    const { observations } = await importClaudeHistory({
      projectsDir: directory,
      salt: SALT,
    });

    const call = observations.find((observation) => observation.scale === "call");
    expect(call).toBeDefined();
    expect(call?.promptFeatures).not.toBeNull();
    expect(call?.promptFeatures?.chars).toBe(FIXTURE_PROMPT.length);
    expect(call?.promptFeatures?.hasImperative).toBe(true);
    expect(call?.promptFeatures?.paths).toBe(1);
    expect(call?.promptFeatures?.images).toBe(1);
    expect(call?.promptFeatures?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(call?.reasoning).toBe("thinking");

    // The whole point of the contract: nothing reconstructable to text.
    const serialised = JSON.stringify(observations);
    expect(serialised).not.toContain(FIXTURE_PROMPT);
    // Short words ("in", "the") occur incidentally inside model ids and field
    // names, so the leak check uses the distinctive tokens.
    for (const word of FIXTURE_PROMPT.split(" ").filter((part) => part.length >= 5)) {
      expect(serialised).not.toContain(word);
    }

    // The salt must actually salt: a different install cannot join on hashes.
    const other = await importClaudeHistory({
      projectsDir: directory,
      salt: "a-different-salt",
    });
    const otherCall = other.observations.find(
      (observation) => observation.scale === "call",
    );
    expect(otherCall?.promptFeatures?.hash).not.toBe(call?.promptFeatures?.hash);
  });

  it("skips zero-output calls and counts them", async () => {
    const directory = await writeSession([
      {
        type: "user",
        uuid: "turn-root",
        parentUuid: null,
        isMeta: false,
        timestamp: "2026-08-05T10:00:00.000Z",
        message: { content: FIXTURE_PROMPT },
      },
      assistantRow({
        uuid: "call-1",
        parentUuid: "turn-root",
        requestId: "request-1",
        timestamp: "2026-08-05T10:00:01.000Z",
        outputTokens: 0,
      }),
      assistantRow({
        uuid: "call-2",
        parentUuid: "turn-root",
        requestId: "request-2",
        timestamp: "2026-08-05T10:00:02.000Z",
        outputTokens: 320,
      }),
    ]);

    const { observations, stats } = await importClaudeHistory({
      projectsDir: directory,
      salt: SALT,
    });

    expect(stats.rowsRead).toBe(2);
    expect(stats.rowsUsed).toBe(1);
    expect(stats.skipped.zero_output).toBe(1);
    expect(
      observations.filter((observation) => observation.scale === "call"),
    ).toHaveLength(1);
    expect(
      observations.find((observation) => observation.scale === "turn")?.outputTokens,
    ).toBe(320);
  });

  it("honours `since` by dropping older rows from the import entirely", async () => {
    const directory = await writeSession([
      {
        type: "user",
        uuid: "turn-root",
        parentUuid: null,
        isMeta: false,
        timestamp: "2026-08-05T10:00:00.000Z",
        message: { content: FIXTURE_PROMPT },
      },
      assistantRow({
        uuid: "call-1",
        parentUuid: "turn-root",
        requestId: "request-1",
        timestamp: "2026-08-05T10:00:01.000Z",
        outputTokens: 400,
      }),
      assistantRow({
        uuid: "call-2",
        parentUuid: "turn-root",
        requestId: "request-2",
        timestamp: "2026-08-06T10:00:00.000Z",
        outputTokens: 150,
      }),
    ]);

    const { observations, stats } = await importClaudeHistory({
      projectsDir: directory,
      salt: SALT,
      since: Date.parse("2026-08-06T00:00:00.000Z"),
    });

    expect(stats.rowsRead).toBe(1);
    expect(stats.rowsUsed).toBe(1);
    expect(
      observations.find((observation) => observation.scale === "call")?.id,
    ).toBe("claude:session-1:request-2");
  });
});

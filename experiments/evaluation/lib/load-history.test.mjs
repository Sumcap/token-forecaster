import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRequests } from "./load-history.mjs";
import { portableBoostFeatures } from "./quantile-boost.mjs";
import { portableQuantileBoostFeatures } from "../../../packages/predictor/src/boosted.ts";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadRequests prompt ancestry", () => {
  it("walks through an isMeta skill injection to the human turn root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-forecaster-loader-"));
    temporaryDirectories.push(directory);
    const entries = [
      {
        type: "user",
        uuid: "human-turn",
        parentUuid: null,
        isMeta: false,
        message: { content: "rewrite docs/STATE-OF-PLAY.md" },
      },
      {
        type: "user",
        uuid: "skill-injection",
        parentUuid: "human-turn",
        isMeta: true,
        message: {
          content: [{ type: "text", text: "Base directory for this skill..." }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-answer",
        parentUuid: "skill-injection",
        requestId: "request-1",
        sessionId: "session-1",
        timestamp: "2026-08-05T10:00:00.000Z",
        message: {
          model: "claude-opus-5",
          usage: { output_tokens: 400 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done" }],
        },
      },
    ];
    await writeFile(
      path.join(directory, "session.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const { rows } = await loadRequests(directory, { withPromptFeatures: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: "request-1",
      afterUserMessage: true,
      loopDepth: 0,
      loopDepthExact: true,
      turnPrompt: {
        chars: "rewrite docs/STATE-OF-PLAY.md".length,
        mentionsPath: true,
        artifactIntent: true,
      },
      turnRootId: "human-turn",
    });
    expect(rows[0].workloadId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("keeps the deployment and training feature schemas byte-for-byte aligned", () => {
    const prompt = {
      chars: 420,
      requirements: 4,
      hasLimit: false,
      hasExpansive: true,
      artifactIntent: true,
      requestedFormat: "document",
      deliverableType: "artifact",
    };
    const training = portableBoostFeatures({
      model: "claude-opus-5",
      thinking: "yes",
      promptPath: "yes",
      promptImage: "yes",
      turnPrompt: prompt,
      sessionPosition: 12,
      loopDepth: 4,
      priorCalls: 4,
      priorMaxOutput: 5_000,
      priorArtifactCount: 1,
      priorWrite: "yes",
      priorArtifact: "yes",
    });
    const runtime = portableQuantileBoostFeatures({
      model: "claude-opus-5",
      thinkingEnabled: true,
      promptMentionsPath: true,
      promptHasImage: true,
      boostedContext: {
        prompt: {
          characterCount: prompt.chars,
          requirements: prompt.requirements,
          hasLimit: prompt.hasLimit,
          hasExpansive: prompt.hasExpansive,
          artifactIntent: prompt.artifactIntent,
          requestedFormat: prompt.requestedFormat,
          deliverableType: prompt.deliverableType,
        },
        agentLoop: {
          sessionPosition: 12,
          loopDepth: 4,
          priorCallCount: 4,
          priorMaxOutputTokens: 5_000,
          priorArtifactCount: 1,
          priorWriteObserved: true,
          priorArtifactObserved: true,
        },
      },
    });
    expect(runtime).toEqual([...training]);
  });

  it("captures paths resolved before the next call without retaining path text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-resolved-context-"));
    temporaryDirectories.push(directory);
    const entries = [
      {
        type: "user",
        uuid: "turn",
        parentUuid: null,
        message: { content: "fix the failing test" },
      },
      {
        type: "assistant",
        uuid: "search-call",
        parentUuid: "turn",
        requestId: "request-search",
        sessionId: "session",
        timestamp: "2026-08-06T10:00:00.000Z",
        message: {
          model: "claude-opus-5",
          usage: { output_tokens: 200 },
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "Glob",
              input: { path: "/repo", pattern: "**/*.test.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "search-result",
        parentUuid: "search-call",
        message: {
          content: [
            { type: "tool_result", content: "/repo/src/auth.test.ts" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "next-call",
        parentUuid: "search-result",
        requestId: "request-next",
        sessionId: "session",
        timestamp: "2026-08-06T10:00:01.000Z",
        message: {
          model: "claude-opus-5",
          usage: { output_tokens: 500 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Found it" }],
        },
      },
    ];
    await writeFile(
      path.join(directory, "session.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const { rows } = await loadRequests(directory, {
      withPromptFeatures: true,
      withResolvedFileContext: true,
    });
    const search = rows.find((row) => row.requestId === "request-search");
    const next = rows.find((row) => row.requestId === "request-next");
    expect(search.turnPrompt.mentionsPath).toBe(false);
    expect(search.searchPathHashes).toHaveLength(1);
    expect(next).toMatchObject({
      parentRequestId: "request-search",
      loopDepth: 1,
    });
    expect(next.resultPathHashes).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("/repo");
    expect(JSON.stringify(rows)).not.toContain("auth.test.ts");
  });
});

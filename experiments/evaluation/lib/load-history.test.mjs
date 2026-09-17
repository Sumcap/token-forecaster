import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivePromptFeatures, loadRequests, redactHome } from "./load-history.mjs";
import { portableBoostFeatures } from "./quantile-boost.mjs";
import {
  portableQuantileBoostFeatures,
  promptForecastFeatures,
} from "../../../packages/predictor/src/boosted.ts";

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
      followupCompression: false,
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
      sessionContext: { turnsSoFar: 3, previousTurnOutputTokens: 7_500 },
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
          followupCompression: prompt.followupCompression,
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
        sessionContext: { turnsSoFar: 3, previousTurnOutputTokens: 7_500 },
      },
    });
    expect(runtime).toEqual([...training]);
  });

  it("derives the compression follow-up bit identically on both sides of the gate", () => {
    const prompts = [
      "let's summarize it",
      "can you summarize it even further?",
      "summarize this briefly in one sentence",
      "make it shorter",
      "tl;dr",
      "summarize the architecture of this repo",
      "summarize this file",
      "read the docs and summarize it",
      "write a new file src/foo.ts implementing the parser and tests",
    ];
    for (const prompt of prompts) {
      expect(
        derivePromptFeatures(prompt).followupCompression,
        `training vs runtime disagree on: ${prompt}`,
      ).toBe(promptForecastFeatures(prompt).followupCompression);
    }
    expect(derivePromptFeatures("let's summarize it").followupCompression).toBe(true);
    expect(derivePromptFeatures("summarize this file").followupCompression).toBe(false);
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

describe("redactHome", () => {
  // These strings are what gets COMMITTED to a public repo, so the boundary
  // cases matter more than the happy path.
  it("rewrites the home directory and paths beneath it", () => {
    const home = homedir();
    expect(redactHome(home)).toBe("~");
    expect(redactHome(path.join(home, ".claude", "projects"))).toBe(
      `~${path.sep}.claude${path.sep}projects`,
    );
  });

  it("does not treat a sibling directory as a subpath of home", () => {
    // /Users/alice-backup belongs to nobody in particular, but it is NOT
    // inside /Users/alice -- a raw prefix match would publish `~-backup`.
    const sibling = `${homedir()}-backup${path.sep}projects`;
    expect(redactHome(sibling)).not.toContain("~-backup");
    expect(redactHome(sibling)).toBe("<redacted-path>");
  });

  it("drops an absolute path rooted outside home rather than publishing it", () => {
    // An external corpus path can name a client; it cannot be expressed
    // relative to `~`, so there is nothing safe to publish.
    expect(redactHome(path.resolve(path.sep, "mnt", "corpora", "acme", "projects"))).toBe(
      "<redacted-path>",
    );
  });

  it("passes through relative paths and non-strings untouched", () => {
    expect(redactHome("experiments/artifacts")).toBe("experiments/artifacts");
    expect(redactHome(null)).toBe(null);
    expect(redactHome(undefined)).toBe(undefined);
  });
});

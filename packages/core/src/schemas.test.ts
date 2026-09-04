import { describe, expect, it } from "vitest";
import { canonicalModelId } from "./observations.js";
import {
  agentLoopForecastContextSchema,
  EXTENSION_TELEMETRY_SCHEMA_VERSION,
  extensionTelemetryClientEventSchema,
  forecastObservationSchema,
  MAX_PROMPT_TEXT_CHARS,
} from "./schemas.js";

describe("forecast-time telemetry schemas", () => {
  it("does not silently turn missing parent history into false or zero", () => {
    expect(() =>
      agentLoopForecastContextSchema.parse({
        sessionPosition: 5,
        loopDepth: 2,
        priorCallCount: 2,
      }),
    ).toThrow(/priorMaxOutputTokens/);

    expect(
      agentLoopForecastContextSchema.parse({
        sessionPosition: 0,
        loopDepth: 0,
        priorCallCount: 0,
      }),
    ).toEqual({ sessionPosition: 0, loopDepth: 0, priorCallCount: 0 });
  });

  it("keeps caller intent in request and observed action in actual", () => {
    const parsed = forecastObservationSchema.parse({
      id: "telemetry-contract",
      timestamp: "2026-08-06T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-opus-5",
      request: {
        messageCount: 1,
        toolCount: 4,
        maxTokens: 16_000,
        expectedOutputKind: "artifact",
        expectedOutputKindSource: "orchestrator_declared",
        expectedOutputKindConfidence: 0.9,
        resolvedFileContext: {
          knownPathCount: 2,
          immediateResultPathCount: 1,
          readPathCount: 1,
          searchedPathCount: 1,
          mutationPathCount: 0,
          vaguePromptResolvedFile: true,
        },
      },
      forecast: {
        outputP50: 500,
        outputP90: 2_000,
        outputP99: 8_000,
        predictorVersion: "test",
        forecastSource: "trained",
        confidence: "medium",
      },
      actual: {
        inputTokens: 100,
        outputTokens: 4_000,
        isCensored: false,
        observedOutputKind: "artifact",
        firstAction: "Write",
      },
    });

    expect(parsed.request.expectedOutputKind).toBe("artifact");
    expect(parsed.request.expectedOutputKindSource).toBe("orchestrator_declared");
    expect(parsed.actual?.firstAction).toBe("Write");
  });

  it("marks browser outcomes as estimates and has no raw-text escape hatch", () => {
    const parsed = extensionTelemetryClientEventSchema.parse({
      schemaVersion: EXTENSION_TELEMETRY_SCHEMA_VERSION,
      id: "extension-research-event-0001",
      timestamp: "2026-08-27T12:00:00.000Z",
      extensionVersion: "0.1.0",
      consentVersion: 1,
      kind: "research",
      rawPrompt: "strip me",
      observation: {
        id: "observation-0001",
        timestamp: "2026-08-27T12:00:00.000Z",
        provider: "anthropic",
        model: "claude-opus-5",
        request: {
          currentUserTokens: 10,
          rawPrompt: "strip me too",
          promptForecastFeatures: {
            characterCount: 40,
            requirements: 1,
            hasLimit: false,
            hasExpansive: false,
            artifactIntent: false,
            requestedFormat: "unspecified",
            deliverableType: "other",
          },
          textHeadQuantiles: [6.32, 8.11, 9.74],
        },
        forecast: {
          outputP50: 100,
          outputP90: 500,
          predictorVersion: "test",
          forecastSource: "trained",
          confidence: "low",
        },
        actual: {
          inputTokens: 10,
          outputTokens: 120,
          outputTokenQuality: "dom_estimate",
        },
      },
    });
    expect(parsed.observation.actual?.outputTokenQuality).toBe("dom_estimate");
    expect(parsed.observation.request.textHeadQuantiles).toEqual([6.32, 8.11, 9.74]);
    expect(JSON.stringify(parsed)).not.toContain("strip me");
  });
});

/**
 * The prompt-storage enum existed for a year without anything checking it. A
 * row could say `hash_only` and carry a prompt, and every reader accepted it.
 * These are the four cases that must now fail or pass at the schema boundary,
 * because the writer and the ingest both delegate the decision here.
 */
describe("prompt text and its storage mode", () => {
  const row = (request: Record<string, unknown>) => ({
    id: "prompt-storage-row",
    timestamp: "2026-09-04T00:00:00.000Z",
    provider: "anthropic" as const,
    model: "claude-opus-5",
    request,
    forecast: {
      outputP50: 800,
      outputP90: 3_000,
      predictorVersion: "test",
      forecastSource: "historical" as const,
      confidence: "medium" as const,
    },
    actual: { outputTokens: 1_200, outputTokenQuality: "provider_exact" as const },
  });

  it("round-trips a feature-only row under every mode", () => {
    for (const promptStorageMode of ["none", "hash_only", "redacted", "full_opt_in"] as const) {
      const parsed = forecastObservationSchema.parse(row({ promptStorageMode }));
      expect(parsed.request.promptStorageMode).toBe(promptStorageMode);
      expect(parsed.request.promptText).toBeUndefined();
    }
  });

  it("round-trips text under the two modes that allow it", () => {
    for (const promptStorageMode of ["redacted", "full_opt_in"] as const) {
      const parsed = forecastObservationSchema.parse(
        row({ promptStorageMode, promptText: "add a test for the ingest handler" }),
      );
      expect(parsed.request.promptText).toBe("add a test for the ingest handler");
      expect(parsed.request.promptStorageMode).toBe(promptStorageMode);
    }
  });

  it("rejects text under none and hash_only", () => {
    for (const promptStorageMode of ["none", "hash_only"] as const) {
      expect(() =>
        forecastObservationSchema.parse(row({ promptStorageMode, promptText: "leak me" })),
      ).toThrow(/not allowed under promptStorageMode/);
    }
  });

  it("rejects text with no mode at all, rather than assuming one", () => {
    expect(() => forecastObservationSchema.parse(row({ promptText: "leak me" }))).toThrow(
      /promptStorageMode is required/,
    );
  });

  it("rejects a prompt longer than the cap instead of truncating it", () => {
    expect(() =>
      forecastObservationSchema.parse(
        row({
          promptStorageMode: "full_opt_in",
          promptText: "x".repeat(MAX_PROMPT_TEXT_CHARS + 1),
        }),
      ),
    ).toThrow();
    expect(() =>
      forecastObservationSchema.parse(
        row({
          promptStorageMode: "full_opt_in",
          promptText: "x".repeat(MAX_PROMPT_TEXT_CHARS),
        }),
      ),
    ).not.toThrow();
  });
});

describe("loop structure", () => {
  const loopRow = (request: Record<string, unknown>) => ({
    id: "loop-row",
    timestamp: "2026-09-04T00:00:00.000Z",
    provider: "openai" as const,
    model: "gpt-5.4",
    request,
    forecast: {
      outputP50: 800,
      outputP90: 3_000,
      predictorVersion: "test",
      forecastSource: "historical" as const,
      confidence: "medium" as const,
    },
    actual: { outputTokens: 1_200 },
  });

  it("carries the per-call columns the loop probes asked for", () => {
    const parsed = forecastObservationSchema.parse(
      loopRow({
        turnRootId: "0199c0ff-ee00-4000-8000-000000000001",
        callIndex: 4,
        turnIndexInSession: 2,
        toolNames: ["Read", "Bash"],
        largestToolInputChars: 812,
        stopReason: "tool_use",
      }),
    );
    expect(parsed.request.toolNames).toEqual(["Read", "Bash"]);
    expect(parsed.request.stopReason).toBe("tool_use");
    // An empty list is a real observation, not a missing one.
    expect(
      forecastObservationSchema.parse(loopRow({ toolNames: [] })).request.toolNames,
    ).toEqual([]);
  });

  it("will not let callIndex and priorCallCount disagree", () => {
    expect(() =>
      forecastObservationSchema.parse(
        loopRow({
          callIndex: 4,
          agentLoopForecastContext: {
            sessionPosition: 40,
            loopDepth: 4,
            priorCallCount: 3,
            priorMaxOutputTokens: 900,
            priorArtifactCount: 0,
            priorWriteObserved: false,
            priorArtifactObserved: false,
          },
        }),
      ),
    ).toThrow(/must agree/);
  });

  it("still parses a row written before any of this existed", () => {
    const legacy = forecastObservationSchema.parse({
      id: "legacy-vm-row",
      timestamp: "2026-08-10T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-opus-5",
      request: { messageCount: 3, toolCount: 1 },
      forecast: {
        outputP50: 500,
        outputP90: 2_000,
        predictorVersion: "boosted-1/0.1.0",
        forecastSource: "trained",
        confidence: "high",
      },
      actual: { inputTokens: 900, outputTokens: 1_100 },
    });
    expect(legacy.request.promptStorageMode).toBeUndefined();
    expect(legacy.actual?.inputTokens).toBe(900);
  });
});

describe("canonicalModelId", () => {
  it("drops a context-window variant so one model keys one distribution", () => {
    // Claude Code's status line names the million-token variant this way; the
    // transcripts it writes never do.
    expect(canonicalModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(canonicalModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  it("leaves a dated snapshot alone — that is a different set of weights", () => {
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("has nothing to say about a missing or empty model", () => {
    expect(canonicalModelId(null)).toBeNull();
    expect(canonicalModelId("[1m]")).toBeNull();
  });
});

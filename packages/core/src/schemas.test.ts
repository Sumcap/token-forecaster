import { describe, expect, it } from "vitest";
import { canonicalModelId } from "./observations.js";
import {
  agentLoopForecastContextSchema,
  EXTENSION_TELEMETRY_SCHEMA_VERSION,
  extensionTelemetryClientEventSchema,
  forecastObservationSchema,
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
    expect(JSON.stringify(parsed)).not.toContain("strip me");
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

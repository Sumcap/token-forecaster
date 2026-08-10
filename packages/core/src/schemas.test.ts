import { describe, expect, it } from "vitest";
import {
  agentLoopForecastContextSchema,
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
});

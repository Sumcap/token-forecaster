import { describe, expect, it } from "vitest";
import {
  applyQuantileBoost,
  hasCompleteAgentLoopContext,
  portableQuantileBoostFeatures,
  promptForecastFeatures,
} from "./boosted.js";
import { historicalBaselineForecast } from "./historical.js";
import type { HistoricalForecastProfile } from "./historical.js";
import type { QuantileBoostProfile } from "./boosted.js";

const leaf = (value: number) => ({ value });
const correction: QuantileBoostProfile = {
  featureSchema: "portable-precall-v1",
  learningRate: 1,
  trainingSamples: 1_000,
  ensembles: [
    [{ feature: 0, threshold: 0.5, left: leaf(-100), right: leaf(100) }],
    [leaf(200)],
    [leaf(300)],
  ],
};

describe("portable quantile correction", () => {
  it("applies shallow quantile-specific residual trees and preserves ordering", () => {
    expect(applyQuantileBoost(correction, [500, 900, 1_000], new Array(37).fill(0))).toEqual([
      400,
      1_100,
      1_300,
    ]);
  });

  it("keeps unknown path distinct from a measured false value", () => {
    const context = {
      agentLoop: { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 },
    };
    const unknown = portableQuantileBoostFeatures({
      model: "model-a",
      thinkingEnabled: false,
      boostedContext: context,
    });
    const measuredFalse = portableQuantileBoostFeatures({
      model: "model-a",
      thinkingEnabled: false,
      promptMentionsPath: false,
      boostedContext: context,
    });
    expect(unknown[1]).toBe(-1);
    expect(measuredFalse[1]).toBe(0);
  });

  it("requires actual parent history whenever priorCallCount is nonzero", () => {
    expect(
      hasCompleteAgentLoopContext({ sessionPosition: 2, loopDepth: 1, priorCallCount: 1 }),
    ).toBe(false);
    expect(
      hasCompleteAgentLoopContext({
        sessionPosition: 2,
        loopDepth: 1,
        priorCallCount: 1,
        priorMaxOutputTokens: 400,
        priorArtifactCount: 0,
        priorWriteObserved: false,
        priorArtifactObserved: false,
      }),
    ).toBe(true);
  });

  it("extracts only privacy-safe prompt aggregates", () => {
    expect(promptForecastFeatures("Write a concise report to docs/result.md")).toMatchObject({
      artifactIntent: true,
      hasLimit: true,
      requestedFormat: "document",
      deliverableType: "artifact",
    });
  });

  it("uses the correction only with complete pre-call context", () => {
    const profile: HistoricalForecastProfile = {
      id: "boost-test",
      generatedAt: "2026-08-06T00:00:00.000Z",
      scope: "test",
      eligibleObservations: 1_000,
      groups: {
        "model=model-a|thinking=yes": {
          sampleSize: 1_000,
          p50: 500,
          p90: 900,
          p99: 1_000,
        },
      },
      boostedCorrection: correction,
    };
    const incomplete = historicalBaselineForecast(
      { model: "model-a", maxTokens: 4_000, thinkingEnabled: true },
      profile,
    );
    expect(incomplete.forecast).toMatchObject({ p50: 500, p90: 900, p99: 1_000 });
    expect(incomplete.forecast.confidence).toBe("low");
    expect(incomplete.calibration).toMatchObject({
      boostedCorrectionApplied: false,
      boostedCorrectionReason: "incomplete_context",
    });

    const complete = historicalBaselineForecast(
      {
        model: "model-a",
        maxTokens: 4_000,
        thinkingEnabled: true,
        boostedContext: {
          agentLoop: { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 },
        },
      },
      profile,
    );
    expect(complete.forecast).toMatchObject({ p50: 600, p90: 1_100, p99: 1_300 });
    expect(complete.forecast.confidence).toBe("medium");
    expect(complete.forecast.source).toBe("trained");
    expect(complete.calibration).toMatchObject({
      boostedCorrectionApplied: true,
      boostedCorrectionReason: "applied",
    });
  });
});

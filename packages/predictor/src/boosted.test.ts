import { describe, expect, it } from "vitest";
import {
  BOOST_FEATURE_COUNT_BY_SCHEMA,
  QUANTILE_BOOST_FEATURE_COUNT,
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

  it("separates a compression follow-up from a corpus-style summarize task", () => {
    const fires = [
      "let's summarize it",
      "can you summarize it even further?",
      "summarize this briefly in one sentence",
      "shorten it",
      "make it shorter",
      "condense that please",
      "recap the above",
      "tl;dr",
    ];
    for (const prompt of fires) {
      expect(
        promptForecastFeatures(prompt).followupCompression,
        `expected a compression follow-up: ${prompt}`,
      ).toBe(true);
    }
    // "summarize X" in the corpus sense means read X, then write at length.
    const stayFalse = [
      "summarize the architecture of this repo",
      "summarize this file",
      "read the docs and summarize it",
      "summarize src/foo.ts",
      "write a new file src/foo.ts implementing the parser and tests",
      "explain it",
      "what is this?",
      // Long enough that it is a brief, not an aside, even though it is anaphoric.
      `summarize it ${"and keep going with much more detail about everything ".repeat(2)}`,
    ];
    for (const prompt of stayFalse) {
      expect(
        promptForecastFeatures(prompt).followupCompression,
        `expected no compression follow-up: ${prompt}`,
      ).toBe(false);
    }
  });

  it("puts the compression bit at feature 37 without disturbing v1/v2 indices", () => {
    const agentLoop = { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 };
    const base = {
      model: "model-a",
      thinkingEnabled: false,
      promptMentionsPath: false,
      promptHasImage: false,
    };
    const compression = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt: promptForecastFeatures("let's summarize it") },
    });
    const other = portableQuantileBoostFeatures({
      ...base,
      boostedContext: {
        agentLoop,
        prompt: promptForecastFeatures("summarize the architecture of this repo"),
      },
    });
    expect(compression).toHaveLength(QUANTILE_BOOST_FEATURE_COUNT);
    expect(compression[37]).toBe(1);
    expect(other[37]).toBe(0);
    // Absent prompt features are "not a compression follow-up", never unknown.
    expect(portableQuantileBoostFeatures({ ...base, boostedContext: { agentLoop } })[37]).toBe(0);
  });

  it("evaluates v1..v4 profiles unchanged against the wider v5 vector", () => {
    const features = new Array(QUANTILE_BOOST_FEATURE_COUNT).fill(0);
    const v4 = { ...correction, featureSchema: "portable-precall-v4" as const };
    const v3 = { ...correction, featureSchema: "portable-precall-v3" as const };
    const v2 = { ...correction, featureSchema: "portable-precall-v2" as const };
    expect(applyQuantileBoost(correction, [500, 900, 1_000], features)).toEqual([400, 1_100, 1_300]);
    expect(applyQuantileBoost(v2, [500, 900, 1_000], features)).toEqual([400, 1_100, 1_300]);
    expect(applyQuantileBoost(v3, [500, 900, 1_000], features)).toEqual([400, 1_100, 1_300]);
    expect(applyQuantileBoost(v4, [500, 900, 1_000], features)).toEqual([400, 1_100, 1_300]);
    // A populated text head must not move an older profile by one token.
    const withHead = [...features];
    withHead[38] = 6.9;
    withHead[39] = 8.1;
    withHead[40] = 9.4;
    withHead[41] = 1;
    for (const older of [correction, v2, v3]) {
      expect(applyQuantileBoost(older, [500, 900, 1_000], withHead)).toEqual([400, 1_100, 1_300]);
    }
    // Nor may a populated session family move a v1..v4 profile.
    const withSession = [...withHead];
    withSession[42] = 0.3;
    withSession[43] = 0.8;
    withSession[44] = 1;
    const v5 = { ...correction, featureSchema: "portable-precall-v5" as const };
    for (const older of [correction, v2, v3, v4, v5]) {
      expect(applyQuantileBoost(older, [500, 900, 1_000], withSession)).toEqual([
        400, 1_100, 1_300,
      ]);
    }
    // A v3 profile may split on feature 37; older ones never index that far.
    const usesCompression = {
      ...v3,
      ensembles: [
        [{ feature: 37, threshold: 0.5, left: { value: 0 }, right: { value: -300 } }],
        [{ value: 0 }],
        [{ value: 0 }],
      ] as QuantileBoostProfile["ensembles"],
    };
    const compressed = [...features];
    compressed[37] = 1;
    expect(applyQuantileBoost(usesCompression, [500, 900, 1_000], features)[0]).toBe(500);
    expect(applyQuantileBoost(usesCompression, [500, 900, 1_000], compressed)[0]).toBe(200);
  });

  it("accepts a narrower vector only for the schema that was trained on it", () => {
    expect(BOOST_FEATURE_COUNT_BY_SCHEMA["portable-precall-v5"]).toBe(
      QUANTILE_BOOST_FEATURE_COUNT,
    );
    expect(BOOST_FEATURE_COUNT_BY_SCHEMA["portable-precall-v4"]).toBe(42);
    const v3 = { ...correction, featureSchema: "portable-precall-v3" as const };
    const v4 = { ...correction, featureSchema: "portable-precall-v4" as const };
    const v5 = { ...correction, featureSchema: "portable-precall-v5" as const };
    // A pre-v3 caller's 37-wide vector still drives a v1/v2 profile.
    expect(applyQuantileBoost(correction, [500, 900, 1_000], new Array(37).fill(0))).toEqual([
      400, 1_100, 1_300,
    ]);
    expect(() => applyQuantileBoost(v3, [500, 900, 1_000], new Array(37).fill(0))).toThrow(
      /at least 38 .* boost features/,
    );
    expect(() => applyQuantileBoost(v4, [500, 900, 1_000], new Array(38).fill(0))).toThrow(
      /at least 42 .* boost features/,
    );
    expect(() =>
      applyQuantileBoost(v5, [500, 900, 1_000], new Array(42).fill(0)),
    ).toThrow(/at least 45 .* boost features/);
    expect(() =>
      applyQuantileBoost(correction, [500, 900, 1_000], new Array(46).fill(0)),
    ).toThrow(/boost features/);
    expect(() =>
      applyQuantileBoost(
        { ...correction, featureSchema: "portable-precall-v6" as never },
        [500, 900, 1_000],
        new Array(QUANTILE_BOOST_FEATURE_COUNT).fill(0),
      ),
    ).toThrow(/Unsupported quantile-boost feature schema/);
  });

  it("puts the session so far at 42-44 without disturbing v1..v4 indices", () => {
    const agentLoop = { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 };
    const base = {
      model: "model-a",
      thinkingEnabled: false,
      promptMentionsPath: false,
      promptHasImage: false,
    };
    const prompt = promptForecastFeatures("write a report into docs/result.md");
    const without = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt, textHead: [6.5, 8.25, 9.75] },
    });
    const withSession = portableQuantileBoostFeatures({
      ...base,
      boostedContext: {
        agentLoop,
        prompt,
        textHead: [6.5, 8.25, 9.75],
        sessionContext: { turnsSoFar: 5, previousTurnOutputTokens: 4_000 },
      },
    });
    expect(without).toHaveLength(QUANTILE_BOOST_FEATURE_COUNT);
    // No session context is three zeros, not a session at its first turn.
    expect(without.slice(42)).toEqual([0, 0, 0]);
    expect(withSession.slice(42)).toEqual([
      Math.log1p(5) / 6,
      Math.log1p(4_000) / 10,
      1,
    ]);
    // Everything a v4 tree can see is byte-identical either way.
    expect(withSession.slice(0, 42)).toEqual(without.slice(0, 42));
    // A known first turn with no completed predecessor still sets the bit.
    const firstTurn = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt, sessionContext: { turnsSoFar: 0 } },
    });
    expect(firstTurn.slice(42)).toEqual([0, 0, 1]);
  });

  it("refuses a malformed session context rather than silently zeroing it", () => {
    const agentLoop = { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 };
    expect(() =>
      portableQuantileBoostFeatures({
        model: "model-a",
        thinkingEnabled: false,
        boostedContext: { agentLoop, sessionContext: { turnsSoFar: -1 } },
      }),
    ).toThrow(/sessionContext.turnsSoFar/);
    expect(() =>
      portableQuantileBoostFeatures({
        model: "model-a",
        thinkingEnabled: false,
        boostedContext: {
          agentLoop,
          sessionContext: { turnsSoFar: 2, previousTurnOutputTokens: 1.5 },
        },
      }),
    ).toThrow(/sessionContext.previousTurnOutputTokens/);
  });

  it("puts the base text head at 38-41 without disturbing v1..v3 indices", () => {
    const agentLoop = { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 };
    const base = {
      model: "model-a",
      thinkingEnabled: false,
      promptMentionsPath: false,
      promptHasImage: false,
    };
    const prompt = promptForecastFeatures("write a report into docs/result.md");
    const without = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt },
    });
    const withHead = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt, textHead: [6.5, 8.25, 9.75] },
    });
    expect(without).toHaveLength(QUANTILE_BOOST_FEATURE_COUNT);
    // No head is four zeros, not a short prompt.
    expect(without.slice(38, 42)).toEqual([0, 0, 0, 0]);
    expect(withHead.slice(38, 42)).toEqual([6.5, 8.25, 9.75, 1]);
    // Everything a v3 tree can see is byte-identical either way.
    expect(withHead.slice(0, 38)).toEqual(without.slice(0, 38));
    // A head whose quantiles are all zero is still distinguishable from none.
    const zeroHead = portableQuantileBoostFeatures({
      ...base,
      boostedContext: { agentLoop, prompt, textHead: [0, 0, 0] },
    });
    expect(zeroHead.slice(38, 42)).toEqual([0, 0, 0, 1]);
  });

  it("refuses a malformed text head rather than silently zeroing it", () => {
    const boostedContext = {
      agentLoop: { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 },
      textHead: [1, Number.NaN, 3] as unknown as readonly [number, number, number],
    };
    expect(() =>
      portableQuantileBoostFeatures({
        model: "model-a",
        thinkingEnabled: false,
        boostedContext,
      }),
    ).toThrow(/three finite numbers/);
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

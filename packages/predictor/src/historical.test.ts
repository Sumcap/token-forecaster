import { describe, expect, it } from "vitest";
import type { ForecastObservation } from "@token-forecaster/core";
import { outputForecastSchema } from "@token-forecaster/core";
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  HISTORICAL_GROUP_TIERS,
  OVERALL_HISTORICAL_GROUP,
  buildHistoricalProfile,
  historicalBaselineForecast,
  historicalGroupKey,
  historicalSessionTotalForecast,
  historicalTurnTotalForecast,
  previousOutputBucket,
  promptForecastFeatures,
  promptMentionsPath,
} from "./index.js";
import { baseTextHead } from "./text-head/index.js";

function observation(
  index: number,
  overrides: {
    model?: string;
    outputTokens?: number;
    isCensored?: boolean;
    toolCount?: number;
    thinking?: boolean;
    taskType?: string;
    inputTokens?: number;
    timestamp?: string;
    previousOutputTokens?: number;
    promptMentionsPath?: boolean;
  } = {},
): ForecastObservation {
  return {
    id: `observation-${index}`,
    timestamp: overrides.timestamp ?? "2026-08-01T00:00:00.000Z",
    provider: "anthropic",
    model: overrides.model ?? "model-a",
    request: {
      inputTokensVerified: overrides.inputTokens ?? 10_000,
      messageCount: 1,
      toolCount: overrides.toolCount ?? 0,
      maxTokens: 16_000,
      ...(overrides.thinking ? { thinkingConfiguration: { type: "adaptive" } } : {}),
      ...(overrides.taskType ? { taskType: overrides.taskType } : {}),
      ...(overrides.previousOutputTokens === undefined
        ? {}
        : { previousOutputTokens: overrides.previousOutputTokens }),
      ...(overrides.promptMentionsPath === undefined
        ? {}
        : { promptMentionsPath: overrides.promptMentionsPath }),
    },
    forecast: {
      outputP50: 1_000,
      outputP90: 4_000,
      outputP99: 12_000,
      predictorVersion: "test",
      forecastSource: "default",
      confidence: "low",
    },
    actual: {
      inputTokens: overrides.inputTokens ?? 10_000,
      outputTokens: overrides.outputTokens ?? index,
      isCensored: overrides.isCensored ?? false,
    },
  };
}

describe("buildHistoricalProfile", () => {
  it("excludes right-censored observations from ordinary quantiles", () => {
    const observations = [
      ...Array.from({ length: 100 }, (_, index) =>
        observation(index + 1, { outputTokens: index + 1 }),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        observation(index + 101, {
          outputTokens: 16_000,
          isCensored: true,
        }),
      ),
    ];

    const profile = buildHistoricalProfile(observations, {
      id: "test-profile",
      scope: "test",
      now: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(profile.eligibleObservations).toBe(100);
    expect(profile.groups[OVERALL_HISTORICAL_GROUP]).toEqual({
      sampleSize: 100,
      p50: 51,
      p90: 90,
      p99: 99,
    });
  });

  it("builds conditional groups from pre-generation request features", () => {
    const observations = [
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index, { outputTokens: 200, thinking: false }),
      ),
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index + 150, { outputTokens: 2_000, thinking: true }),
      ),
    ];
    const profile = buildHistoricalProfile(observations, {
      id: "conditional",
      scope: "test",
    });

    const result = historicalBaselineForecast(
      { model: "model-a", maxTokens: 8_000, thinkingEnabled: true },
      profile,
    );

    expect(result.forecast.p50).toBe(2_000);
    expect(result.forecast.source).toBe("historical");
    expect(result.calibration.groupKey).toBe("model=model-a|thinking=yes");
    expect(result.calibration.sampleSize).toBe(150);
    expect(result.calibration.usedFallback).toBe(false);

    // Omitting thinkingEnabled must not silently mean "disabled" — it skips
    // every thinking tier and lands on the broader model group instead.
    const unknownThinking = historicalBaselineForecast(
      { model: "model-a", maxTokens: 8_000 },
      profile,
    );
    expect(unknownThinking.calibration.groupKey).toBe("model=model-a");
    expect(unknownThinking.calibration.sampleSize).toBe(300);
  });

  it("conditions on nothing but model, thinking, effort and task", () => {
    // Guards the P2 removals: `tools` and `input` are gone from the ladder, so
    // no built group may mention them however the observations are shaped.
    const observations = Array.from({ length: 120 }, (_, index) =>
      observation(index, {
        outputTokens: 100,
        toolCount: index % 3,
        inputTokens: index * 5_000,
      }),
    );
    const profile = buildHistoricalProfile(observations, {
      id: "no-tools-no-input",
      scope: "test",
    });

    for (const key of Object.keys(profile.groups)) {
      expect(key, `group ${key}`).not.toMatch(/\btools=/);
      expect(key, `group ${key}`).not.toMatch(/\binput=/);
    }
    expect(Object.keys(profile.groups).sort()).toEqual([
      "model=model-a",
      "model=model-a|thinking=no",
      "overall",
      "thinking=no",
    ]);
  });

  it("groups by the previous call's output size, and skips it when absent", () => {
    const observations = [
      // Long previous reply -> long reply. Short previous reply -> short reply.
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index, {
          outputTokens: 4_000,
          thinking: true,
          previousOutputTokens: 5_000,
        }),
      ),
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index + 150, {
          outputTokens: 300,
          thinking: true,
          previousOutputTokens: 400,
        }),
      ),
      // Turn-opening calls: no predecessor at all.
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index + 300, { outputTokens: 9_000, thinking: true }),
      ),
    ];
    const profile = buildHistoricalProfile(observations, {
      id: "prev-output",
      scope: "test",
    });

    expect(
      profile.groups["model=model-a|thinking=yes|prevOutput=gte3000"],
    ).toMatchObject({ sampleSize: 150, p50: 4_000 });
    expect(
      profile.groups["model=model-a|thinking=yes|prevOutput=200-800"],
    ).toMatchObject({ sampleSize: 150, p50: 300 });

    // The 150 turn-opening calls must appear in NO prevOutput group. Filing
    // them under the smallest bucket would be the unsafe direction: they are
    // the longest calls here, and they would drag `lt200` up with them.
    const inPrevOutputGroups = Object.entries(profile.groups)
      .filter(([key]) => key.includes("prevOutput="))
      .reduce((total, [, quantiles]) => total + quantiles.sampleSize, 0);
    // Exactly one tier carries the dimension, so the 300 calls that have a
    // predecessor are counted once and the 150 that don't are counted never.
    expect(inPrevOutputGroups).toBe(300);
  });

  it("backs a path-aware model cell off through the measured pooled path rung", () => {
    const observations = [
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index, {
          model: "model-a",
          outputTokens: 4_000,
          thinking: true,
          promptMentionsPath: true,
        }),
      ),
      ...Array.from({ length: 150 }, (_, index) =>
        observation(index + 150, {
          model: "model-a",
          outputTokens: 300,
          thinking: true,
          promptMentionsPath: false,
        }),
      ),
    ];
    const profile = buildHistoricalProfile(observations, {
      id: "prompt-path",
      scope: "test",
    });

    const path = historicalBaselineForecast(
      {
        model: "model-a",
        maxTokens: 16_000,
        thinkingEnabled: true,
        promptMentionsPath: true,
      },
      profile,
    );
    expect(path.calibration.groupKey).toBe(
      "model=model-a|thinking=yes|promptPath=yes",
    );
    expect(path.forecast.p50).toBe(4_000);

    const unknownPrompt = historicalBaselineForecast(
      { model: "model-a", maxTokens: 16_000, thinkingEnabled: true },
      profile,
    );
    expect(unknownPrompt.calibration.groupKey).toBe(
      "model=model-a|thinking=yes",
    );

    // For a model with no supported cell at all, the pooled THINKING rung now
    // outranks the pooled path rung: measured 9 August 2026 on
    // leave-one-model-out calls, thinking-first beats path-first by ~55
    // pinball/call for exactly this caller. Still honestly a fallback.
    const pooled = historicalBaselineForecast(
      {
        model: "model-b",
        maxTokens: 16_000,
        thinkingEnabled: true,
        promptMentionsPath: true,
      },
      profile,
    );
    expect(pooled.calibration.groupKey).toBe("thinking=yes");
    expect(pooled.calibration.usedFallback).toBe(true);
    expect(pooled.forecast.confidence).toBe("low");

    // With thinking unknown, the pooled path rung is still reachable — the
    // path bit is the only thing this caller told us.
    const pooledPath = historicalBaselineForecast(
      { model: "model-b", maxTokens: 16_000, promptMentionsPath: true },
      profile,
    );
    expect(pooledPath.calibration.groupKey).toBe("promptPath=yes");
    expect(pooledPath.calibration.usedFallback).toBe(true);
  });

  it("applies a sliding time window", () => {
    const profile = buildHistoricalProfile(
      [
        observation(1, {
          outputTokens: 5_000,
          timestamp: "2026-06-01T00:00:00.000Z",
        }),
        observation(2, {
          outputTokens: 500,
          timestamp: "2026-08-01T00:00:00.000Z",
        }),
      ],
      {
        id: "windowed",
        scope: "test",
        windowDays: 30,
        now: new Date("2026-08-02T00:00:00.000Z"),
      },
    );

    expect(profile.groups.overall).toEqual({
      sampleSize: 1,
      p50: 500,
      p90: 500,
      p99: 500,
    });
  });
});

describe("previousOutputBucket", () => {
  it("splits on the boundaries the effect was measured at", () => {
    // These are load-bearing numbers, not formatting: the within-cell ratios in
    // docs/STATE-OF-PLAY.md §6.9 are quoted against exactly these edges.
    expect(previousOutputBucket(0)).toBe("lt200");
    expect(previousOutputBucket(199)).toBe("lt200");
    expect(previousOutputBucket(200)).toBe("200-800");
    expect(previousOutputBucket(799)).toBe("200-800");
    expect(previousOutputBucket(800)).toBe("800-3000");
    expect(previousOutputBucket(2_999)).toBe("800-3000");
    expect(previousOutputBucket(3_000)).toBe("gte3000");
    expect(previousOutputBucket(1_000_000)).toBe("gte3000");
  });

  it("rejects values that cannot be a token count", () => {
    expect(() => previousOutputBucket(-1)).toThrow(/non-negative/);
    expect(() => previousOutputBucket(Number.NaN)).toThrow(/non-negative/);
  });
});

describe("promptMentionsPath", () => {
  it("recognizes the same file and repository path forms used by the eval", () => {
    expect(promptMentionsPath("redo @docs/STATE-OF-PLAY.md")).toBe(true);
    expect(promptMentionsPath("inspect packages/predictor next")).toBe(true);
    expect(promptMentionsPath("explain the current forecast")).toBe(false);
  });
});

describe("historicalBaselineForecast", () => {
  it("uses the bundled overall fallback when a model group is too small", () => {
    const overall = BUNDLED_CLAUDE_CODE_PROFILE.groups.overall;
    expect(overall).toBeDefined();
    const result = historicalBaselineForecast(
      { model: "claude-sonnet-5", maxTokens: 16_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(result.forecast).toMatchObject({
      p50: overall?.p50,
      p90: overall?.p90,
      p99: overall?.p99,
      source: "historical",
      confidence: "low",
    });
    expect(result.forecast.probabilityOfOutputCap).toBeUndefined();
    expect(result.calibration).toMatchObject({
      groupKey: "overall",
      sampleSize: overall?.sampleSize,
      usedFallback: true,
    });
    expect(() => outputForecastSchema.parse(result.forecast)).not.toThrow();
  });

  it("uses a sufficiently populated model group", () => {
    const opus = BUNDLED_CLAUDE_CODE_PROFILE.groups["model=claude-opus-5"];
    expect(opus).toBeDefined();
    const result = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 16_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(result.forecast).toMatchObject({
      p50: opus?.p50,
      p90: opus?.p90,
      p99: opus?.p99,
      // The bundled trained correction requires explicit parent-loop context.
      // Without it the group remains usable, but confidence is deliberately low.
      confidence: "low",
    });
    expect(result.calibration.usedFallback).toBe(false);
    expect(result.calibration.sampleSize).toBe(opus?.sampleSize);
  });

  it("clamps learned quantiles to max_tokens", () => {
    const opus = BUNDLED_CLAUDE_CODE_PROFILE.groups["model=claude-opus-5"];
    expect(opus).toBeDefined();
    const result = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 500 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(result.forecast).toMatchObject({
      p50: Math.min(opus?.p50 ?? 0, 500),
      p90: 500,
      p99: 500,
    });
  });

  it("prefers a thinking-conditioned group over the model-only group", () => {
    const thinking =
      BUNDLED_CLAUDE_CODE_PROFILE.groups["model=claude-opus-5|thinking=yes"];
    const notThinking =
      BUNDLED_CLAUDE_CODE_PROFILE.groups["model=claude-opus-5|thinking=no"];
    expect(thinking).toBeDefined();
    expect(notThinking).toBeDefined();

    const withThinking = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 64_000, thinkingEnabled: true },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    const withoutThinking = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 64_000, thinkingEnabled: false },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(withThinking.calibration.groupKey).toBe(
      "model=claude-opus-5|thinking=yes",
    );
    expect(withoutThinking.calibration.groupKey).toBe(
      "model=claude-opus-5|thinking=no",
    );
    expect(withThinking.forecast.p50).toBe(thinking?.p50);
    expect(withoutThinking.forecast.p50).toBe(notThinking?.p50);
    // The whole point of the dimension: it must actually move the forecast.
    // 1.5x, not 2x: the ratio is a property of the regenerated corpus, and the
    // 12 Aug 2026 regeneration measured 1.9x at p99 (2.2x at p50).
    expect(withThinking.forecast.p99).toBeGreaterThan(
      withoutThinking.forecast.p99 * 1.5,
    );
  });

  it("treats an omitted thinkingEnabled as unknown, not as disabled", () => {
    const result = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 64_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    // Falling through to the model-only group is the conservative choice: the
    // no-thinking group would under-forecast a thinking request at the tail.
    expect(result.calibration.groupKey).toBe("model=claude-opus-5");
    expect(result.forecast.p99).toBeGreaterThan(
      BUNDLED_CLAUDE_CODE_PROFILE.groups["model=claude-opus-5|thinking=no"]
        ?.p99 ?? 0,
    );
  });

  it("treats an omitted previousOutputTokens as unknown, not as a short reply", () => {
    // The same discipline as thinkingEnabled, and it matters for the same
    // reason: a caller that cannot see its previous call must fall through to
    // the broader group rather than claim the previous reply was short.
    const profile = buildHistoricalProfile(
      [
        ...Array.from({ length: 150 }, (_, index) =>
          observation(index, {
            outputTokens: 100,
            thinking: true,
            previousOutputTokens: 50,
          }),
        ),
        ...Array.from({ length: 150 }, (_, index) =>
          observation(index + 150, {
            outputTokens: 9_000,
            thinking: true,
            previousOutputTokens: 9_000,
          }),
        ),
      ],
      { id: "unknown-prev", scope: "test" },
    );

    const unknown = historicalBaselineForecast(
      { model: "model-a", maxTokens: 64_000, thinkingEnabled: true },
      profile,
    );
    expect(unknown.calibration.groupKey).toBe("model=model-a|thinking=yes");

    // A previous call that genuinely produced zero tokens is a *measurement*,
    // and must select the smallest bucket rather than be confused with absence.
    const zero = historicalBaselineForecast(
      {
        model: "model-a",
        maxTokens: 64_000,
        thinkingEnabled: true,
        previousOutputTokens: 0,
      },
      profile,
    );
    expect(zero.calibration.groupKey).toBe(
      "model=model-a|thinking=yes|prevOutput=lt200",
    );
    expect(zero.forecast.p50).toBe(100);
    expect(zero.forecast.p50).toBeLessThan(unknown.forecast.p50);

    const long = historicalBaselineForecast(
      {
        model: "model-a",
        maxTokens: 64_000,
        thinkingEnabled: true,
        previousOutputTokens: 12_000,
      },
      profile,
    );
    expect(long.calibration.groupKey).toBe(
      "model=model-a|thinking=yes|prevOutput=gte3000",
    );
    expect(long.forecast.p50).toBe(9_000);
  });

  it("treats null exactly like an omitted value on every optional field", () => {
    // null is what a JSON or database round-trip produces for "not set". Before
    // this was fixed, `thinkingEnabled: null` selected thinking=no — a ~2.6x
    // under-forecast at the tail, the precise failure the tri-state exists to
    // prevent — and `previousOutputTokens: null` threw.
    const omitted = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 64_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    const nulled = historicalBaselineForecast(
      {
        model: "claude-opus-5",
        maxTokens: 64_000,
        thinkingEnabled: null as unknown as undefined,
        previousOutputTokens: null as unknown as undefined,
        promptMentionsPath: null as unknown as undefined,
      },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(nulled.calibration).toEqual(omitted.calibration);
    expect(nulled.forecast).toEqual(omitted.forecast);
    expect(nulled.calibration.groupKey).toBe("model=claude-opus-5");
  });

  it("falls back past a previous-output group that is too thin", () => {
    // The rung is a refinement, never a downgrade: if the specific bucket has
    // not accumulated enough samples, the forecast must land on the
    // model+thinking group rather than on a noisy handful of calls.
    const profile = buildHistoricalProfile(
      [
        ...Array.from({ length: 150 }, (_, index) =>
          observation(index, {
            outputTokens: 1_000,
            thinking: true,
            previousOutputTokens: 5_000,
          }),
        ),
        ...Array.from({ length: 10 }, (_, index) =>
          observation(index + 150, {
            outputTokens: 42,
            thinking: true,
            previousOutputTokens: 100,
          }),
        ),
      ],
      { id: "thin-prev", scope: "test" },
    );

    const thin = historicalBaselineForecast(
      {
        model: "model-a",
        maxTokens: 64_000,
        thinkingEnabled: true,
        previousOutputTokens: 100,
      },
      profile,
    );
    expect(thin.calibration.groupKey).toBe("model=model-a|thinking=yes");
    expect(thin.calibration.sampleSize).toBe(160);
  });

  it("resolves a model alias onto the group the profile actually has", () => {
    // The profile is keyed on whatever string the transcripts recorded. A
    // caller holding the other form of the same model id must still land on
    // the conditioned group rather than silently sliding to `overall`.
    const profile = {
      ...BUNDLED_CLAUDE_CODE_PROFILE,
      modelAliases: { "model-x-20990101": "claude-opus-5" },
    };

    const viaAlias = historicalBaselineForecast(
      { model: "model-x-20990101", maxTokens: 64_000, thinkingEnabled: true },
      profile,
    );
    const direct = historicalBaselineForecast(
      { model: "claude-opus-5", maxTokens: 64_000, thinkingEnabled: true },
      profile,
    );

    expect(viaAlias.calibration.groupKey).toBe("model=claude-opus-5|thinking=yes");
    expect(viaAlias.calibration).toEqual(direct.calibration);
    expect(viaAlias.forecast).toEqual(direct.forecast);

    // Without the alias the same id degrades to a cross-model fallback group —
    // the pooled thinking rung, since this caller declared its thinking flag.
    // Still flagged, which is precisely what the alias table prevents.
    const unaliased = historicalBaselineForecast(
      { model: "model-x-20990101", maxTokens: 64_000, thinkingEnabled: true },
      { ...BUNDLED_CLAUDE_CODE_PROFILE, modelAliases: {} },
    );
    expect(unaliased.calibration.groupKey).toBe("thinking=yes");
    expect(unaliased.calibration.usedFallback).toBe(true);
  });

  it("flags an unknown model as a fallback rather than failing silently", () => {
    // Contract for a model the profile was not fitted on (Sonnet 5 today).
    // Since 9 August 2026 the bundled profile ships pooled thinking groups, so
    // an unknown-model caller that declares its thinking flag gets the
    // thinking-conditioned blend (leave-one-model-out: −43/call vs `overall`)
    // — still honestly flagged as a fallback.
    const result = historicalBaselineForecast(
      { model: "claude-sonnet-5", maxTokens: 16_000, thinkingEnabled: true },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(result.calibration.groupKey).toBe("thinking=yes");
    expect(result.calibration.usedFallback).toBe(true);
    // A fallback forecast is never presented as better-than-low confidence.
    expect(result.forecast.confidence).toBe("low");

    // With the thinking flag omitted there is nothing to condition on, and the
    // forecast is the blended overall group.
    const unknownThinking = historicalBaselineForecast(
      { model: "claude-sonnet-5", maxTokens: 16_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    expect(unknownThinking.calibration.groupKey).toBe(OVERALL_HISTORICAL_GROUP);
    expect(unknownThinking.calibration.usedFallback).toBe(true);
  });

  it("ships and applies the generated portable correction with complete context", () => {
    expect(BUNDLED_CLAUDE_CODE_PROFILE.boostedCorrection).toMatchObject({
      featureSchema: "portable-precall-v2",
      trainingSamples: expect.any(Number),
    });
    const result = historicalBaselineForecast(
      {
        model: "claude-opus-5",
        maxTokens: 64_000,
        thinkingEnabled: true,
        promptMentionsPath: false,
        boostedContext: {
          agentLoop: { sessionPosition: 0, loopDepth: 0, priorCallCount: 0 },
        },
      },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );

    expect(result.forecast.source).toBe("trained");
    expect(result.calibration).toMatchObject({
      usedFallback: false,
      boostedCorrectionApplied: true,
      boostedCorrectionReason: "applied",
    });
  });

  it("ships only group keys the backoff ladder can actually select", () => {
    // Guards against the eval script (which writes the profile) and this
    // package (which reads it) drifting apart on key format or tier shape.
    const selectable = new Set([OVERALL_HISTORICAL_GROUP]);
    const prevOutputLevels = [0, 199, 200, 799, 800, 2_999, 3_000, 50_000].map(
      previousOutputBucket,
    );
    for (const tier of HISTORICAL_GROUP_TIERS) {
      for (const model of ["claude-fable-5", "claude-opus-4-8", "claude-opus-5"]) {
        for (const thinking of ["yes", "no"]) {
          for (const prevOutput of prevOutputLevels) {
            for (const promptPath of ["yes", "no"]) {
              const key = historicalGroupKey(tier, {
                model,
                thinking,
                prevOutput,
                promptPath,
              });
              if (key !== null) selectable.add(key);
            }
          }
        }
      }
    }

    for (const key of Object.keys(BUNDLED_CLAUDE_CODE_PROFILE.groups)) {
      expect(selectable.has(key), `unreachable group key: ${key}`).toBe(true);
    }
  });

  it("ships no group below the default minimum sample size", () => {
    for (const [key, quantiles] of Object.entries(
      BUNDLED_CLAUDE_CODE_PROFILE.groups,
    )) {
      expect(quantiles.sampleSize, `group ${key}`).toBeGreaterThanOrEqual(100);
    }
  });

  it("falls back to the static baseline when no group has enough samples", () => {
    const result = historicalBaselineForecast(
      { model: "unknown", maxTokens: 16_000 },
      BUNDLED_CLAUDE_CODE_PROFILE,
      { minSamples: 20_000 },
    );

    expect(result.forecast.source).toBe("default");
    expect(result.calibration.groupKey).toBeNull();
  });
});

describe("historicalTurnTotalForecast", () => {
  const quantiles = { sampleSize: 900, p50: 5_000, p90: 31_000, p99: 102_000 };
  const profile = {
    id: "test",
    generatedAt: new Date().toISOString(),
    scope: "test",
    eligibleObservations: 900,
    groups: {},
    turnTotals: {
      overall: quantiles,
      "thinking=yes": { sampleSize: 500, p50: 8_000, p90: 40_000, p99: 120_000 },
      "thinking=no": { sampleSize: 40, p50: 2_000, p90: 9_000, p99: 30_000 },
    },
  };

  it("selects the thinking-conditioned turn group when declared and populated", () => {
    const forecast = historicalTurnTotalForecast({ thinkingEnabled: true }, profile);
    expect(forecast).toMatchObject({
      groupKey: "thinking=yes",
      p50: 8_000,
      usedFallback: false,
    });
  });

  it("falls back to overall when the conditioned group is below the sample floor", () => {
    const forecast = historicalTurnTotalForecast({ thinkingEnabled: false }, profile);
    expect(forecast).toMatchObject({ groupKey: "overall", usedFallback: true });
  });

  it("uses overall without a fallback flag when thinking is unknown", () => {
    const forecast = historicalTurnTotalForecast({}, profile);
    expect(forecast).toMatchObject({ groupKey: "overall", usedFallback: false });
  });

  it("returns null when the profile ships no turn distribution", () => {
    expect(historicalTurnTotalForecast({}, { ...profile, turnTotals: undefined })).toBeNull();
  });

  it("ships turn totals in the bundled profile", () => {
    const forecast = historicalTurnTotalForecast(
      { thinkingEnabled: true },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    expect(forecast).not.toBeNull();
    expect(forecast!.p99).toBeGreaterThan(forecast!.p50);
    expect(forecast!.promptCorrectionApplied).toBe(false);
  });

  it("selects the pooled promptPath rung above the thinking rung", () => {
    const withRungs = {
      ...profile,
      turnTotals: {
        ...profile.turnTotals,
        "thinking=yes|promptPath=yes": {
          sampleSize: 200,
          p50: 11_000,
          p90: 50_000,
          p99: 150_000,
        },
      },
    };
    const forecast = historicalTurnTotalForecast(
      { thinkingEnabled: true, promptMentionsPath: true },
      withRungs,
    );
    expect(forecast).toMatchObject({
      groupKey: "thinking=yes|promptPath=yes",
      p50: 11_000,
      usedFallback: false,
      promptCorrectionApplied: false,
    });
    // An unknown path bit must skip the rung, never be filed as "no".
    const unknownPath = historicalTurnTotalForecast(
      { thinkingEnabled: true },
      withRungs,
    );
    expect(unknownPath).toMatchObject({ groupKey: "thinking=yes" });
  });

  it("applies the turn-total correction to a prompt-bearing request and responds to the draft", () => {
    const request = (prompt: string) => ({
      model: "claude-opus-4-8",
      thinkingEnabled: true,
      promptMentionsPath: promptMentionsPath(prompt),
      promptHasImage: false,
      boostedContext: {
        prompt: promptForecastFeatures(prompt),
        agentLoop: { sessionPosition: 1, loopDepth: 0, priorCallCount: 0 },
      },
    });
    const short = historicalTurnTotalForecast(
      request("can you write"),
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    const full = historicalTurnTotalForecast(
      request(
        "can you write a small report into a file lets say ./here.txt a report about predicting output tokens. then review a random pr in the internet",
      ),
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    expect(short!.promptCorrectionApplied).toBe(true);
    expect(full!.promptCorrectionApplied).toBe(true);
    // The point of the turn-total regime: typed intent must move the number.
    // The full artifact-plus-review draft forecasts a materially longer turn.
    expect(full!.p50).toBeGreaterThan(short!.p50 * 1.5);
    expect(full!.p90).toBeGreaterThanOrEqual(full!.p50);
    expect(full!.p99).toBeGreaterThanOrEqual(full!.p90);
  });

  it("passes an optional base text head into the turn-total correction", () => {
    const prompt = "write a small report into ./here.txt about predicting output tokens";
    const request = (textHead?: readonly [number, number, number]) => ({
      model: "claude-opus-4-8",
      thinkingEnabled: true,
      promptMentionsPath: promptMentionsPath(prompt),
      promptHasImage: false,
      boostedContext: {
        prompt: promptForecastFeatures(prompt),
        agentLoop: { sessionPosition: 1, loopDepth: 0, priorCallCount: 0 },
        ...(textHead === undefined ? {} : { textHead }),
      },
    });
    const without = historicalTurnTotalForecast(request(), BUNDLED_CLAUDE_CODE_PROFILE);
    const withHead = historicalTurnTotalForecast(
      request(baseTextHead(prompt)),
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    // Both forms produce a usable, ordered, corrected forecast: a caller that
    // cannot run the head is never worse off than one that can.
    for (const forecast of [without, withHead]) {
      expect(forecast!.promptCorrectionApplied).toBe(true);
      expect(forecast!.p50).toBeGreaterThan(0);
      expect(forecast!.p90).toBeGreaterThanOrEqual(forecast!.p50);
      expect(forecast!.p99).toBeGreaterThanOrEqual(forecast!.p90);
    }
  });

  it("ignores indices >= 38 when the shipped turnTotalBoost is a v3 model", () => {
    const boost = BUNDLED_CLAUDE_CODE_PROFILE.turnTotalBoost;
    expect(boost).toBeDefined();
    const v3Profile = {
      ...BUNDLED_CLAUDE_CODE_PROFILE,
      turnTotalBoost: { ...boost!, featureSchema: "portable-precall-v3" as const },
    };
    const prompt = "write a small report into ./here.txt about predicting output tokens";
    const request = (textHead?: readonly [number, number, number]) => ({
      model: "claude-opus-4-8",
      thinkingEnabled: true,
      promptMentionsPath: promptMentionsPath(prompt),
      promptHasImage: false,
      boostedContext: {
        prompt: promptForecastFeatures(prompt),
        agentLoop: { sessionPosition: 1, loopDepth: 0, priorCallCount: 0 },
        ...(textHead === undefined ? {} : { textHead }),
      },
    });
    const plain = historicalTurnTotalForecast(request(), v3Profile);
    const headed = historicalTurnTotalForecast(request([6.5, 8.25, 9.75]), v3Profile);
    const absurd = historicalTurnTotalForecast(request([-99, 0, 999]), v3Profile);
    expect(headed).toEqual(plain);
    expect(absurd).toEqual(plain);
  });

  it("skips the turn-total correction without prompt features or thinking", () => {
    const noPrompt = historicalTurnTotalForecast(
      { model: "claude-opus-4-8", thinkingEnabled: true },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    expect(noPrompt!.promptCorrectionApplied).toBe(false);
    const noThinking = historicalTurnTotalForecast(
      {
        model: "claude-opus-4-8",
        boostedContext: { prompt: promptForecastFeatures("write a report") },
      },
      BUNDLED_CLAUDE_CODE_PROFILE,
    );
    expect(noThinking!.promptCorrectionApplied).toBe(false);
  });
});

describe("historicalSessionTotalForecast", () => {
  const profile = {
    id: "test",
    generatedAt: new Date().toISOString(),
    scope: "test",
    eligibleObservations: 900,
    groups: {},
    sessionTotals: {
      overall: { sampleSize: 300, p50: 21_000, p90: 117_000, p99: 223_000 },
    },
  };

  it("returns the unconditional session quantiles", () => {
    const forecast = historicalSessionTotalForecast(profile);
    expect(forecast).toMatchObject({
      groupKey: "overall",
      p50: 21_000,
      p90: 117_000,
      p99: 223_000,
      sampleSize: 300,
    });
  });

  it("returns null when the profile ships no session distribution", () => {
    expect(
      historicalSessionTotalForecast({ ...profile, sessionTotals: undefined }),
    ).toBeNull();
  });

  it("returns null when the overall group is below the sample floor", () => {
    const thin = {
      ...profile,
      sessionTotals: { overall: { ...profile.sessionTotals.overall, sampleSize: 10 } },
    };
    expect(historicalSessionTotalForecast(thin)).toBeNull();
    expect(historicalSessionTotalForecast(thin, { minSamples: 5 })).not.toBeNull();
  });

  it("ships session totals in the bundled profile", () => {
    const forecast = historicalSessionTotalForecast(BUNDLED_CLAUDE_CODE_PROFILE);
    expect(forecast).not.toBeNull();
    expect(forecast!.p99).toBeGreaterThan(forecast!.p50);
    expect(forecast!.p50).toBeGreaterThan(0);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageObservation } from "@token-forecaster/core";
import { afterEach, describe, expect, it } from "vitest";

import { evaluatePersonalModel } from "./evaluate.js";
import { measureSufficiency } from "./sufficiency.js";
import { personalForecast } from "./forecast.js";
import { PersonalStore } from "./store.js";
import { quantile, trainPersonalProfile } from "./train.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-personal-"));
  dirs.push(dir);
  return dir;
}

let counter = 0;
function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  counter += 1;
  return {
    provider: "openai",
    id: `obs-${counter}`,
    sourceFile: "/tmp/fixture.jsonl",
    sourceOffset: counter,
    sessionId: "sess-1",
    turnIndex: 0,
    callIndex: counter,
    scale: "call",
    timestamp: new Date(Date.UTC(2026, 0, 1) + counter * 60_000).toISOString(),
    model: "gpt-5.2-codex",
    reasoning: "high",
    usageSource: "provider_exact",
    inputTokens: 1_000,
    cachedInputTokens: 500,
    outputTokens: 500,
    reasoningOutputTokens: 100,
    totalTokens: 1_500,
    contextWindow: 272_000,
    promptFeatures: null,
    ...overrides,
  };
}

/** Prompt features of a given length, with everything else held constant. */
function features(chars: number): NonNullable<UsageObservation["promptFeatures"]> {
  return {
    chars,
    words: Math.max(1, Math.round(chars / 6)),
    lines: 1,
    codeFences: 0,
    urls: 0,
    paths: 0,
    hasQuestion: false,
    hasImperative: true,
    images: 0,
    hash: "",
  };
}

describe("quantile", () => {
  it("interpolates between order statistics", () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10], 0.99)).toBe(10);
  });
});

describe("trainPersonalProfile", () => {
  it("never pools providers or scales into one distribution", () => {
    const rows = [
      ...Array.from({ length: 40 }, () => observation({ provider: "openai", outputTokens: 100 })),
      ...Array.from({ length: 40 }, () =>
        observation({ provider: "anthropic", model: "claude-opus-5", outputTokens: 9_000 }),
      ),
      ...Array.from({ length: 40 }, () =>
        observation({ provider: "openai", scale: "turn", outputTokens: 5_000 }),
      ),
    ];
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 10,
    });
    expect(Object.keys(profile.scales).sort()).toEqual([
      "anthropic|call",
      "openai|call",
      "openai|turn",
    ]);
    expect(profile.scales["openai|call"]!.groups["overall"]!.p50).toBe(100);
    expect(profile.scales["anthropic|call"]!.groups["overall"]!.p50).toBe(9_000);
    expect(profile.scales["openai|turn"]!.groups["overall"]!.p50).toBe(5_000);
  });

  it("drops a dimension rather than inventing a level when it is unknown", () => {
    const rows = Array.from({ length: 40 }, () => observation({ reasoning: null }));
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 10,
    });
    const keys = Object.keys(profile.scales["openai|call"]!.groups);
    expect(keys).toContain("model=gpt-5.2-codex");
    expect(keys.some((k) => k.includes("reasoning="))).toBe(false);
  });
});

describe("the serve gate", () => {
  it("refuses to serve a slice the holdout could not measure", () => {
    // Far too little history to test anything: the honest answer is the profile
    // shipped in the box, not this user's forty rows.
    const rows = Array.from({ length: 40 }, () => observation({ provider: "anthropic", model: "claude-opus-5" }));
    const evaluation = evaluatePersonalModel(rows);
    expect(evaluation.serve["anthropic|call"]).toBe(false);

    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 10,
      serve: evaluation.serve,
      serveReasons: evaluation.serveReasons,
    });
    expect(profile.scales["anthropic|call"]!.adopted).toBe(false);

    const result = personalForecast(profile, {
      provider: "anthropic",
      scale: "call",
      model: "claude-opus-5",
    });
    expect(result.source).toBe("bundled_fallback");
    expect(result.usedFallback).toBe(true);
    // The refusal is never silent.
    expect(result.reason).toContain("not being used");
  });

  it("keeps the gated slice on the profile so the dashboard can still show it", () => {
    const rows = Array.from({ length: 40 }, () => observation({ provider: "anthropic" }));
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 10,
      serve: { "anthropic|call": false },
    });
    const slice = profile.scales["anthropic|call"]!;
    expect(slice.sampleSize).toBe(40);
    expect(Object.keys(slice.groups)).toContain("overall");
    expect(slice.adopted).toBe(false);
    expect(slice.adoptedReason).not.toBe("");
  });

  it("serves a slice with no recorded verdict, so evaluation candidates stay ungated", () => {
    const rows = Array.from({ length: 200 }, (_, i) => observation({ outputTokens: 400 + i }));
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 60,
    });
    expect(profile.scales["openai|call"]!.adopted).toBe(true);
    expect(personalForecast(profile, {
      provider: "openai",
      scale: "call",
      model: "gpt-5.2-codex",
      reasoning: "high",
    }).source).toBe("personal_group");
  });

  it("serves a profile written before the gate existed", () => {
    const rows = Array.from({ length: 200 }, (_, i) => observation({ outputTokens: 400 + i }));
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 60,
    });
    // Exactly what a profile deserialized from an older store looks like.
    const legacy = structuredClone(profile);
    // @ts-expect-error deliberately removing a field older profiles lack
    delete legacy.scales["openai|call"]!.adopted;
    expect(personalForecast(legacy, {
      provider: "openai",
      scale: "call",
      model: "gpt-5.2-codex",
      reasoning: "high",
    }).source).toBe("personal_group");
  });

  it("quotes the candidate that ships, not the best one, when prompt rungs are forced", () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      observation({ outputTokens: 300 + (i % 97), promptFeatures: features(50 + (i % 4) * 400) }),
    );
    const slice = evaluatePersonalModel(rows, { promptTiersForced: true }).slices.find(
      (s) => s.scale === "call",
    )!;
    const cold = slice.candidates.find((c) => c.name === "cold_start")!;
    const prompt = slice.candidates.find((c) => c.name === "personal_prompt")!;
    // Forcing means personal_prompt is what gets written, so that is the only
    // candidate the serve verdict is entitled to be computed from.
    expect(slice.gainOverColdStartAsShipped).toBeCloseTo(1 - prompt.pinballMean / cold.pinballMean, 12);
    expect(slice.beatsColdStart).toBe(slice.gainOverColdStartAsShipped >= 0.02);
    expect(slice.beatsColdStartReason).toContain("cold start");
  });

  it("gates on the shipped candidate even when a better one was measured", () => {
    // personal_flat is the honest baseline; if conditioning loses to it the
    // trainer writes flat, and the gate must score flat rather than quoting the
    // best-of across candidates.
    const rows = Array.from({ length: 600 }, (_, i) => observation({ outputTokens: 400 + (i % 53) }));
    const slice = evaluatePersonalModel(rows).slices.find((s) => s.scale === "call")!;
    const shipped = slice.candidates.find((c) =>
      slice.conditioningHelps ? (slice.promptTiersHelp ? c.name === "personal_prompt" : c.name === "personal_core") : c.name === "personal_flat",
    )!;
    const cold = slice.candidates.find((c) => c.name === "cold_start")!;
    expect(slice.gainOverColdStartAsShipped).toBeCloseTo(1 - shipped.pinballMean / cold.pinballMean, 12);
  });
});

describe("personalForecast", () => {
  it("prefers the user's own rung and says so", () => {
    const rows = Array.from({ length: 200 }, (_, i) => observation({ outputTokens: 400 + i }));
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: false,
      promptTiersReason: "test",
      minSamples: 60,
    });
    const result = personalForecast(profile, {
      provider: "openai",
      scale: "call",
      model: "gpt-5.2-codex",
      reasoning: "high",
    });
    expect(result.source).toBe("personal_group");
    expect(result.usedFallback).toBe(false);
    expect(result.groupKey).toBe("model=gpt-5.2-codex|reasoning=high");
    expect(result.sampleSize).toBe(200);
    expect(result.p50).toBeLessThan(result.p90);
  });

  it("falls back to the bundled Claude profile only for Anthropic cold starts", () => {
    const anthropic = personalForecast(null, {
      provider: "anthropic",
      scale: "call",
      model: "claude-opus-5",
    });
    expect(anthropic.source).toBe("bundled_fallback");
    expect(anthropic.usedFallback).toBe(true);

    // An OpenAI cold start must NOT borrow Anthropic quantiles.
    const openai = personalForecast(null, { provider: "openai", scale: "call", model: "gpt-5.2-codex" });
    expect(openai.source).toBe("static_baseline");
    expect(openai.usedFallback).toBe(true);
  });


  it("moves the forecast within a prompt-size bucket when asked to interpolate", () => {
    // Two size rungs with clearly different outputs: short prompts are cheap,
    // long ones are not. Between their anchors (155 and 600 characters) the
    // step rung says one number and the blend says a curve.
    const rows = [
      ...Array.from({ length: 100 }, () =>
        observation({ outputTokens: 1_000, promptFeatures: features(150) }),
      ),
      ...Array.from({ length: 100 }, () =>
        observation({ outputTokens: 9_000, promptFeatures: features(600) }),
      ),
    ];
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: true,
      promptTiersReason: "test",
      minSamples: 60,
    });
    const at = (chars: number, interpolate: boolean) =>
      personalForecast(profile, {
        provider: "openai",
        scale: "call",
        model: "gpt-5.2-codex",
        reasoning: "high",
        promptFeatures: features(chars),
        interpolatePromptSize: interpolate,
      }).p50;

    // Without it, every prompt in 80-300 gets one number.
    expect(at(90, false)).toBe(at(290, false));
    // With it, the number climbs across the bucket and on across its edge.
    expect(at(160, true)).toBeLessThan(at(290, true));
    expect(at(290, true)).toBeLessThan(at(400, true));
    // At an anchor the blend is the measured rung itself, and no prompt is ever
    // forecast outside the two rungs it sits between.
    expect(at(155, true)).toBe(at(155, false));
    expect(at(400, true)).toBeGreaterThan(1_000);
    expect(at(400, true)).toBeLessThan(9_000);
  });

  it("keeps moving on the pooled length curve when a model's own size rungs are too thin", () => {
    // One model with plenty of history but only at one length, plus enough
    // other traffic to measure how length behaves across the board.
    const rows = [
      ...Array.from({ length: 100 }, () =>
        observation({ outputTokens: 2_000, promptFeatures: features(150) }),
      ),
      ...Array.from({ length: 80 }, () =>
        observation({
          model: "gpt-5.2-mini",
          outputTokens: 500,
          promptFeatures: features(150),
        }),
      ),
      ...Array.from({ length: 80 }, () =>
        observation({
          model: "gpt-5.2-mini",
          outputTokens: 4_000,
          promptFeatures: features(600),
        }),
      ),
    ];
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: true,
      promptTiersReason: "test",
      minSamples: 60,
    });
    const at = (chars: number) =>
      personalForecast(profile, {
        provider: "openai",
        scale: "call",
        model: "gpt-5.2-codex",
        reasoning: "high",
        promptFeatures: features(chars),
        interpolatePromptSize: true,
      });

    // gpt-5.2-codex has no 300-1200 rung of its own, so its level is carried by
    // the shape everything else showed at those lengths.
    expect(at(200).p50).toBeLessThan(at(500).p50);
    expect(at(500).reason).toContain("prompt-length curve");
    // A borrowed shape is still this user's own data, not a cold start.
    expect(at(500).usedFallback).toBe(false);
  });

  it("leaves a prompt past the outermost rung on that rung", () => {
    const rows = Array.from({ length: 100 }, () =>
      observation({ outputTokens: 1_000, promptFeatures: features(150) }),
    );
    const profile = trainPersonalProfile(rows, {
      id: "t",
      withPromptTiers: true,
      promptTiersReason: "test",
      minSamples: 60,
    });
    const request = {
      provider: "openai" as const,
      scale: "call" as const,
      model: "gpt-5.2-codex",
      reasoning: "high",
      promptFeatures: features(90),
    };
    // Nothing measured below this rung, so there is nothing to blend toward.
    expect(personalForecast(profile, { ...request, interpolatePromptSize: true }).p50).toBe(
      personalForecast(profile, request).p50,
    );
  });

  it("keeps quantiles monotone and clamped to maxTokens", () => {
    const result = personalForecast(null, {
      provider: "anthropic",
      scale: "turn",
      model: "claude-opus-5",
      maxTokens: 2_000,
    });
    expect(result.p50).toBeLessThanOrEqual(result.p90);
    expect(result.p90).toBeLessThanOrEqual(result.p99);
    expect(result.p99).toBeLessThanOrEqual(2_000);
  });
});

describe("evaluatePersonalModel", () => {
  it("scores candidates on a strictly later holdout", () => {
    // Two models with very different output scales: conditioning must win.
    const rows: UsageObservation[] = [];
    for (let i = 0; i < 600; i += 1) {
      rows.push(
        observation({
          model: i % 2 === 0 ? "gpt-5.2-codex" : "gpt-5.1-codex-mini",
          outputTokens: i % 2 === 0 ? 2_000 + (i % 50) : 100 + (i % 20),
        }),
      );
    }
    const evaluation = evaluatePersonalModel(rows, {
      trainFraction: 0.7,
      minHoldout: 50,
      minSamples: 30,
    });
    const slice = evaluation.slices[0]!;
    expect(slice.trainN + slice.holdoutN).toBe(600);
    expect(Date.parse(slice.holdoutSpan![0])).toBeGreaterThan(Date.parse(slice.trainSpan![0]));
    expect(slice.conditioningHelps).toBe(true);
    const flat = slice.candidates.find((c) => c.name === "personal_flat")!;
    const core = slice.candidates.find((c) => c.name === "personal_core")!;
    expect(core.pinballMean).toBeLessThan(flat.pinballMean);
    expect(core.coverageP90).toBeGreaterThan(core.coverageP50);
  });

  it("excludes non-exact usage from scoring and says why", () => {
    const rows = Array.from({ length: 300 }, () =>
      observation({ usageSource: "dom_estimate" }),
    );
    const evaluation = evaluatePersonalModel(rows, { minHoldout: 10 });
    expect(evaluation.excluded["not_provider_exact"]).toBe(300);
    expect(evaluation.slices).toHaveLength(0);
  });
});

describe("PersonalStore", () => {
  it("round-trips observations, upserts by id, and resets cleanly", () => {
    const store = PersonalStore.open(tempDir());
    const salt = store.salt();
    expect(salt).toHaveLength(64);
    expect(store.salt()).toBe(salt);

    const rows = [
      observation({ id: "a", outputTokens: 100 }),
      observation({
        id: "b",
        outputTokens: 200,
        promptFeatures: {
          chars: 42,
          words: 8,
          lines: 1,
          codeFences: 0,
          urls: 0,
          paths: 1,
          hasQuestion: false,
          hasImperative: true,
          images: 0,
          hash: "deadbeefdeadbeef",
        },
      }),
    ];
    store.ingest("openai", rows, new Map([["k1", { size: 10, mtimeMs: 1, offset: 10, path: "/x" }]]), {
      filesScanned: 1,
      filesFailed: 0,
      rowsRead: 2,
      rowsUsed: 2,
      skipped: {},
      schemaVariants: {},
      unknownEvents: {},
    });
    expect(store.summary().observations).toBe(2);

    // A turn that grew must update in place rather than duplicate.
    store.ingest("openai", [observation({ id: "a", outputTokens: 999 })], new Map(), {
      filesScanned: 0,
      filesFailed: 0,
      rowsRead: 1,
      rowsUsed: 1,
      skipped: {},
      schemaVariants: {},
      unknownEvents: {},
    });
    const loaded = store.observations({ provider: "openai" });
    expect(loaded).toHaveLength(2);
    expect(loaded.find((o) => o.id === "a")!.outputTokens).toBe(999);
    expect(loaded.find((o) => o.id === "b")!.promptFeatures!.hasImperative).toBe(true);

    const cursors = store.cursors("openai");
    expect(cursors.get("k1")).toEqual({ size: 10, mtimeMs: 1, offset: 10 });

    store.reset();
    expect(store.summary().observations).toBe(0);
    expect(store.cursors("openai").size).toBe(0);
    // The salt is rotated on reset so old hashes cannot be correlated.
    expect(store.salt()).not.toBe(salt);
    store.close();
  });

  it("survives a reopen without rescanning", () => {
    const dir = tempDir();
    const first = PersonalStore.open(dir);
    first.ingest("openai", [observation({ id: "keep" })], new Map([["k", { size: 5, mtimeMs: 2, offset: 5 }]]), {
      filesScanned: 1,
      filesFailed: 0,
      rowsRead: 1,
      rowsUsed: 1,
      skipped: {},
      schemaVariants: {},
      unknownEvents: {},
    });
    first.close();

    const second = PersonalStore.open(dir);
    expect(second.summary().observations).toBe(1);
    expect(second.cursors("openai").get("k")?.offset).toBe(5);
    second.close();
  });

  it("has no column that could hold prompt or response text", () => {
    const store = PersonalStore.open(tempDir());
    // Guard the privacy contract structurally: the observations table is
    // pinned to an exact column set, so any future migration that adds a
    // free-text column has to change this test deliberately.
    const ddl = store.schemaSql();
    const observationsDdl = ddl.slice(ddl.indexOf("CREATE TABLE observations"));
    const columns = observationsDdl
      .slice(observationsDdl.indexOf("(") + 1, observationsDdl.indexOf(")"))
      .split(",")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean)
      .sort();
    expect(columns).toEqual(
      [
        "id", "provider", "session_id", "turn_index", "call_index", "scale",
        "ts_ms", "timestamp", "model", "reasoning", "usage_source",
        "input_tokens", "cached_input_tokens", "output_tokens",
        "reasoning_output_tokens", "total_tokens", "context_window",
        "source_file", "source_offset",
        "pf_chars", "pf_words", "pf_lines", "pf_code_fences", "pf_urls",
        "pf_paths", "pf_has_question", "pf_has_imperative", "pf_images", "pf_hash",
        // v4. Loop structure and the upload cursor: an opaque turn id, a JSON
        // array of tool NAMES from a fixed vocabulary, a character count, a
        // provider stop reason, and a timestamp. None of them can hold a
        // prompt or a response, which is the property this list exists to pin.
        "turn_root_id", "tool_names", "largest_tool_input_chars", "stop_reason",
        "uploaded_at",
      ].sort(),
    );
    store.close();
  });
});

describe("measureSufficiency", () => {
  it("reports a cold verdict when a slice cannot be fitted", () => {
    const rows = Array.from({ length: 40 }, () => observation());
    const report = measureSufficiency(rows, { minHoldout: 5 });
    const slice = report.slices[0]!;
    expect(slice.verdict).toBe("cold");
    expect(slice.curve).toHaveLength(0);
    expect(slice.suggestedAdditional).toBeGreaterThan(0);
    expect(report.headline).toContain("cold-start fallback");
  });

  it("measures where the personal model overtakes the cold start", () => {
    // A stable personal distribution far from the static baseline: the curve
    // should cross the cold start early and then flatten.
    const rows = Array.from({ length: 2_000 }, (_, i) =>
      observation({ provider: "openai", outputTokens: 300 + (i % 40) }),
    );
    const report = measureSufficiency(rows, { minHoldout: 100 });
    const slice = report.slices[0]!;
    expect(slice.curve.length).toBeGreaterThan(2);
    expect(slice.coldStartPinball).toBeGreaterThan(0);
    expect(slice.beatsColdStartAtN).not.toBeNull();
    expect(slice.currentPinball).toBeLessThan(slice.coldStartPinball);
    expect(slice.verdict).toBe("saturated");
    expect(slice.saturationN).not.toBeNull();
    // Every curve point is fitted on training rows only.
    expect(Math.max(...slice.curve.map((p) => p.n))).toBeLessThanOrEqual(slice.trainN);
  });

  it("flags a slice where recency matters more than volume", () => {
    const rows = Array.from({ length: 2_000 }, (_, i) =>
      observation({ provider: "openai", outputTokens: 300 + (i % 40) }),
    );
    const report = measureSufficiency(rows, { minHoldout: 100 });
    const slice = report.slices[0]!;
    expect(slice.recencyDominates).toBe(true);
    expect(slice.saturationN!).toBeLessThanOrEqual(slice.trainN * 0.25);
  });
});

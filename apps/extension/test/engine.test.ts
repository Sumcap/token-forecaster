import { describe, expect, it } from "vitest";
import type { OutputForecast } from "@token-forecaster/core";
import { buildBand, buildViewModel, type EngineInput } from "../src/lib/engine.js";
import { bandOf, scoringScale, type ForecastSnapshot, type TurnRecord } from "../src/lib/turn.js";
import { STRINGS } from "../src/lib/format.js";
import type { ResolvedModel } from "../src/lib/model-map.js";
import type { ResolvedThinking } from "../src/lib/thinking.js";

/** Opus 5 has its own group in the shipped profile; Sonnet 5 does not. */
const PAGE_MODEL: ResolvedModel = {
  id: "claude-opus-5",
  resolution: "page",
  pageLabel: "Claude Opus 5",
};

const UNFITTED_MODEL: ResolvedModel = {
  id: "claude-sonnet-5",
  resolution: "page",
  pageLabel: "Claude Sonnet 5",
};

const THINKING_FROM_PAGE: ResolvedThinking = {
  enabled: true,
  source: "page",
  pageLabel: "High",
};

const THINKING_ASSUMED: ResolvedThinking = {
  enabled: true,
  source: "assumed",
  pageLabel: null,
};

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    draft: "Explain how the forecaster picks a group.",
    inputTokens: 12,
    inputQuality: "character_heuristic",
    verifyState: "off",
    verifyError: null,
    model: PAGE_MODEL,
    thinking: THINKING_ASSUMED,
    surface: "code",
    sessionPosition: 0,
    hasImage: false,
    transcriptTokens: null,
    ...overrides,
  };
}

function forecast(p50: number, p90: number, p99?: number): OutputForecast {
  return {
    p50,
    p90,
    ...(p99 === undefined ? {} : { p99 }),
    confidence: "medium",
    source: "historical",
    predictorVersion: "test",
  };
}

const meta = (model: ReturnType<typeof buildViewModel>, index: number) =>
  model.meta[index]?.text ?? "";

describe("buildBand", () => {
  it("puts the track's end at p99 and spreads the quantiles on a square-root scale", () => {
    const band = buildBand(forecast(348, 1_400, 4_200), 32_000);
    expect(band.domainKind).toBe("p99");
    // sqrt(348/4200) = 28.8%, sqrt(1400/4200) = 57.7%.
    expect(band.segments[0]!.widthPercent).toBeCloseTo(28.8, 0);
    expect(band.segments[0]!.widthPercent + band.segments[1]!.widthPercent).toBeCloseTo(57.7, 0);
    const total = band.segments.reduce((sum, segment) => sum + segment.widthPercent, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it("fades the segments outward so the far tail is visibly less certain", () => {
    const band = buildBand(forecast(348, 1_400, 4_200), 32_000);
    expect(band.segments.map((segment) => segment.opacity)).toEqual([0.9, 0.45, 0.2]);
  });

  it("beats the linear scale it replaces at the small end", () => {
    const band = buildBand(forecast(348, 1_400, 4_200), 32_000);
    const linear = (348 / 4_200) * 100;
    expect(band.segments[0]!.widthPercent).toBeGreaterThan(linear * 3);
  });

  it("labels every boundary with its real value", () => {
    const band = buildBand(forecast(348, 1_400, 4_200), 32_000);
    expect(band.ticks.map((tick) => tick.label)).toEqual(["348", "1.4k", "4.2k"]);
    expect(band.ticks.at(-1)!.anchor).toBe("end");
  });

  it("extends to the output cap only when the cap is within reach", () => {
    const band = buildBand(forecast(4_000, 12_000, 20_000), 32_000);
    expect(band.domainKind).toBe("cap");
    expect(band.ticks.at(-1)!.label).toBe("cap 32k");
    expect(band.ariaLabel).toContain("output cap");
  });

  it("ends at p90 when the profile carries no p99", () => {
    const band = buildBand(forecast(348, 1_400), 32_000);
    expect(band.domainKind).toBe("p90");
    expect(band.segments).toHaveLength(2);
    expect(band.ariaLabel).toContain("90th percentile");
    expect(band.title).not.toContain("p99");
  });

  it("keeps a segment visible instead of drawing a sliver", () => {
    const band = buildBand(forecast(1, 2, 100_000), 128_000);
    for (const segment of band.segments) {
      expect(segment.widthPercent).toBeGreaterThanOrEqual(1);
    }
  });

  it("merges tick labels that would collide", () => {
    const band = buildBand(forecast(1_000, 1_050, 4_200), 32_000);
    expect(band.ticks).toHaveLength(2);
    expect(band.ticks[0]!.label).toBe("1k · 1.1k");
  });

  it("keeps only the domain label when every quantile lands on the same spot", () => {
    const band = buildBand(forecast(3_900, 4_000, 4_100), 32_000);
    expect(band.ticks).toHaveLength(1);
    expect(band.ticks[0]!.anchor).toBe("end");
    // The three numbers are still exact in the tooltip and the aria label.
    expect(band.title).toContain("3,900");
    expect(band.title).toContain("4,100");
  });

  it("names the scale in the aria label, so the shape is never read as linear", () => {
    expect(buildBand(forecast(348, 1_400, 4_200), 32_000).ariaLabel).toContain(
      "Square-root scale",
    );
  });
});

describe("buildViewModel", () => {
  it("shows the empty state for a blank draft", () => {
    const model = buildViewModel(input({ draft: "   ", inputTokens: 0 }));
    expect(model.state).toBe("empty");
    expect(model.pill.text).toBe(STRINGS.emptyPill);
    expect(model.band).toBeNull();
    expect(model.emptyHint).toBe(STRINGS.emptyHint);
  });

  it("puts the input count and a reply range in the pill", () => {
    const model = buildViewModel(input());
    expect(model.state).toBe("ready");
    expect(model.pill.text).toMatch(/^12 in · ~[\d.k]+–[\d.k]+ out$/);
    expect(model.pill.ariaLabel).toContain("Draft 12 tokens");
  });

  it("leads the panel with the forecast, not with plumbing", () => {
    const model = buildViewModel(input());
    expect(model.headline).toMatch(/^~[\d,]+–[\d,]+ tokens out$/);
    expect(model.band).not.toBeNull();
    expect(model.countLabel).toContain("12 in");
    expect(model.countLabel).toContain("estimate");
  });

  it("marks a tuned forecast, and stays silent rather than claiming one", () => {
    expect(buildViewModel(input({ thinking: THINKING_FROM_PAGE })).tuned).toBe(true);
    // The assumed state still names a group, so it tunes too; a model with no
    // history of its own is what leaves the forecast untuned.
    expect(buildViewModel(input()).tuned).toBe(true);
    expect(buildViewModel(input({ model: UNFITTED_MODEL })).tuned).toBe(false);
  });

  it("says when the model has no history of its own", () => {
    const pooled = buildViewModel(
      input({ model: UNFITTED_MODEL, thinking: THINKING_FROM_PAGE }),
    );
    expect(pooled.pooledNote).toBe(STRINGS.pooledModels);
    expect(pooled.tuned).toBe(false);
    expect(buildViewModel(input({ thinking: THINKING_FROM_PAGE })).pooledNote).toBeNull();
  });

  it("keeps the turn total to one line that answers a different question", () => {
    const model = buildViewModel(input());
    expect(model.turnLine).toContain(STRINGS.turnPrefix);
    expect(model.turnLine).not.toBe(model.headline);
  });

  it("moves the turn total when the draft asks for more work", () => {
    const p50 = (line: string | null): number =>
      Number((/~([\d.]+)k?–/.exec(line ?? "")?.[1] ?? "0").replace(/,/g, ""));
    const short = buildViewModel(
      input({ draft: "thanks", thinking: THINKING_FROM_PAGE }),
    );
    const long = buildViewModel(
      input({
        thinking: THINKING_FROM_PAGE,
        draft:
          "Read packages/predictor/src/historical.ts, write a design document that compares every backoff rung, and add a table of the sample sizes.",
      }),
    );
    expect(p50(long.turnLine)).toBeGreaterThan(p50(short.turnLine));
    expect(long.turnTuned).toBe(true);
  });

  it("measures the context as a lower bound, and says so three ways", () => {
    const model = buildViewModel(input({ transcriptTokens: 12_400 }));
    expect(model.meter?.lowerBound).toBe(true);
    expect(model.meter?.caption.startsWith("≥")).toBe(true);
    expect(model.meter?.note).toBe(STRINGS.contextLowerBound);
    expect(model.meter?.ariaValueText).toContain("lower bound");
  });

  it("never reports an unmeasured conversation as an empty one", () => {
    const model = buildViewModel(input());
    expect(model.meter?.lowerBound).toBe(false);
    expect(model.meter?.note).toBe(STRINGS.contextDraftOnly);
  });

  it("states an overflow in words as well as in geometry", () => {
    const model = buildViewModel(input({ transcriptTokens: 999_999 }));
    expect(model.meter?.over).toBe(true);
    expect(model.meter?.caption).toContain(STRINGS.contextOver);
    expect(model.meter?.measuredPercent).toBeLessThanOrEqual(100);
  });

  it("keeps the pill calm below the warning level", () => {
    expect(buildViewModel(input()).pill.level).toBe("normal");
    const loud = buildViewModel(input({ transcriptTokens: 999_999 }));
    expect(loud.pill.level).not.toBe("normal");
    expect(loud.pill.ariaLabel).toContain("Context warning");
  });

  it("reads the model and the thinking level off the page in one meta line", () => {
    const model = buildViewModel(input({ thinking: THINKING_FROM_PAGE }));
    expect(meta(model, 0)).toContain("from the page");
    expect(meta(model, 1)).toBe(STRINGS.thinkingFromPage("High"));
    expect(model.meta[1]?.title).toBe(STRINGS.thinkingCountsAs(true));
    expect(model.thinkingControl).toBe("on");
  });

  it("says so when the thinking state is an assumption, and offers the control", () => {
    const model = buildViewModel(input());
    expect(meta(model, 1)).toBe(STRINGS.thinkingAssumed("on"));
    expect(model.meta[1]?.title).toBe(STRINGS.thinkingAssumedNote);
    expect(model.thinkingControl).toBe("on");
  });

  it("reads the newest reply when the effort control cannot be read", () => {
    const model = buildViewModel(
      input({ thinking: { enabled: false, source: "transcript", pageLabel: null } }),
    );
    expect(meta(model, 1)).toBe(STRINGS.thinkingFromTranscript("off"));
    expect(model.thinkingControl).toBe("off");
  });

  it("forecasts the thinking group by default, which is the longer one", () => {
    const assumed = buildViewModel(input());
    const off = buildViewModel(
      input({ thinking: { enabled: false, source: "override", pageLabel: null } }),
    );
    expect(assumed.headline).not.toBe(off.headline);
    expect(assumed.pooledNote).toBeNull();
  });

  it("shows an override without hiding what the page said", () => {
    const model = buildViewModel(
      input({ thinking: { enabled: false, source: "override", pageLabel: "High" } }),
    );
    expect(meta(model, 1)).toBe(STRINGS.thinkingOverride("off", "High"));
    expect(model.thinkingControl).toBe("off");
  });

  it("caps the confidence and calls chat out of domain", () => {
    const chat = buildViewModel(input({ surface: "chat" }));
    expect(meta(chat, 2)).toBe("confidence low");
    expect(chat.caveat).toBe(STRINGS.caveatChat);
  });

  it("caps the confidence at low on the surface it was fitted for too", () => {
    // The library can return "medium", but every sample behind it belongs to
    // one person, so the chip never shows more than "low" until the transfer
    // probe reports (docs/MULTI-USER-PLAN.md).
    const code = buildViewModel(input({ thinking: THINKING_FROM_PAGE }));
    expect(code.caveat).toBe(STRINGS.caveatCode);
    expect(meta(code, 2)).toBe("confidence low");
  });

  it("labels a verified count and lights the dot", () => {
    const model = buildViewModel(
      input({ inputQuality: "anthropic_verified", verifyState: "done" }),
    );
    expect(model.pill.verified).toBe(true);
    expect(model.countLabel).toContain("counted");
    expect(model.countTitle).toBe("Anthropic counted, draft only");
  });

  it("says it is still waiting while a verification is in flight", () => {
    const model = buildViewModel(input({ verifyState: "verifying" }));
    expect(model.countLabel).toContain(STRINGS.verifying);
    expect(model.pill.pulsing).toBe(true);
  });

  it("keeps the local estimate and explains a verification failure", () => {
    const model = buildViewModel(input({ verifyError: "401 authentication_error" }));
    expect(model.pill.verified).toBe(false);
    expect(model.warnings[0]).toContain("401");
  });

  it("says when the model was assumed rather than read", () => {
    const model = buildViewModel(
      input({
        model: { id: "claude-opus-5", resolution: "assumed", pageLabel: "Nimbus 2" },
      }),
    );
    expect(meta(model, 0)).toContain("Nimbus 2");
    expect(meta(model, 0)).toContain("assumed");
  });

  it("prices the request from the registry", () => {
    const model = buildViewModel(input());
    expect(model.cost?.value).toMatch(/^\$[\d.]+–\$[\d.]+$/);
    expect(model.cost?.title).toBe(STRINGS.costNote);
  });
});

const SNAPSHOT: ForecastSnapshot = {
  call: { p50: 300, p90: 1_200, p99: 4_000 },
  turn: { p50: 4_000, p90: 30_000, p99: 90_000 },
  callTuned: false,
  turnTuned: false,
  modelId: "claude-opus-5",
  modelName: "Claude Opus 5",
  maxOutputTokens: 64_000,
  thinkingEnabled: true,
  pooled: false,
  sampleSize: 1_200,
  profileScope: "claude-code",
  surface: "code",
};

function settled(id: number, outTokens: number): TurnRecord {
  const scale = scoringScale(SNAPSHOT);
  return {
    id,
    snapshot: SNAPSHOT,
    scale,
    outTokens,
    band: bandOf(outTokens, scale.quantiles),
    abandoned: false,
    startedAt: 0,
    settledAt: 1,
  };
}

describe("buildViewModel, while a reply is being written", () => {
  it("hands the chip a snapshot of exactly what would be frozen on send", () => {
    const view = buildViewModel(input());
    expect(view.snapshot).not.toBeNull();
    expect(view.snapshot!.call.p50).toBeGreaterThan(0);
    expect(view.snapshot!.modelId).toBe("claude-opus-5");
    // The empty composer has nothing to send, so there is nothing to freeze.
    expect(buildViewModel(input({ draft: "" })).snapshot).toBeNull();
  });

  it("scores the turn against the frozen numbers, not against today's forecast", () => {
    const view = buildViewModel(input({ draft: "", live: { snapshot: SNAPSHOT, outTokens: 2_000 } }));
    expect(view.state).toBe("live");
    expect(view.live).not.toBeNull();
    // 2,000 is under the turn p50 of 4,000: on track.
    expect(view.live!.verdict).toBe(STRINGS.bandOnTrack);
    expect(view.live!.tone).toBe("good");
    expect(view.live!.headline).toContain("4k expected");
    expect(view.pill.text).toContain("2k out");
    expect(view.pill.pulsing).toBe(true);
  });

  it("escalates the pill as the reply passes the predicted range", () => {
    const long = buildViewModel(input({ live: { snapshot: SNAPSHOT, outTokens: 50_000 } }));
    expect(long.live!.tone).toBe("warn");
    expect(long.pill.level).toBe("warning");
    const runaway = buildViewModel(input({ live: { snapshot: SNAPSHOT, outTokens: 200_000 } }));
    expect(runaway.live!.tone).toBe("bad");
    expect(runaway.live!.over).toBe(true);
    expect(runaway.live!.markerPercent).toBe(100);
  });

  it("does not end a turn-scale track at the single-call output cap", () => {
    const view = buildViewModel(input({ live: { snapshot: SNAPSHOT, outTokens: 2_000 } }));
    // The turn p99 of 90,000 is well past Opus 5's per-call cap, and a turn of
    // that length is ordinary rather than impossible.
    expect(view.live!.band.domainKind).toBe("p99");
    expect(view.live!.band.domain).toBe(90_000);
    const chat = buildViewModel(
      input({
        surface: "chat",
        live: { snapshot: { ...SNAPSHOT, surface: "chat" }, outTokens: 2_000 },
      }),
    );
    expect(chat.live!.band.domain).toBe(4_000);
  });

  it("keeps the draft forecast alongside a running turn", () => {
    const view = buildViewModel(input({ live: { snapshot: SNAPSHOT, outTokens: 2_000 } }));
    expect(view.band).not.toBeNull();
    expect(view.headline).not.toBeNull();
    expect(view.snapshot).not.toBeNull();
  });

  it("scores a chat reply against the single call, not the whole turn", () => {
    const view = buildViewModel(
      input({
        surface: "chat",
        live: { snapshot: { ...SNAPSHOT, surface: "chat" }, outTokens: 2_000 },
      }),
    );
    // 2,000 is past the call p90 of 1,200.
    expect(view.live!.tone).toBe("warn");
    expect(view.live!.scaleNote).toBe(STRINGS.liveScaleCall);
  });
});

describe("buildViewModel, the conversation's running score", () => {
  it("says nothing until a turn has settled", () => {
    expect(buildViewModel(input()).ledger).toBeNull();
    expect(buildViewModel(input({ ledger: [] })).ledger).toBeNull();
  });

  it("totals the session against the summed p50", () => {
    const view = buildViewModel(input({ ledger: [settled(1, 2_000), settled(2, 6_000)] }));
    expect(view.ledger).not.toBeNull();
    expect(view.ledger!.headline).toContain("8k written");
    expect(view.ledger!.headline).toContain("8k expected");
    expect(view.ledger!.headline).toContain("100% of expected");
    expect(view.ledger!.foot).toContain("2 turns scored");
    expect(view.ledger!.dots).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  bandOf,
  scoringScale,
  summarizeLedger,
  verdictView,
  type ForecastSnapshot,
  type TurnRecord,
} from "../src/lib/turn.js";

function snapshot(overrides: Partial<ForecastSnapshot> = {}): ForecastSnapshot {
  return {
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
    ...overrides,
  };
}

function record(outTokens: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  const base = snapshot();
  const scale = scoringScale(base);
  return {
    id: 1,
    snapshot: base,
    scale,
    outTokens,
    band: bandOf(outTokens, scale.quantiles),
    abandoned: false,
    startedAt: 0,
    settledAt: 1_000,
    ...overrides,
  };
}

describe("scoringScale", () => {
  it("scores a Claude Code turn against the whole-turn quantiles", () => {
    // Everything the turn appends is measured, and on /code that is the loop.
    expect(scoringScale(snapshot())).toEqual({
      quantiles: { p50: 4_000, p90: 30_000, p99: 90_000 },
      kind: "turn",
    });
  });

  it("scores a chat reply against the single-call quantiles", () => {
    expect(scoringScale(snapshot({ surface: "chat" })).kind).toBe("call");
  });

  it("falls back to the call when the turn rung is missing", () => {
    expect(scoringScale(snapshot({ turn: null })).kind).toBe("call");
  });
});

describe("bandOf", () => {
  const quantiles = { p50: 100, p90: 200, p99: 400 };

  it("puts the boundaries in the lower band", () => {
    expect(bandOf(100, quantiles)).toBe("under-p50");
    expect(bandOf(200, quantiles)).toBe("p50-p90");
    expect(bandOf(400, quantiles)).toBe("p90-p99");
  });

  it("names the bands either side of the boundaries", () => {
    expect(bandOf(1, quantiles)).toBe("under-p50");
    expect(bandOf(101, quantiles)).toBe("p50-p90");
    expect(bandOf(201, quantiles)).toBe("p90-p99");
    expect(bandOf(401, quantiles)).toBe("over-p99");
  });

  it("still reports a runaway turn on a rung with no p99", () => {
    const noP99 = { p50: 100, p90: 200 };
    expect(bandOf(300, noP99)).toBe("p90-p99");
    expect(bandOf(301, noP99)).toBe("over-p99");
  });
});

describe("verdictView", () => {
  it("says what was written and how that compares", () => {
    const view = verdictView(record(2_000));
    expect(view.text).toContain("2k written");
    expect(view.text).toContain("shorter than typical");
    expect(view.tone).toBe("good");
    expect(view.icon).toBe("✓");
  });

  it("marks a long turn without pretending it failed", () => {
    const view = verdictView(record(40_000));
    expect(view.tone).toBe("warn");
    expect(view.text).toContain("unusually long");
    // The tooltip has to carry the prediction, or the verdict is unfalsifiable.
    expect(view.title).toContain("4,000");
    expect(view.title).toContain("30,000");
    expect(view.title).toContain("estimated from the rendered text");
  });

  it("does not score a turn that wrote nothing", () => {
    const view = verdictView(record(0, { band: null, abandoned: true }));
    expect(view.tone).toBe("off");
    expect(view.text).toContain("Not scored");
  });
});

describe("summarizeLedger", () => {
  it("is silent until something has been scored", () => {
    expect(summarizeLedger([])).toBeNull();
    expect(summarizeLedger([record(0, { band: null, abandoned: true })])).toBeNull();
  });

  it("totals the turns and counts the ones inside the usual range", () => {
    const summary = summarizeLedger([
      record(2_000, { id: 1 }),
      record(20_000, { id: 2 }),
      record(50_000, { id: 3 }),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.scored).toBe(3);
    expect(summary!.within).toBe(2);
    expect(summary!.written).toBe(72_000);
    expect(summary!.expected).toBe(12_000);
    expect(summary!.expectedHigh).toBe(90_000);
    // Written over the summed p50: a session of longer-than-typical turns, and
    // the wording must not read as a failing grade.
    expect(summary!.ratioPercent).toBe(600);
    expect(summary!.tone).toBe("ok");
  });

  it("reads good when the session lands under the summed p50", () => {
    const summary = summarizeLedger([record(1_000, { id: 1 }), record(2_000, { id: 2 })]);
    expect(summary!.tone).toBe("good");
    expect(summary!.dots).toHaveLength(2);
  });

  it("warns once the session passes the summed p90", () => {
    const summary = summarizeLedger([record(200_000, { id: 1 })]);
    expect(summary!.tone).toBe("warn");
  });

  it("keeps the newest turns when a conversation runs long", () => {
    const many = Array.from({ length: 30 }, (_, index) => record(1_000, { id: index + 1 }));
    expect(summarizeLedger(many)!.dots).toHaveLength(24);
  });
});

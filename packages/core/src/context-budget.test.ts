import { describe, expect, it } from "vitest";
import {
  calculateContextBudget,
  ContextBudgetError,
  DEFAULT_WARNING_THRESHOLDS,
} from "./context-budget.js";

const WINDOW = 200_000;

describe("calculateContextBudget", () => {
  it("handles zero tokens", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: 0,
      reservedOutputTokens: 0,
    });
    expect(r.inputUsageRatio).toBe(0);
    expect(r.inputUsagePercent).toBe(0);
    expect(r.remainingAfterInput).toBe(WINDOW);
    expect(r.remainingAfterReservation).toBe(WINDOW);
    expect(r.reservedOutputFits).toBe(true);
    expect(r.warningLevel).toBe("normal");
    expect(r.warningReasons).toEqual([]);
  });

  it("handles input exactly at the context limit", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: WINDOW,
      reservedOutputTokens: 0,
    });
    expect(r.inputUsageRatio).toBe(1);
    expect(r.remainingAfterInput).toBe(0);
    expect(r.warningLevel).toBe("critical");
    expect(r.reservedOutputFits).toBe(true);
    expect(r.warningReasons.length).toBeGreaterThan(0);
  });

  it("reports overflow for over-limit input, with an explanatory reason", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: WINDOW + 5_000,
      reservedOutputTokens: 0,
    });
    expect(r.warningLevel).toBe("overflow");
    expect(r.inputUsageRatio).toBeGreaterThan(1);
    expect(r.remainingAfterInput).toBe(-5_000);
    expect(r.warningReasons.join(" ")).toMatch(/exceeds the model's context window/);
  });

  it("escalates to critical when input + reserved output exceeds the window", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: 100_000, // 50%: normal on its own
      reservedOutputTokens: 128_000,
    });
    expect(r.reservedOutputFits).toBe(false);
    expect(r.remainingAfterReservation).toBe(-28_000);
    expect(r.warningLevel).toBe("critical");
    expect(r.warningReasons.join(" ")).toMatch(/reserved output budget/);
  });

  it("flags p50 fits but p90 does not", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: 190_000,
      reservedOutputTokens: 4_000,
      outputP50: 5_000,
      outputP90: 14_200,
    });
    expect(r.projectedP50Fits).toBe(true);
    expect(r.projectedP90Fits).toBe(false);
    expect(r.remainingAfterProjectedP50).toBe(5_000);
    expect(r.remainingAfterProjectedP90).toBe(-4_200);
    expect(r.warningReasons.join(" ")).toMatch(/p90 output forecast exceeds/);
    // 95% occupancy is already critical; the p90 miss must not downgrade it
    expect(r.warningLevel).toBe("critical");
  });

  it("emits a safety-margin warning when headroom drops below the margin", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: 50_000,
      reservedOutputTokens: 145_000,
      safetyMarginTokens: 10_000,
    });
    expect(r.reservedOutputFits).toBe(true);
    expect(r.remainingAfterReservation).toBe(5_000);
    expect(r.warningLevel).toBe("warning");
    expect(r.warningReasons.join(" ")).toMatch(/safety margin/);
  });

  it("handles a missing forecast without projected fields or errors", () => {
    const r = calculateContextBudget({
      contextWindow: WINDOW,
      inputTokens: 18_420,
      reservedOutputTokens: 16_000,
    });
    expect(r.remainingAfterProjectedP50).toBeUndefined();
    expect(r.remainingAfterProjectedP90).toBeUndefined();
    expect(r.projectedP50Fits).toBeUndefined();
    expect(r.projectedP90Fits).toBeUndefined();
    expect(r.warningLevel).toBe("normal");
  });

  it("rejects a zero context window (unknown model metadata)", () => {
    expect(() =>
      calculateContextBudget({
        contextWindow: 0,
        inputTokens: 10,
        reservedOutputTokens: 10,
      }),
    ).toThrow(ContextBudgetError);
  });

  it.each([
    ["contextWindow", { contextWindow: -1, inputTokens: 0, reservedOutputTokens: 0 }],
    ["inputTokens", { contextWindow: WINDOW, inputTokens: -5, reservedOutputTokens: 0 }],
    ["reservedOutputTokens", { contextWindow: WINDOW, inputTokens: 0, reservedOutputTokens: -1 }],
    ["safetyMarginTokens", { contextWindow: WINDOW, inputTokens: 0, reservedOutputTokens: 0, safetyMarginTokens: -10 }],
    ["outputP50", { contextWindow: WINDOW, inputTokens: 0, reservedOutputTokens: 0, outputP50: -1 }],
    ["outputP90", { contextWindow: WINDOW, inputTokens: 0, reservedOutputTokens: 0, outputP90: -1 }],
  ] as const)("rejects negative %s", (_name, input) => {
    expect(() => calculateContextBudget(input)).toThrow(ContextBudgetError);
  });

  it("rejects non-integer token values", () => {
    expect(() =>
      calculateContextBudget({
        contextWindow: WINDOW,
        inputTokens: 12.5,
        reservedOutputTokens: 0,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("rejects p90 below p50", () => {
    expect(() =>
      calculateContextBudget({
        contextWindow: WINDOW,
        inputTokens: 0,
        reservedOutputTokens: 0,
        outputP50: 2_000,
        outputP90: 1_000,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("handles very large context windows without precision surprises", () => {
    const window = 1_000_000; // current 1M-token Claude windows
    const r = calculateContextBudget({
      contextWindow: window,
      inputTokens: 950_000,
      reservedOutputTokens: 16_000,
      outputP50: 10_000,
      outputP90: 40_000,
    });
    expect(r.inputUsageRatio).toBeCloseTo(0.95, 10);
    expect(r.warningLevel).toBe("critical");
    expect(r.remainingAfterInput).toBe(50_000);
    expect(r.projectedP50Fits).toBe(true);
    expect(r.projectedP90Fits).toBe(true);
  });

  it("classifies levels at the default thresholds", () => {
    const at = (ratio: number) =>
      calculateContextBudget({
        contextWindow: 100_000,
        inputTokens: Math.round(ratio * 100_000),
        reservedOutputTokens: 0,
      }).warningLevel;
    expect(at(0.59)).toBe("normal");
    expect(at(0.6)).toBe("informational");
    expect(at(0.79)).toBe("informational");
    expect(at(0.8)).toBe("warning");
    expect(at(0.94)).toBe("warning");
    expect(at(0.95)).toBe("critical");
    expect(at(1.0)).toBe("critical");
  });

  it("supports configurable thresholds", () => {
    const r = calculateContextBudget({
      contextWindow: 100_000,
      inputTokens: 50_000,
      reservedOutputTokens: 0,
      thresholds: { informational: 0.4, warning: 0.45, critical: 0.55 },
    });
    expect(r.warningLevel).toBe("warning");
  });

  it("rejects inconsistent threshold overrides", () => {
    expect(() =>
      calculateContextBudget({
        contextWindow: 100_000,
        inputTokens: 0,
        reservedOutputTokens: 0,
        thresholds: { informational: 0.9, warning: 0.5 },
      }),
    ).toThrow(ContextBudgetError);
    expect(DEFAULT_WARNING_THRESHOLDS.critical).toBeLessThanOrEqual(1);
  });

  it("every non-normal level explains itself", () => {
    const r = calculateContextBudget({
      contextWindow: 100_000,
      inputTokens: 82_000,
      reservedOutputTokens: 4_000,
    });
    expect(r.warningLevel).toBe("warning");
    expect(r.warningReasons[0]).toMatch(/82\.0% of the selected model's context window/);
  });
});

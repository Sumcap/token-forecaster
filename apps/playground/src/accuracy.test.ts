import { describe, expect, it } from "vitest";
import {
  assessActualOutput,
  medianPinballToMeanAbsoluteError,
  oneInFromCoverage,
} from "./accuracy.js";

const forecast = { p50: 500, p90: 2_000, p99: 7_000 };

describe("assessActualOutput", () => {
  it("treats each quantile boundary as covered", () => {
    expect(assessActualOutput(500, forecast).band).toBe("p50");
    expect(assessActualOutput(2_000, forecast).band).toBe("p90");
    expect(assessActualOutput(7_000, forecast).band).toBe("p99");
  });

  it("flags an output beyond p99", () => {
    expect(assessActualOutput(7_001, forecast)).toMatchObject({
      band: "outside",
      tone: "danger",
    });
  });
});

describe("accuracy translations", () => {
  it("translates median pinball loss into mean absolute token error", () => {
    expect(medianPinballToMeanAbsoluteError(275.5)).toBe(551);
  });

  it("translates coverage into a one-in-N miss rate", () => {
    expect(oneInFromCoverage(0.875)).toBe(8);
    expect(oneInFromCoverage(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

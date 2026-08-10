import { describe, expect, it } from "vitest";
import { outputForecastSchema } from "@token-forecaster/core";
import { staticBaselineForecast } from "./index.js";

describe("staticBaselineForecast", () => {
  it("produces a schema-valid, low-confidence default forecast", () => {
    const f = staticBaselineForecast(16_000);
    expect(() => outputForecastSchema.parse(f)).not.toThrow();
    expect(f.confidence).toBe("low");
    expect(f.source).toBe("default");
    expect(f.p50).toBe(1_000);
    expect(f.p90).toBe(4_000);
  });

  it("clamps quantiles to max_tokens and raises cap risk", () => {
    const f = staticBaselineForecast(500);
    expect(f.p50).toBe(500);
    expect(f.p90).toBe(500);
    expect(f.p99).toBe(500);
    expect(f.probabilityOfOutputCap).toBe(0.5);
  });

  it("reports low cap risk for generous max_tokens", () => {
    const f = staticBaselineForecast(64_000);
    expect(f.probabilityOfOutputCap).toBe(0.01);
  });

  it("rejects invalid max_tokens", () => {
    expect(() => staticBaselineForecast(0)).toThrow();
    expect(() => staticBaselineForecast(1.5)).toThrow();
  });
});

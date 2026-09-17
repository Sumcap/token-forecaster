export interface ForecastQuantiles {
  p50: number;
  p90: number;
  p99: number;
}

export type ActualBand = "p50" | "p90" | "p99" | "outside";

export interface ActualAssessment {
  band: ActualBand;
  label: string;
  detail: string;
  tone: "good" | "watch" | "danger";
}

/**
 * Classify one completed response against the forecast that existed before it.
 * Boundaries are inclusive because empirical coverage is defined as y <= q.
 */
export function assessActualOutput(
  actualTokens: number,
  forecast: ForecastQuantiles,
): ActualAssessment {
  if (actualTokens <= forecast.p50) {
    return {
      band: "p50",
      label: "Inside P50",
      detail: "This result fits inside the typical half of responses.",
      tone: "good",
    };
  }
  if (actualTokens <= forecast.p90) {
    return {
      band: "p90",
      label: "Inside P90",
      detail: "Longer than the median, but still inside the normal safety band.",
      tone: "good",
    };
  }
  if (actualTokens <= forecast.p99) {
    return {
      band: "p99",
      label: "Inside P99",
      detail: "This is a tail response. P90 missed it, but P99 still covered it.",
      tone: "watch",
    };
  }
  return {
    band: "outside",
    label: "P99 miss",
    detail: "The response exceeded the widest forecast band.",
    tone: "danger",
  };
}

/** At p=0.5, pinball loss is exactly half the absolute error. */
export function medianPinballToMeanAbsoluteError(pinballLoss: number): number {
  return pinballLoss * 2;
}

export function oneInFromCoverage(coverage: number): number {
  const missRate = 1 - coverage;
  return missRate <= 0 ? Number.POSITIVE_INFINITY : 1 / missRate;
}

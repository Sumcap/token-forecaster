import type { OutputForecast } from "@token-forecaster/core";

/**
 * Baseline 0: the static fallback used before any observations exist.
 *
 * Deliberately wide, clearly labelled heuristic, low confidence. Quantiles
 * are clamped to the configured max_tokens because generation cannot exceed
 * it. The cap probability is a coarse heuristic based on how much of the
 * default distribution the cap cuts off; it is honest about being a default,
 * not a trained estimate.
 */
export const PREDICTOR_VERSION = "baseline-0-static/0.1.0";

export interface StaticBaselineConfig {
  defaultP50: number;
  defaultP90: number;
  defaultP99: number;
}

export const DEFAULT_STATIC_BASELINE: StaticBaselineConfig = {
  defaultP50: 1_000,
  defaultP90: 4_000,
  defaultP99: 12_000,
};

export function staticBaselineForecast(
  maxTokens: number,
  config: StaticBaselineConfig = DEFAULT_STATIC_BASELINE,
): OutputForecast {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`maxTokens must be a positive integer, got ${maxTokens}`);
  }

  const p50 = Math.min(config.defaultP50, maxTokens);
  const p90 = Math.min(config.defaultP90, maxTokens);
  const p99 = Math.min(config.defaultP99, maxTokens);

  // Coarse cap-risk heuristic: how far into the default distribution the cap
  // falls. Not calibrated; replaced by a trained classifier in Phase 5.
  let probabilityOfOutputCap: number;
  if (maxTokens <= config.defaultP50) probabilityOfOutputCap = 0.5;
  else if (maxTokens <= config.defaultP90) probabilityOfOutputCap = 0.15;
  else if (maxTokens <= config.defaultP99) probabilityOfOutputCap = 0.05;
  else probabilityOfOutputCap = 0.01;

  return {
    p50,
    p90,
    p99,
    probabilityOfOutputCap,
    confidence: "low",
    source: "default",
    predictorVersion: PREDICTOR_VERSION,
  };
}


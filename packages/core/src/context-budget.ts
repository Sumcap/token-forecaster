/**
 * Pure, deterministic context-budget calculations.
 *
 * No I/O, no provider calls, no clocks: given the numbers, produce the
 * occupancy ratios, remaining-context figures, fit checks, and explainable
 * warnings. All token values are integers of the model's tokenizer.
 */

export interface ContextBudgetInput {
  /** The model's context window (input side), in tokens. */
  contextWindow: number;
  /** Verified or estimated tokens of the next request's input. */
  inputTokens: number;
  /** The max_tokens (or safety budget) reserved for generation. */
  reservedOutputTokens: number;
  /** Optional forecast quantiles, in output tokens. */
  outputP50?: number;
  outputP90?: number;
  /** Tokens held back as headroom before any warning triggers. */
  safetyMarginTokens?: number;
  /** Override the default warning thresholds (fractions of the window). */
  thresholds?: Partial<WarningThresholds>;
}

export interface WarningThresholds {
  /** Input usage ratio at which the level becomes "informational". */
  informational: number;
  /** Input usage ratio at which the level becomes "warning". */
  warning: number;
  /** Input usage ratio at which the level becomes "critical". */
  critical: number;
}

export const DEFAULT_WARNING_THRESHOLDS: WarningThresholds = {
  informational: 0.6,
  warning: 0.8,
  critical: 0.95,
};

export type WarningLevel =
  | "normal"
  | "informational"
  | "warning"
  | "critical"
  | "overflow";

export interface ContextBudgetResult {
  inputUsageRatio: number;
  inputUsagePercent: number;

  remainingAfterInput: number;
  remainingAfterReservation: number;
  remainingAfterProjectedP50?: number;
  remainingAfterProjectedP90?: number;

  reservedOutputFits: boolean;
  projectedP50Fits?: boolean;
  projectedP90Fits?: boolean;

  warningLevel: WarningLevel;
  warningReasons: string[];
}

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new ContextBudgetError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

/**
 * Compute occupancy, remaining context, fit checks, and warnings.
 *
 * Throws ContextBudgetError on invalid input (negative, non-integer, or a
 * zero/invalid context window). Missing forecast quantiles simply leave the
 * corresponding projected fields undefined; they never fail the calculation.
 */
export function calculateContextBudget(
  input: ContextBudgetInput,
): ContextBudgetResult {
  const {
    contextWindow,
    inputTokens,
    reservedOutputTokens,
    outputP50,
    outputP90,
    safetyMarginTokens = 0,
  } = input;

  assertNonNegativeInteger(contextWindow, "contextWindow");
  if (contextWindow === 0) {
    throw new ContextBudgetError(
      "contextWindow must be positive; got 0 (unknown model metadata should be resolved before budgeting)",
    );
  }
  assertNonNegativeInteger(inputTokens, "inputTokens");
  assertNonNegativeInteger(reservedOutputTokens, "reservedOutputTokens");
  assertNonNegativeInteger(safetyMarginTokens, "safetyMarginTokens");
  if (outputP50 !== undefined) assertNonNegativeInteger(outputP50, "outputP50");
  if (outputP90 !== undefined) assertNonNegativeInteger(outputP90, "outputP90");
  if (outputP50 !== undefined && outputP90 !== undefined && outputP90 < outputP50) {
    throw new ContextBudgetError(
      `outputP90 (${outputP90}) must be >= outputP50 (${outputP50})`,
    );
  }

  const thresholds: WarningThresholds = {
    ...DEFAULT_WARNING_THRESHOLDS,
    ...input.thresholds,
  };
  if (
    !(thresholds.informational < thresholds.warning) ||
    !(thresholds.warning < thresholds.critical) ||
    thresholds.informational <= 0 ||
    thresholds.critical > 1
  ) {
    throw new ContextBudgetError(
      "thresholds must satisfy 0 < informational < warning < critical <= 1",
    );
  }

  const inputUsageRatio = inputTokens / contextWindow;
  const remainingAfterInput = contextWindow - inputTokens;
  const remainingAfterReservation = remainingAfterInput - reservedOutputTokens;

  const remainingAfterProjectedP50 =
    outputP50 !== undefined ? remainingAfterInput - outputP50 : undefined;
  const remainingAfterProjectedP90 =
    outputP90 !== undefined ? remainingAfterInput - outputP90 : undefined;

  const reservedOutputFits = remainingAfterReservation >= 0;
  const projectedP50Fits =
    remainingAfterProjectedP50 !== undefined
      ? remainingAfterProjectedP50 >= 0
      : undefined;
  const projectedP90Fits =
    remainingAfterProjectedP90 !== undefined
      ? remainingAfterProjectedP90 >= 0
      : undefined;

  const warningReasons: string[] = [];
  let warningLevel: WarningLevel;

  if (inputUsageRatio > 1) {
    warningLevel = "overflow";
    warningReasons.push(
      `Input (${inputTokens.toLocaleString()} tokens) exceeds the model's context window of ${contextWindow.toLocaleString()} tokens by ${(inputTokens - contextWindow).toLocaleString()} tokens.`,
    );
  } else if (inputUsageRatio >= thresholds.critical) {
    warningLevel = "critical";
  } else if (inputUsageRatio >= thresholds.warning) {
    warningLevel = "warning";
  } else if (inputUsageRatio >= thresholds.informational) {
    warningLevel = "informational";
  } else {
    warningLevel = "normal";
  }

  if (warningLevel !== "overflow" && warningLevel !== "normal") {
    warningReasons.push(
      `Your current request uses ${(inputUsageRatio * 100).toFixed(1)}% of the selected model's context window.`,
    );
  }

  if (warningLevel !== "overflow" && !reservedOutputFits) {
    warningReasons.push(
      `Input plus the reserved output budget (${reservedOutputTokens.toLocaleString()} tokens) exceeds the context window by ${Math.abs(remainingAfterReservation).toLocaleString()} tokens. Lower max_tokens or shorten the input.`,
    );
    warningLevel = escalate(warningLevel, "critical");
  }

  if (projectedP90Fits === false) {
    warningReasons.push(
      `The p90 output forecast exceeds the remaining context by approximately ${Math.abs(remainingAfterProjectedP90 ?? 0).toLocaleString()} tokens.`,
    );
    warningLevel = escalate(warningLevel, "warning");
  } else if (projectedP50Fits === false) {
    warningReasons.push(
      `The p50 output forecast exceeds the remaining context by approximately ${Math.abs(remainingAfterProjectedP50 ?? 0).toLocaleString()} tokens.`,
    );
    warningLevel = escalate(warningLevel, "warning");
  }

  if (
    warningLevel !== "overflow" &&
    reservedOutputFits &&
    safetyMarginTokens > 0 &&
    remainingAfterReservation < safetyMarginTokens
  ) {
    warningReasons.push(
      `The request fits, but the selected output reservation leaves less than the configured safety margin of ${safetyMarginTokens.toLocaleString()} tokens (${remainingAfterReservation.toLocaleString()} remaining).`,
    );
    warningLevel = escalate(warningLevel, "warning");
  }

  return {
    inputUsageRatio,
    inputUsagePercent: inputUsageRatio * 100,
    remainingAfterInput,
    remainingAfterReservation,
    ...(remainingAfterProjectedP50 !== undefined
      ? { remainingAfterProjectedP50 }
      : {}),
    ...(remainingAfterProjectedP90 !== undefined
      ? { remainingAfterProjectedP90 }
      : {}),
    reservedOutputFits,
    ...(projectedP50Fits !== undefined ? { projectedP50Fits } : {}),
    ...(projectedP90Fits !== undefined ? { projectedP90Fits } : {}),
    warningLevel,
    warningReasons,
  };
}

const LEVEL_ORDER: Record<WarningLevel, number> = {
  normal: 0,
  informational: 1,
  warning: 2,
  critical: 3,
  overflow: 4,
};

function escalate(current: WarningLevel, atLeast: WarningLevel): WarningLevel {
  return LEVEL_ORDER[atLeast] > LEVEL_ORDER[current] ? atLeast : current;
}

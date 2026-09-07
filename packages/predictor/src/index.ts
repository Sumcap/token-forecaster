export {
  DEFAULT_STATIC_BASELINE,
  PREDICTOR_VERSION,
  staticBaselineForecast,
} from "./static.js";
export type { StaticBaselineConfig } from "./static.js";

export {
  BOOST_FEATURE_COUNT_BY_SCHEMA,
  QUANTILE_BOOST_FEATURE_COUNT,
  SUPPORTED_BOOST_FEATURE_SCHEMAS,
  applyQuantileBoost,
  hasCompleteAgentLoopContext,
  portableQuantileBoostFeatures,
  promptForecastFeatures,
} from "./boosted.js";
export type {
  AgentLoopForecastContext,
  BoostedForecastContext,
  ForecastDeliverableType,
  PortableBoostFeatureRequest,
  PortableBoostFeatureSchema,
  PromptForecastFeatures,
  QuantileBoostLeaf,
  QuantileBoostNode,
  QuantileBoostProfile,
  QuantileBoostSplit,
  RequestedOutputFormat,
  SessionForecastContext,
} from "./boosted.js";

export {
  HISTORICAL_GROUP_TIERS,
  HISTORICAL_PREDICTOR_VERSION,
  OVERALL_HISTORICAL_GROUP,
  PREVIOUS_OUTPUT_BUCKET_EDGES,
  buildHistoricalProfile,
  historicalBaselineForecast,
  historicalGroupKey,
  historicalSessionTotalForecast,
  historicalTurnTotalForecast,
  previousOutputBucket,
  promptMentionsPath,
} from "./historical.js";
export type {
  BuildHistoricalProfileOptions,
  HistoricalCalibrationDetails,
  HistoricalDimension,
  HistoricalForecastOptions,
  HistoricalForecastProfile,
  HistoricalForecastRequest,
  HistoricalForecastResult,
  HistoricalQuantiles,
  ProfileProvenance,
  SessionTotalForecast,
  TurnTotalForecast,
} from "./historical.js";
export { BUNDLED_CLAUDE_CODE_PROFILE } from "./bundled-profile.js";

// The text head's pure half only. The shipped head and its 1.2 MB asset sit
// behind `@token-forecaster/predictor/text-head`, so importing this entry does
// not drag the asset into every bundle that only wants the forecaster.
export { baseTextHashTerms, createBaseTextHead } from "./base-text-head.js";
export type {
  BaseTextHeadAsset,
  BaseTextHeadLeaf,
  BaseTextHeadNode,
  BaseTextHeadProjection,
  BaseTextHeadQuantile,
  BaseTextHeadSplit,
} from "./base-text-head.js";

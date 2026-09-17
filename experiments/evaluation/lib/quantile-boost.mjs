import { quantile } from "./stats.mjs";

/** Feature-vector width per schema. */
export const PORTABLE_BOOST_FEATURE_COUNT_BY_SCHEMA = {
  "portable-precall-v1": 36,
  "portable-precall-v2": 37,
  "portable-precall-v3": 38,
  "portable-precall-v4": 42,
  "portable-precall-v5": 45,
};
/**
 * The trainer's DEFAULT schema, deliberately not the newest: the per-call
 * correction still trains on v3, and only callers that pass
 * `featureSchema: "portable-precall-v4"` (the turn-total candidate) offer the
 * text-head columns to the trees.
 */
export const PORTABLE_BOOST_FEATURE_SCHEMA = "portable-precall-v3";
/** Width the extractor always emits: the newest schema, mirroring predictor. */
export const PORTABLE_BOOST_FEATURE_COUNT =
  PORTABLE_BOOST_FEATURE_COUNT_BY_SCHEMA["portable-precall-v5"];
/**
 * Which columns each schema may split on. Every schema except v5 is a prefix of
 * the vector, so the width is the answer. v5 is the exception on purpose: it is
 * v3 plus the session-so-far family, NOT v4 plus it, because the text head at
 * 38-41 was graded and refused (docs/SEMANTIC-PLAN.md) and offering it here
 * would make a v5-vs-v3 comparison measure the head as well as the session.
 * Indices never move, so the family lands at 42-44 and this table -- not the
 * width -- decides what the trees are allowed to see.
 */
export const PORTABLE_BOOST_FEATURE_COLUMNS_BY_SCHEMA = {
  "portable-precall-v5": [
    ...Array.from({ length: 38 }, (_, index) => index),
    42,
    43,
    44,
  ],
};
const META_WIDTH = 24;

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Exact training-side mirror of portableQuantileBoostFeatures() in predictor.
 * `row` contains only privacy-safe pre-call fields produced by load-history.
 */
export function portableBoostFeatures(row) {
  const features = new Float64Array(PORTABLE_BOOST_FEATURE_COUNT);
  features[0] = row.thinking === "yes" ? 1 : 0;
  features[1] = row.promptPath === "yes" ? 1 : row.promptPath === "no" ? 0 : -1;
  features[2] = Math.log1p(row.turnPrompt?.chars ?? 0) / 8;
  features[3] = Math.log1p(row.turnPrompt?.requirements ?? 0) / 3;
  features[4] = row.turnPrompt?.hasLimit ? 1 : 0;
  features[5] = row.turnPrompt?.hasExpansive ? 1 : 0;
  features[6] = row.turnPrompt?.artifactIntent ? 1 : 0;
  features[7] = Math.log1p(row.sessionPosition) / 6;
  features[8] = Math.log1p(row.loopDepth ?? 0) / 5;
  features[9] = Math.log1p(row.priorCalls) / 5;
  features[10] = Math.log1p(row.priorMaxOutput ?? 0) / 10;
  features[11] = Math.log1p(row.priorArtifactCount ?? 0) / 3;
  const categoricals = [
    `model=${row.model}`,
    `format=${row.turnPrompt?.requestedFormat ?? "(unknown)"}`,
    `deliverable=${row.turnPrompt?.deliverableType ?? "(unknown)"}`,
    `priorWrite=${row.priorWrite ?? "(unknown)"}`,
    `priorArtifact=${row.priorArtifact ?? "(unknown)"}`,
  ];
  for (const value of categoricals) {
    features[12 + (fnv1a(value) % META_WIDTH)] = 1;
  }
  // v2: whether the turn-root message carries an image attachment. Tri-state
  // exactly like promptPath -- unknown (-1) is a missing turn root, never "no".
  features[36] =
    row.promptImage === "yes" ? 1 : row.promptImage === "no" ? 0 : -1;
  // v3: short compression follow-up on the turn root. Binary, not tri-state --
  // "no prompt observed" and "prompt that is not a compression follow-up" are
  // the same thing for this bit.
  features[37] = row.turnPrompt?.followupCompression ? 1 : 0;
  // v4: the public base text head's three log1p quantiles (38-40) plus a
  // presence bit (41). `row.textHead` is computed by the caller from the turn
  // opener's text and the text is dropped before the row is written anywhere;
  // rows without it leave all four at zero, which is what a caller with no
  // draft sends at runtime.
  const textHead = row.textHead;
  if (textHead) {
    features[38] = textHead[0];
    features[39] = textHead[1];
    features[40] = textHead[2];
    features[41] = 1;
  }
  // v5: the session so far, computed by the caller from the turn accumulator.
  // 42 is the turn index inside the session, 43 the previous turn's output
  // tokens when that turn had finished before this one started, 44 the presence
  // bit. Rows without the object leave all three at zero, which is what a
  // runtime caller that cannot count its own turns sends.
  const sessionContext = row.sessionContext;
  if (sessionContext) {
    features[42] = Math.log1p(sessionContext.turnsSoFar) / 6;
    features[43] = Math.log1p(sessionContext.previousTurnOutputTokens ?? 0) / 10;
    features[44] = 1;
  }
  return features;
}

export function boostTreeValue(tree, features) {
  let node = tree;
  while (node.feature !== undefined) {
    node = features[node.feature] <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

function fitTree(features, gradients, residuals, probability, thresholds, options) {
  const { minimumLeaf, maxDepth } = options;
  const build = (indices, depth) => {
    if (depth >= maxDepth || indices.length < minimumLeaf * 2) {
      return { value: quantile(indices.map((index) => residuals[index]), probability) };
    }
    let best = null;
    for (const [feature, featureThresholds] of thresholds) {
      for (const threshold of featureThresholds) {
        let leftN = 0;
        let rightN = 0;
        let leftSum = 0;
        let rightSum = 0;
        let leftSquares = 0;
        let rightSquares = 0;
        for (const index of indices) {
          const gradient = gradients[index];
          if (features[index][feature] <= threshold) {
            leftN++;
            leftSum += gradient;
            leftSquares += gradient * gradient;
          } else {
            rightN++;
            rightSum += gradient;
            rightSquares += gradient * gradient;
          }
        }
        if (leftN < minimumLeaf || rightN < minimumLeaf) continue;
        const score =
          leftSquares - (leftSum * leftSum) / leftN +
          rightSquares - (rightSum * rightSum) / rightN;
        if (best === null || score < best.score) {
          best = { feature, threshold, score };
        }
      }
    }
    if (best === null) {
      return { value: quantile(indices.map((index) => residuals[index]), probability) };
    }
    const left = [];
    const right = [];
    for (const index of indices) {
      (features[index][best.feature] <= best.threshold ? left : right).push(index);
    }
    return {
      feature: best.feature,
      threshold: best.threshold,
      left: build(left, depth + 1),
      right: build(right, depth + 1),
    };
  };
  return build(Array.from({ length: features.length }, (_, index) => index), 0);
}

export function applyBoostModel(model, base, row) {
  const features = portableBoostFeatures(row);
  const corrected = model.ensembles.map((trees, index) =>
    Math.max(
      0,
      Math.round(
        base[index] +
          model.learningRate *
            trees.reduce((sum, tree) => sum + boostTreeValue(tree, features), 0),
      ),
    ),
  );
  corrected[1] = Math.max(corrected[0], corrected[1]);
  corrected[2] = Math.max(corrected[1], corrected[2]);
  return corrected;
}

export function trainPortableQuantileBoost(trainRows, baseForecast, options = {}) {
  const probabilities = options.probabilities ?? [0.5, 0.9, 0.99];
  // Defaults re-tuned 10 Aug 2026 by a gated capacity sweep (8 configs, rolling
  // folds, paired session-block bootstrap): depth 3 / 48 iterations / lr 0.08
  // beats the original depth 2 / 24 / 0.12 by -6.4/call [-9.8, -2.9], and beats
  // the one-change variant (depth 3 alone) by -1.8/call [-3.2, -0.3], so house
  // rule 7's simpler-when-tied does not bind. Deeper (4) and longer (96) runs
  // are not separable from this config.
  const learningRate = options.learningRate ?? 0.08;
  const iterations = options.iterations ?? 48;
  const minimumLeaf = options.minimumLeaf ?? 150;
  const maxDepth = options.maxDepth ?? 3;
  // Training against an older schema means offering the tree fewer candidate
  // columns; the extracted vector is always the newest width, so a v2 model
  // trained here is byte-identical to one trained before v3 existed.
  const featureSchema = options.featureSchema ?? PORTABLE_BOOST_FEATURE_SCHEMA;
  const schemaWidth = PORTABLE_BOOST_FEATURE_COUNT_BY_SCHEMA[featureSchema];
  if (schemaWidth === undefined) {
    throw new Error(`Unknown boost feature schema: ${featureSchema}`);
  }
  const features = trainRows.map((row) => portableBoostFeatures(row));
  // Candidate columns: the schema prefix, except where the table above says a
  // schema deliberately skips columns its predecessor owns.
  const columns =
    PORTABLE_BOOST_FEATURE_COLUMNS_BY_SCHEMA[featureSchema] ??
    Array.from({ length: schemaWidth }, (_, feature) => feature);
  const thresholds = new Map(
    columns.map((feature) => {
      const values = features.map((row) => row[feature]);
      return [
        feature,
        [...new Set([0.2, 0.4, 0.6, 0.8].map((p) => quantile(values, p)))],
      ];
    }),
  );
  const ensembles = probabilities.map((probability, quantileIndex) => {
    const predictions = trainRows.map((row) => baseForecast(row)[quantileIndex]);
    const trees = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
      const gradients = trainRows.map((row, index) =>
        row.outputTokens < predictions[index] ? probability - 1 : probability,
      );
      const residuals = trainRows.map(
        (row, index) => row.outputTokens - predictions[index],
      );
      const tree = fitTree(features, gradients, residuals, probability, thresholds, {
        minimumLeaf,
        maxDepth,
      });
      trees.push(tree);
      for (let index = 0; index < trainRows.length; index++) {
        predictions[index] += learningRate * boostTreeValue(tree, features[index]);
      }
    }
    return trees;
  });
  const model = {
    featureSchema,
    learningRate,
    ensembles,
    trainingSamples: trainRows.length,
  };
  return {
    model,
    predict: (row) => applyBoostModel(model, baseForecast(row), row),
  };
}

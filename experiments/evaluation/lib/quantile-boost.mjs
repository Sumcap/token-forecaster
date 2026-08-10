import { quantile } from "./stats.mjs";

export const PORTABLE_BOOST_FEATURE_SCHEMA = "portable-precall-v2";
export const PORTABLE_BOOST_FEATURE_COUNT = 37;
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
    for (let feature = 0; feature < thresholds.length; feature++) {
      for (const threshold of thresholds[feature]) {
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
  const features = trainRows.map(portableBoostFeatures);
  const thresholds = Array.from(
    { length: PORTABLE_BOOST_FEATURE_COUNT },
    (_, feature) => {
      const values = features.map((row) => row[feature]);
      return [...new Set([0.2, 0.4, 0.6, 0.8].map((p) => quantile(values, p)))];
    },
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
    featureSchema: PORTABLE_BOOST_FEATURE_SCHEMA,
    learningRate,
    ensembles,
    trainingSamples: trainRows.length,
  };
  return {
    model,
    predict: (row) => applyBoostModel(model, baseForecast(row), row),
  };
}

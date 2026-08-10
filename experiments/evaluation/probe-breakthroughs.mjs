#!/usr/bin/env node
/**
 * Breakthrough search: privacy-safe pre-call regimes, hurdle models, online
 * task/workload calibration, and conformal correction.
 *
 * Every adopted candidate is evaluated on the same five chronological
 * rolling-origin folds as the shipped model+thinking+promptPath ladder. The
 * 95% interval is a paired session-block bootstrap over per-call loss.
 * Generated actions, output length, tool payload size, and stop reason are
 * used only as labels/oracles and never as candidate inputs.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import {
  blockBootstrapDifference,
  fmt,
  pct,
  pinball,
  quantile,
} from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/breakthrough-probe.json"),
);

const QUANTILES = [0.5, 0.9, 0.99];
const LEVELS = ["p50", "p90", "p99"];
const MIN_GROUP = 100;
const TRAIN_FRACTION = 0.8;
const CV_FOLDS = 5;
const STATIC = [1_000, 4_000, 12_000];
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withResolvedFileContext: true,
});
const rows = loaded
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      Number.isFinite(row.outputTokens) &&
      row.outputTokens >= 0,
  )
  .sort((left, right) => left.timestampMs - right.timestampMs);
const byId = new Map(rows.map((row) => [row.requestId, row]));

const positionBucket = (position) =>
  position === 0 ? "0" : position < 5 ? "1-4" : position < 20 ? "5-19" : position < 60 ? "20-59" : "60+";
const depthBucket = (depth) =>
  depth === 0 ? "0" : depth < 3 ? "1-2" : depth < 10 ? "3-9" : depth < 30 ? "10-29" : "30+";

// Session ordinal is configuration/context known when the request is issued.
// It never reads a previous outcome. Previous-turn summaries below walk only
// explicit parent links, so concurrent sidechains cannot contaminate them.
const sessions = new Map();
for (const row of rows) {
  const key = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  sessions.get(key).push(row);
}
for (const session of sessions.values()) {
  session.sort((a, b) => a.timestampMs - b.timestampMs);
  for (let index = 0; index < session.length; index++) {
    session[index].sessionPosition = index;
    session[index].sessionPositionBucket = positionBucket(index);
  }
}

for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
  row.action = row.tools[0] ?? "(no-tool)";
  row.isWrite = row.action === "Write";
  // Label only: payload size and chosen action are learned after forecasting.
  row.isLongArtifact =
    row.action === "Write" || (row.action === "Edit" && row.toolChars >= 4_000);
  row.isLongOutput = row.outputTokens >= 3_000;
  row.depthBucket = row.loopDepthExact ? depthBucket(row.loopDepth) : null;

  let parent =
    row.parentRequestId === null ? null : byId.get(row.parentRequestId) ?? null;
  let priorCalls = 0;
  let priorWrites = 0;
  let priorArtifacts = 0;
  let priorMaxOutput = 0;
  let priorReadCalls = 0;
  let priorSearchCalls = 0;
  let priorMutationCalls = 0;
  let priorFileToolCalls = 0;
  const resolvedPaths = new Set(row.resultPathHashes ?? []);
  const readPaths = new Set();
  const searchPaths = new Set();
  const mutationPaths = new Set();
  const priorContextSemantic = new Map();
  const addContextSemantic = (features, weight = 1) => {
    for (const [index, value] of features ?? []) {
      priorContextSemantic.set(
        index,
        (priorContextSemantic.get(index) ?? 0) + weight * value,
      );
    }
  };
  addContextSemantic(row.resultSemanticHash);
  const seen = new Set();
  while (parent && priorCalls < 200 && !seen.has(parent.requestId)) {
    seen.add(parent.requestId);
    priorCalls++;
    if (priorCalls <= 5) {
      const weight = 1 / Math.sqrt(priorCalls);
      addContextSemantic(parent.assistantTextSemanticHash, weight);
      addContextSemantic(parent.assistantThinkingSemanticHash, weight);
      addContextSemantic(parent.toolInputSemanticHash, weight);
      addContextSemantic(parent.resultSemanticHash, weight);
    }
    for (const fingerprint of parent.toolPathHashes ?? []) resolvedPaths.add(fingerprint);
    for (const fingerprint of parent.resultPathHashes ?? []) resolvedPaths.add(fingerprint);
    for (const fingerprint of parent.readPathHashes ?? []) {
      resolvedPaths.add(fingerprint);
      readPaths.add(fingerprint);
    }
    for (const fingerprint of parent.searchPathHashes ?? []) {
      resolvedPaths.add(fingerprint);
      searchPaths.add(fingerprint);
    }
    for (const fingerprint of parent.mutationPathHashes ?? []) {
      resolvedPaths.add(fingerprint);
      mutationPaths.add(fingerprint);
    }
    if ((parent.toolPathHashes?.length ?? 0) > 0) priorFileToolCalls++;
    if ((parent.readPathHashes?.length ?? 0) > 0) priorReadCalls++;
    if ((parent.searchPathHashes?.length ?? 0) > 0) priorSearchCalls++;
    if ((parent.mutationPathHashes?.length ?? 0) > 0) priorMutationCalls++;
    if ((parent.tools[0] ?? "(no-tool)") === "Write") priorWrites++;
    if (
      (parent.tools[0] ?? "(no-tool)") === "Write" ||
      ((parent.tools[0] ?? "(no-tool)") === "Edit" && parent.toolChars >= 4_000)
    ) {
      priorArtifacts++;
    }
    priorMaxOutput = Math.max(priorMaxOutput, parent.outputTokens);
    parent =
      parent.parentRequestId === null
        ? null
        : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
  row.priorMaxBucket =
    priorCalls === 0
      ? null
      : priorMaxOutput < 800
        ? "lt800"
        : priorMaxOutput < 3_000
          ? "800-3k"
          : "gte3k";
  row.priorMaxFineBucket =
    priorCalls === 0
      ? null
      : priorMaxOutput < 200
        ? "lt200"
        : priorMaxOutput < 800
          ? "200-800"
          : priorMaxOutput < 3_000
            ? "800-3k"
            : priorMaxOutput < 8_000
              ? "3k-8k"
              : "gte8k";
  row.priorArtifactCountBucket =
    priorCalls === 0 ? null : priorArtifacts === 0 ? "0" : priorArtifacts === 1 ? "1" : "2+";
  const countBucket = (count) =>
    count === 0 ? "0" : count === 1 ? "1" : count < 5 ? "2-4" : count < 20 ? "5-19" : "20+";
  row.resolvedPathCount = resolvedPaths.size;
  row.resultResolvedPathCount = row.resultPathHashes?.length ?? 0;
  row.priorReadPathCount = readPaths.size;
  row.priorSearchPathCount = searchPaths.size;
  row.priorMutationPathCount = mutationPaths.size;
  row.readNotMutatedPathCount = [...readPaths].filter(
    (fingerprint) => !mutationPaths.has(fingerprint),
  ).length;
  row.priorReadCalls = priorReadCalls;
  row.priorSearchCalls = priorSearchCalls;
  row.priorMutationCalls = priorMutationCalls;
  row.priorFileToolCalls = priorFileToolCalls;
  row.vaguePromptResolvedFile = row.promptPath === "no" && resolvedPaths.size > 0;
  row.resolvedPathBucket = countBucket(row.resolvedPathCount);
  row.resultResolvedPathBucket = countBucket(row.resultResolvedPathCount);
  row.readNotMutatedBucket = countBucket(row.readNotMutatedPathCount);
  row.priorContextSemanticHash = [...priorContextSemantic.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([left], [right]) => left - right);
}

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable calls, ` +
    `${fmt(new Set(rows.map((row) => row.sessionId).filter(Boolean)).size)} sessions, ` +
    `${fmt(new Set(rows.map((row) => row.workloadId).filter(Boolean)).size)} workloads.`,
);

function fit(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    sorted,
    q: QUANTILES.map((probability) => Math.round(quantile(sorted, probability))),
  };
}

function fitGroups(trainRows, keyFn, labelFn = (row) => row.outputTokens) {
  const values = new Map();
  for (const row of trainRows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(labelFn(row));
  }
  return new Map(
    [...values.entries()]
      .filter(([, sample]) => sample.length >= MIN_GROUP)
      .map(([key, sample]) => [key, fit(sample)]),
  );
}

const key = {
  modelThinking: (row) => `m=${row.model}|t=${row.thinking}`,
  model: (row) => `m=${row.model}`,
  path: (row) => (row.promptPath === null ? null : `path=${row.promptPath}`),
  modelThinkingPath: (row) =>
    row.promptPath === null
      ? null
      : `m=${row.model}|t=${row.thinking}|path=${row.promptPath}`,
};

function shippedKeys() {
  return [key.modelThinkingPath, key.path, key.modelThinking, key.model];
}

function featureKeys(name, accessor) {
  const value = (row) => {
    const feature = accessor(row);
    return feature === null || feature === undefined ? null : `${name}=${feature}`;
  };
  return [
    (row) => {
      const feature = value(row);
      const base = key.modelThinkingPath(row);
      return feature === null || base === null ? null : `${base}|${feature}`;
    },
    (row) => {
      const feature = value(row);
      return feature === null ? null : `${key.modelThinking(row)}|${feature}`;
    },
    value,
    ...shippedKeys(),
  ];
}

function makeLadder(trainRows, keyFns) {
  const fits = keyFns.map((fn) => fitGroups(trainRows, fn));
  const overall = fit(trainRows.map((row) => row.outputTokens));
  return (row) => {
    for (let index = 0; index < keyFns.length; index++) {
      const groupKey = keyFns[index](row);
      if (groupKey === null) continue;
      const found = fits[index].get(groupKey);
      if (found) return found;
    }
    return overall;
  };
}

function totalLoss(row, q) {
  return QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, q[index], probability),
    0,
  );
}

function evaluateRecords(records, candidate) {
  const metrics = { n: records.length, loss: 0, coverage: [0, 0, 0], width: [0, 0] };
  for (const record of records) {
    const q = record.forecasts[candidate];
    metrics.loss += totalLoss(record.row, q);
    for (let index = 0; index < QUANTILES.length; index++) {
      metrics.coverage[index] += record.row.outputTokens <= q[index] ? 1 : 0;
    }
    metrics.width[0] += q[1] - q[0];
    metrics.width[1] += q[2] - q[0];
  }
  metrics.loss /= records.length;
  metrics.coverage = metrics.coverage.map((value) => value / records.length);
  metrics.width = metrics.width.map((value) => value / records.length);
  return metrics;
}

// -------------------------------------------------------------------------
// Stage A: sparse semantic classifier. Prompt terms are represented only by
// signed hashing. No vocabulary or prompt content exists after loadRequests.
// -------------------------------------------------------------------------

const SEMANTIC_WIDTH = 512;
const CONTEXT_SEMANTIC_START = SEMANTIC_WIDTH;
const CONTEXT_SEMANTIC_WIDTH = 512;
const META_START = CONTEXT_SEMANTIC_START + CONTEXT_SEMANTIC_WIDTH;
const META_WIDTH = 256;
const RESOLVED_START = META_START + META_WIDTH + 6;
const RESOLVED_WIDTH = 10;
const BIAS = RESOLVED_START + RESOLVED_WIDTH;
const FEATURE_WIDTH = BIAS + 1;
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
function encode(row, includeResolved = false, includeContextSemantic = false) {
  const values = new Map();
  const add = (index, value = 1) => values.set(index, (values.get(index) ?? 0) + value);
  for (const [index, value] of row.turnPrompt?.semanticHash ?? []) add(index, value);
  if (includeContextSemantic) {
    for (const [index, value] of row.priorContextSemanticHash ?? []) {
      add(CONTEXT_SEMANTIC_START + (index % CONTEXT_SEMANTIC_WIDTH), value);
    }
  }
  const categoricals = [
    `model=${row.model}`,
    `thinking=${row.thinking}`,
    row.promptPath === null ? "path=(unknown)" : `path=${row.promptPath}`,
    `workload=${row.workloadId ?? "(unknown)"}`,
    `position=${row.sessionPositionBucket}`,
    row.depthBucket === null ? "depth=(unknown)" : `depth=${row.depthBucket}`,
    row.turnPrompt ? `format=${row.turnPrompt.requestedFormat}` : "format=(unknown)",
    row.turnPrompt ? `deliverable=${row.turnPrompt.deliverableType}` : "deliverable=(unknown)",
    row.turnPrompt ? `artifactIntent=${row.turnPrompt.artifactIntent}` : "artifactIntent=(unknown)",
    row.priorWrite === null ? "priorWrite=(unknown)" : `priorWrite=${row.priorWrite}`,
    row.priorArtifact === null ? "priorArtifact=(unknown)" : `priorArtifact=${row.priorArtifact}`,
    row.priorMaxBucket === null ? "priorMax=(unknown)" : `priorMax=${row.priorMaxBucket}`,
  ];
  for (const value of categoricals) add(META_START + (fnv1a(value) % META_WIDTH));
  add(META_START + META_WIDTH, Math.log1p(row.turnPrompt?.chars ?? 0) / 8);
  add(META_START + META_WIDTH + 1, Math.log1p(row.sessionPosition) / 6);
  add(META_START + META_WIDTH + 2, Math.log1p(row.loopDepth ?? 0) / 5);
  add(META_START + META_WIDTH + 3, Math.log1p(row.priorCalls) / 5);
  add(META_START + META_WIDTH + 4, row.turnPrompt ? 1 : 0);
  add(META_START + META_WIDTH + 5, row.loopDepthExact ? 1 : 0);
  if (includeResolved) {
    add(RESOLVED_START, Math.log1p(row.resolvedPathCount) / 6);
    add(RESOLVED_START + 1, Math.log1p(row.resultResolvedPathCount) / 5);
    add(RESOLVED_START + 2, Math.log1p(row.priorReadPathCount) / 6);
    add(RESOLVED_START + 3, Math.log1p(row.priorSearchPathCount) / 5);
    add(RESOLVED_START + 4, Math.log1p(row.priorMutationPathCount) / 5);
    add(RESOLVED_START + 5, Math.log1p(row.readNotMutatedPathCount) / 6);
    add(RESOLVED_START + 6, Math.log1p(row.priorReadCalls) / 5);
    add(RESOLVED_START + 7, Math.log1p(row.priorSearchCalls) / 5);
    add(RESOLVED_START + 8, Math.log1p(row.priorFileToolCalls) / 5);
    add(RESOLVED_START + 9, row.vaguePromptResolvedFile ? 1 : 0);
  }
  add(BIAS, 1);
  return [...values.entries()].filter(([, value]) => value !== 0);
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

// FTRL-Proximal is deterministic, sparse, and naturally regularized. It is
// well suited to hashed text where a dense batch optimizer mostly learns noise.
function trainBinary(
  trainRows,
  labelFn,
  epochs = 12,
  includeResolved = false,
  includeContextSemantic = false,
) {
  const z = new Float64Array(FEATURE_WIDTH);
  const n = new Float64Array(FEATURE_WIDTH);
  const alpha = 0.08;
  const beta = 1;
  const l1 = 0.05;
  const l2 = 1;
  const weight = (index) => {
    if (Math.abs(z[index]) <= l1) return 0;
    return -(
      (z[index] - Math.sign(z[index]) * l1) /
      ((beta + Math.sqrt(n[index])) / alpha + l2)
    );
  };
  const encoded = trainRows.map((row) =>
    encode(row, includeResolved, includeContextSemantic),
  );
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let rowIndex = 0; rowIndex < trainRows.length; rowIndex++) {
      const x = encoded[rowIndex];
      let score = 0;
      for (const [index, value] of x) score += weight(index) * value;
      const gradientBase = sigmoid(score) - (labelFn(trainRows[rowIndex]) ? 1 : 0);
      for (const [index, value] of x) {
        const gradient = gradientBase * value;
        const oldWeight = weight(index);
        const sigma = (Math.sqrt(n[index] + gradient * gradient) - Math.sqrt(n[index])) / alpha;
        z[index] += gradient - sigma * oldWeight;
        n[index] += gradient * gradient;
      }
    }
  }
  const weights = Float64Array.from({ length: FEATURE_WIDTH }, (_, index) => weight(index));
  return (row) => {
    let score = 0;
    for (const [index, value] of encode(
      row,
      includeResolved,
      includeContextSemantic,
    )) {
      score += weights[index] * value;
    }
    return Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(score)));
  };
}

function cdf(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low / sorted.length;
}

function mixtureQuantile(candidates, low, high, highProbability, probability) {
  let left = 0;
  let right = candidates.length - 1;
  while (left < right) {
    const middle = (left + right) >> 1;
    const value = candidates[middle];
    const combined =
      (1 - highProbability) * cdf(low, value) + highProbability * cdf(high, value);
    if (combined >= probability) right = middle;
    else left = middle + 1;
  }
  return candidates[left];
}

function fitHurdle(trainRows, labelFn, probabilityFn) {
  const high = fit(trainRows.filter(labelFn).map((row) => row.outputTokens)).sorted;
  const lowOverall = fit(trainRows.filter((row) => !labelFn(row)).map((row) => row.outputTokens));
  const lowByBase = fitGroups(
    trainRows.filter((row) => !labelFn(row)),
    (row) => key.modelThinkingPath(row) ?? key.modelThinking(row),
  );
  const candidates = Float64Array.from(
    new Set(trainRows.map((row) => row.outputTokens)),
  ).sort();
  return (row) => {
    const low =
      lowByBase.get(key.modelThinkingPath(row) ?? key.modelThinking(row))?.sorted ??
      lowOverall.sorted;
    const highProbability = probabilityFn(row);
    return QUANTILES.map((probability) =>
      mixtureQuantile(candidates, low, high, highProbability, probability),
    );
  };
}

function classifierMetrics(records, probabilityName, labelFn) {
  let logLoss = 0;
  let brier = 0;
  const ranked = [];
  for (const record of records) {
    const probability = record.probabilities[probabilityName];
    const label = labelFn(record.row) ? 1 : 0;
    logLoss -= label * Math.log(probability) + (1 - label) * Math.log(1 - probability);
    brier += (probability - label) ** 2;
    ranked.push({ probability, label });
  }
  ranked.sort((left, right) => right.probability - left.probability);
  const positives = ranked.reduce((sum, row) => sum + row.label, 0);
  const negatives = ranked.length - positives;
  let truePositive = 0;
  let falsePositive = 0;
  let previousTruePositive = 0;
  let previousFalsePositive = 0;
  let auc = 0;
  for (const row of ranked) {
    if (row.label) truePositive++;
    else falsePositive++;
    auc +=
      ((falsePositive - previousFalsePositive) * (truePositive + previousTruePositive)) / 2;
    previousTruePositive = truePositive;
    previousFalsePositive = falsePositive;
  }
  auc = positives && negatives ? auc / (positives * negatives) : null;
  const top = ranked.slice(0, Math.max(1, Math.round(ranked.length * 0.1)));
  const prevalence = positives / ranked.length;
  const topRate = top.reduce((sum, row) => sum + row.label, 0) / top.length;
  return {
    n: ranked.length,
    prevalence,
    logLoss: logLoss / ranked.length,
    brier: brier / ranked.length,
    auc,
    topDecileRate: topRate,
    topDecileLift: prevalence === 0 ? null : topRate / prevalence,
  };
}

// -------------------------------------------------------------------------
// Gradient-boosted quantiles over the same legal features. This tests whether
// sparse lookup cells are the bottleneck without introducing a dependency on
// a training framework. Trees learn only corrections to the shipped forecast.
// -------------------------------------------------------------------------

const BOOST_META_WIDTH = 24;
const BOOST_SEMANTIC_WIDTH = 12;
function denseFeatures(row, options = {}) {
  const {
    includeSemantic = true,
    includeWorkload = true,
    includePriorOutcomes = true,
  } = options;
  const features = new Float64Array(12 + BOOST_META_WIDTH + BOOST_SEMANTIC_WIDTH);
  features[0] = row.thinking === "yes" ? 1 : 0;
  features[1] = row.promptPath === "yes" ? 1 : row.promptPath === "no" ? 0 : -1;
  features[2] = Math.log1p(row.turnPrompt?.chars ?? 0) / 8;
  features[3] = Math.log1p(row.turnPrompt?.requirements ?? 0) / 3;
  features[4] = row.turnPrompt?.hasLimit ? 1 : 0;
  features[5] = row.turnPrompt?.hasExpansive ? 1 : 0;
  features[6] = row.turnPrompt?.artifactIntent ? 1 : 0;
  features[7] = Math.log1p(row.sessionPosition) / 6;
  features[8] = Math.log1p(row.loopDepth ?? 0) / 5;
  features[9] = includePriorOutcomes ? Math.log1p(row.priorCalls) / 5 : 0;
  features[10] = includePriorOutcomes ? Math.log1p(row.priorMaxOutput ?? 0) / 10 : 0;
  features[11] = includePriorOutcomes ? Math.log1p(row.priorArtifactCount ?? 0) / 3 : 0;
  const categoricals = [
    `model=${row.model}`,
    `format=${row.turnPrompt?.requestedFormat ?? "(unknown)"}`,
    `deliverable=${row.turnPrompt?.deliverableType ?? "(unknown)"}`,
  ];
  if (includePriorOutcomes) {
    categoricals.push(
      `priorWrite=${row.priorWrite ?? "(unknown)"}`,
      `priorArtifact=${row.priorArtifact ?? "(unknown)"}`,
    );
  }
  if (includeWorkload) {
    categoricals.push(`workload=${row.workloadId ?? "(unknown)"}`);
  }
  for (const value of categoricals) {
    features[12 + (fnv1a(value) % BOOST_META_WIDTH)] = 1;
  }
  if (includeSemantic) {
    for (const [index, value] of row.turnPrompt?.semanticHash ?? []) {
      features[12 + BOOST_META_WIDTH + (index % BOOST_SEMANTIC_WIDTH)] += value;
    }
  }
  return features;
}

function treeValue(tree, features) {
  let node = tree;
  while (node.feature !== undefined) {
    node = features[node.feature] <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

function fitBoostTree(features, gradients, residuals, probability, thresholds) {
  const minimumLeaf = 150;
  const maxDepth = 2;
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

function trainBoostedQuantiles(trainRows, basePredict, featureFn = denseFeatures) {
  const features = trainRows.map(featureFn);
  const featureCount = features[0].length;
  const thresholds = Array.from({ length: featureCount }, (_, feature) => {
    const values = features.map((row) => row[feature]);
    return [...new Set([0.2, 0.4, 0.6, 0.8].map((p) => quantile(values, p)))];
  });
  const learningRate = 0.12;
  const iterations = 24;
  const ensembles = QUANTILES.map((probability, quantileIndex) => {
    const predictions = trainRows.map((row) => basePredict(row).q[quantileIndex]);
    const trees = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
      const gradients = trainRows.map((row, index) =>
        row.outputTokens < predictions[index] ? probability - 1 : probability,
      );
      const residuals = trainRows.map(
        (row, index) => row.outputTokens - predictions[index],
      );
      const tree = fitBoostTree(
        features,
        gradients,
        residuals,
        probability,
        thresholds,
      );
      trees.push(tree);
      for (let index = 0; index < trainRows.length; index++) {
        predictions[index] += learningRate * treeValue(tree, features[index]);
      }
    }
    return trees;
  });
  const predictor = (row) => {
    const features = featureFn(row);
    const base = basePredict(row).q;
    const prediction = ensembles.map((trees, index) =>
      Math.max(
        0,
        Math.round(
          base[index] +
            learningRate * trees.reduce((sum, tree) => sum + treeValue(tree, features), 0),
        ),
      ),
    );
    prediction[1] = Math.max(prediction[0], prediction[1]);
    prediction[2] = Math.max(prediction[1], prediction[2]);
    return prediction;
  };
  predictor.model = { learningRate, ensembles };
  return predictor;
}

// -------------------------------------------------------------------------
// Chronological evaluation.
// -------------------------------------------------------------------------

const groupCandidates = {
  baseline: shippedKeys(),
  workload: featureKeys("workload", (row) => row.workloadId),
  sessionPosition: featureKeys("position", (row) => row.sessionPositionBucket),
  loopDepth: featureKeys("depth", (row) => row.depthBucket),
  deliverable: featureKeys("deliverable", (row) => row.turnPrompt?.deliverableType ?? null),
  requestedFormat: featureKeys("format", (row) => row.turnPrompt?.requestedFormat ?? null),
  artifactIntent: featureKeys(
    "artifactIntent",
    (row) => (row.turnPrompt ? (row.turnPrompt.artifactIntent ? "yes" : "no") : null),
  ),
  priorWrite: featureKeys("priorWrite", (row) => row.priorWrite),
  priorArtifact: featureKeys("priorArtifact", (row) => row.priorArtifact),
  priorMax: featureKeys("priorMax", (row) => row.priorMaxBucket),
  priorMaxFine: featureKeys("priorMaxFine", (row) => row.priorMaxFineBucket),
  priorArtifactCount: featureKeys(
    "priorArtifactCount",
    (row) => row.priorArtifactCountBucket,
  ),
  resolvedPaths: featureKeys("resolvedPaths", (row) => row.resolvedPathBucket),
  resultResolvedPaths: featureKeys(
    "resultResolvedPaths",
    (row) => row.resultResolvedPathBucket,
  ),
  readNotMutatedPaths: featureKeys(
    "readNotMutatedPaths",
    (row) => row.readNotMutatedBucket,
  ),
  vaguePromptResolvedFile: featureKeys(
    "vagueResolved",
    (row) => (row.vaguePromptResolvedFile ? "yes" : "no"),
  ),
  priorMaxArtifactIntent: featureKeys("priorMaxArtifactIntent", (row) => {
    if (row.priorMaxFineBucket === null || !row.turnPrompt) return null;
    return `${row.priorMaxFineBucket}|intent=${row.turnPrompt.artifactIntent ? "yes" : "no"}`;
  }),
  oracleAction: featureKeys("action", (row) => row.action),
  oracleWriteGroup: featureKeys("write", (row) => (row.isWrite ? "yes" : "no")),
  oracleLongArtifactGroup: featureKeys(
    "longArtifact",
    (row) => (row.isLongArtifact ? "yes" : "no"),
  ),
  oracleLongOutputGroup: featureKeys(
    "longOutput",
    (row) => (row.isLongOutput ? "yes" : "no"),
  ),
};

const ONLINE_HISTORY = [5, 10, 20, 50];
const CONFORMAL_WINDOWS = [64, 128, 256, 512];
const candidateNames = [
  ...Object.keys(groupCandidates),
  ...ONLINE_HISTORY.flatMap((minimum) => [
    `promptHistory${minimum}`,
    `sessionHistory${minimum}`,
    `hierarchicalHistory${minimum}`,
  ]),
  ...CONFORMAL_WINDOWS.flatMap((window) => [
    `conformal${window}`,
    `workloadConformal${window}`,
  ]),
  "priorMaxConformal512",
  "priorMaxWorkloadConformal512",
  "semanticWriteHurdle",
  "semanticLongArtifactHurdle",
  "resolvedWriteHurdle",
  "resolvedLongArtifactHurdle",
  "contextWriteHurdle",
  "contextLongArtifactHurdle",
  "boostedQuantile",
  "boostedStructured",
  "boostedPortable",
  "boostedPortableNoPrior",
  "boostedResolvedContext",
  "boostedPriorMax",
  "boostedConformal512",
  "boostedWorkloadConformal512",
  "boostedPriorMaxConformal512",
  "boostedPriorMaxWorkloadConformal512",
  "oracleWriteHurdle",
  "oracleLongArtifactHurdle",
];

const seed = Math.floor(rows.length * TRAIN_FRACTION);
const blockSize = Math.floor((rows.length - seed) / CV_FOLDS);
const folds = Array.from({ length: CV_FOLDS }, (_, index) => {
  const start = seed + index * blockSize;
  const end = index === CV_FOLDS - 1 ? rows.length : start + blockSize;
  return { train: rows.slice(0, start), test: rows.slice(start, end) };
});

const scored = [];
for (const [foldIndex, fold] of folds.entries()) {
  console.log(`Fitting fold ${foldIndex + 1}/${CV_FOLDS}: ${fmt(fold.train.length)} train, ${fmt(fold.test.length)} test`);
  const ladders = new Map(
    Object.entries(groupCandidates).map(([name, keys]) => [name, makeLadder(fold.train, keys)]),
  );
  const boostedQuantile = trainBoostedQuantiles(fold.train, ladders.get("baseline"));
  const structuredFeatures = (row) =>
    denseFeatures(row, { includeSemantic: false }).slice(0, 12 + BOOST_META_WIDTH);
  const portableFeatures = (row) =>
    denseFeatures(row, { includeSemantic: false, includeWorkload: false }).slice(
      0,
      12 + BOOST_META_WIDTH,
    );
  const portableNoPriorFeatures = (row) =>
    denseFeatures(row, {
      includeSemantic: false,
      includeWorkload: false,
      includePriorOutcomes: false,
    }).slice(0, 12 + BOOST_META_WIDTH);
  const resolvedContextFeatures = (row) => {
    const portable = portableFeatures(row);
    const features = new Float64Array(portable.length + 10);
    features.set(portable);
    const start = portable.length;
    features[start] = Math.log1p(row.resolvedPathCount) / 6;
    features[start + 1] = Math.log1p(row.resultResolvedPathCount) / 5;
    features[start + 2] = Math.log1p(row.priorReadPathCount) / 6;
    features[start + 3] = Math.log1p(row.priorSearchPathCount) / 5;
    features[start + 4] = Math.log1p(row.priorMutationPathCount) / 5;
    features[start + 5] = Math.log1p(row.readNotMutatedPathCount) / 6;
    features[start + 6] = Math.log1p(row.priorReadCalls) / 5;
    features[start + 7] = Math.log1p(row.priorSearchCalls) / 5;
    features[start + 8] = Math.log1p(row.priorFileToolCalls) / 5;
    features[start + 9] = row.vaguePromptResolvedFile ? 1 : 0;
    return features;
  };
  const boostedStructured = trainBoostedQuantiles(
    fold.train,
    ladders.get("baseline"),
    structuredFeatures,
  );
  const boostedPortable = trainBoostedQuantiles(
    fold.train,
    ladders.get("baseline"),
    portableFeatures,
  );
  const boostedPortableNoPrior = trainBoostedQuantiles(
    fold.train,
    ladders.get("baseline"),
    portableNoPriorFeatures,
  );
  const boostedResolvedContext = trainBoostedQuantiles(
    fold.train,
    ladders.get("baseline"),
    resolvedContextFeatures,
  );
  const boostedPriorMax = trainBoostedQuantiles(fold.train, ladders.get("priorMax"));
  const predictWrite = trainBinary(fold.train, (row) => row.isWrite);
  const predictLongArtifact = trainBinary(fold.train, (row) => row.isLongArtifact);
  const predictResolvedWrite = trainBinary(
    fold.train,
    (row) => row.isWrite,
    12,
    true,
  );
  const predictResolvedLongArtifact = trainBinary(
    fold.train,
    (row) => row.isLongArtifact,
    12,
    true,
  );
  const predictContextWrite = trainBinary(
    fold.train,
    (row) => row.isWrite,
    12,
    true,
    true,
  );
  const predictContextLongArtifact = trainBinary(
    fold.train,
    (row) => row.isLongArtifact,
    12,
    true,
    true,
  );
  const semanticWriteHurdle = fitHurdle(fold.train, (row) => row.isWrite, predictWrite);
  const semanticLongArtifactHurdle = fitHurdle(
    fold.train,
    (row) => row.isLongArtifact,
    predictLongArtifact,
  );
  const resolvedWriteHurdle = fitHurdle(
    fold.train,
    (row) => row.isWrite,
    predictResolvedWrite,
  );
  const resolvedLongArtifactHurdle = fitHurdle(
    fold.train,
    (row) => row.isLongArtifact,
    predictResolvedLongArtifact,
  );
  const contextWriteHurdle = fitHurdle(
    fold.train,
    (row) => row.isWrite,
    predictContextWrite,
  );
  const contextLongArtifactHurdle = fitHurdle(
    fold.train,
    (row) => row.isLongArtifact,
    predictContextLongArtifact,
  );
  const oracleWriteHurdle = fitHurdle(
    fold.train,
    (row) => row.isWrite,
    (row) => (row.isWrite ? 1 : 0),
  );
  const writePositiveHurdle = fitHurdle(
    fold.train,
    (row) => row.isWrite,
    () => 1,
  );
  const writeNegativeHurdle = fitHurdle(
    fold.train,
    (row) => row.isWrite,
    () => 0,
  );
  const oracleLongArtifactHurdle = fitHurdle(
    fold.train,
    (row) => row.isLongArtifact,
    (row) => (row.isLongArtifact ? 1 : 0),
  );

  const histories = {
    prompt: new Map(),
    session: new Map(),
    workload: new Map(),
  };
  const addHistory = (map, historyKey, value) => {
    if (!historyKey) return;
    if (!map.has(historyKey)) map.set(historyKey, []);
    map.get(historyKey).push(value);
  };
  for (const row of fold.train) {
    addHistory(histories.prompt, row.turnPrompt?.promptHash, row.outputTokens);
    addHistory(histories.session, row.sessionId, row.outputTokens);
    addHistory(histories.workload, row.workloadId, row.outputTokens);
  }

  const residualGlobal = [];
  const residualByWorkload = new Map();
  const priorMaxResidualGlobal = [];
  const priorMaxResidualByWorkload = new Map();
  const boostedResidualGlobal = [];
  const boostedResidualByWorkload = new Map();
  const boostedPriorMaxResidualGlobal = [];
  const boostedPriorMaxResidualByWorkload = new Map();
  for (const row of fold.test) {
    const record = { row, foldIndex, forecasts: {}, probabilities: {} };
    for (const [name, ladder] of ladders) record.forecasts[name] = ladder(row).q;
    const baseline = record.forecasts.baseline;
    record.forecasts.boostedQuantile = boostedQuantile(row);
    record.forecasts.boostedStructured = boostedStructured(row);
    record.forecasts.boostedPortable = boostedPortable(row);
    record.forecasts.boostedPortableNoPrior = boostedPortableNoPrior(row);
    record.forecasts.boostedResolvedContext = boostedResolvedContext(row);
    record.forecasts.boostedPriorMax = boostedPriorMax(row);

    for (const minimum of ONLINE_HISTORY) {
      const promptHistory = histories.prompt.get(row.turnPrompt?.promptHash) ?? [];
      const sessionHistory = histories.session.get(row.sessionId) ?? [];
      const workloadHistory = histories.workload.get(row.workloadId) ?? [];
      record.forecasts[`promptHistory${minimum}`] =
        promptHistory.length >= minimum ? fit(promptHistory).q : baseline;
      record.forecasts[`sessionHistory${minimum}`] =
        sessionHistory.length >= minimum ? fit(sessionHistory).q : baseline;
      record.forecasts[`hierarchicalHistory${minimum}`] =
        promptHistory.length >= minimum
          ? fit(promptHistory).q
          : sessionHistory.length >= minimum
            ? fit(sessionHistory).q
            : workloadHistory.length >= Math.max(MIN_GROUP, minimum)
              ? fit(workloadHistory).q
              : baseline;
    }

    const workloadResidual = residualByWorkload.get(row.workloadId) ?? [];
    for (const window of CONFORMAL_WINDOWS) {
      const conformal = (history, sourceForecast = baseline) => {
        if (history.length < 32) return sourceForecast;
        const recent = history.slice(-window);
        const corrected = QUANTILES.map((probability, index) => {
          const minimum = index === 2 ? 100 : 32;
          if (recent.length < minimum) return sourceForecast[index];
          const correction = quantile(
            recent.map((residual) => residual[index]),
            probability,
          );
          return Math.max(0, Math.round(sourceForecast[index] + correction));
        });
        corrected[1] = Math.max(corrected[0], corrected[1]);
        corrected[2] = Math.max(corrected[1], corrected[2]);
        return corrected;
      };
      record.forecasts[`conformal${window}`] = conformal(residualGlobal);
      record.forecasts[`workloadConformal${window}`] = conformal(
        workloadResidual.length >= 32 ? workloadResidual : residualGlobal,
      );
      if (window === 512) {
        const priorMaxForecast = record.forecasts.priorMax;
        const priorWorkloadResidual = priorMaxResidualByWorkload.get(row.workloadId) ?? [];
        record.forecasts.priorMaxConformal512 = conformal(
          priorMaxResidualGlobal,
          priorMaxForecast,
        );
        record.forecasts.priorMaxWorkloadConformal512 = conformal(
          priorWorkloadResidual.length >= 32
            ? priorWorkloadResidual
            : priorMaxResidualGlobal,
          priorMaxForecast,
        );
        const boostedForecast = record.forecasts.boostedQuantile;
        const boostedWorkloadResidual = boostedResidualByWorkload.get(row.workloadId) ?? [];
        record.forecasts.boostedConformal512 = conformal(
          boostedResidualGlobal,
          boostedForecast,
        );
        record.forecasts.boostedWorkloadConformal512 = conformal(
          boostedWorkloadResidual.length >= 32
            ? boostedWorkloadResidual
            : boostedResidualGlobal,
          boostedForecast,
        );
        const boostedPriorMaxForecast = record.forecasts.boostedPriorMax;
        const boostedPriorMaxWorkloadResidual =
          boostedPriorMaxResidualByWorkload.get(row.workloadId) ?? [];
        record.forecasts.boostedPriorMaxConformal512 = conformal(
          boostedPriorMaxResidualGlobal,
          boostedPriorMaxForecast,
        );
        record.forecasts.boostedPriorMaxWorkloadConformal512 = conformal(
          boostedPriorMaxWorkloadResidual.length >= 32
            ? boostedPriorMaxWorkloadResidual
            : boostedPriorMaxResidualGlobal,
          boostedPriorMaxForecast,
        );
      }
    }

    const writeProbability = predictWrite(row);
    const longArtifactProbability = predictLongArtifact(row);
    const resolvedWriteProbability = predictResolvedWrite(row);
    const resolvedLongArtifactProbability = predictResolvedLongArtifact(row);
    const contextWriteProbability = predictContextWrite(row);
    const contextLongArtifactProbability = predictContextLongArtifact(row);
    record.probabilities.semanticWrite = writeProbability;
    record.probabilities.semanticLongArtifact = longArtifactProbability;
    record.probabilities.resolvedWrite = resolvedWriteProbability;
    record.probabilities.resolvedLongArtifact = resolvedLongArtifactProbability;
    record.probabilities.contextWrite = contextWriteProbability;
    record.probabilities.contextLongArtifact = contextLongArtifactProbability;
    record.forecasts.semanticWriteHurdle = semanticWriteHurdle(row);
    record.forecasts.semanticLongArtifactHurdle = semanticLongArtifactHurdle(row);
    record.forecasts.resolvedWriteHurdle = resolvedWriteHurdle(row);
    record.forecasts.resolvedLongArtifactHurdle = resolvedLongArtifactHurdle(row);
    record.forecasts.contextWriteHurdle = contextWriteHurdle(row);
    record.forecasts.contextLongArtifactHurdle = contextLongArtifactHurdle(row);
    record.forecasts.oracleWriteHurdle = oracleWriteHurdle(row);
    // Internal counterfactual endpoints for detector-quality simulations.
    record.writePositiveForecast = writePositiveHurdle(row);
    record.writeNegativeForecast = writeNegativeHurdle(row);
    record.forecasts.oracleLongArtifactHurdle = oracleLongArtifactHurdle(row);
    scored.push(record);

    const residual = QUANTILES.map((_, index) => row.outputTokens - baseline[index]);
    residualGlobal.push(residual);
    if (!residualByWorkload.has(row.workloadId)) residualByWorkload.set(row.workloadId, []);
    residualByWorkload.get(row.workloadId).push(residual);
    const priorMaxForecast = record.forecasts.priorMax;
    const priorMaxResidual = QUANTILES.map(
      (_, index) => row.outputTokens - priorMaxForecast[index],
    );
    priorMaxResidualGlobal.push(priorMaxResidual);
    if (!priorMaxResidualByWorkload.has(row.workloadId)) {
      priorMaxResidualByWorkload.set(row.workloadId, []);
    }
    priorMaxResidualByWorkload.get(row.workloadId).push(priorMaxResidual);
    const boostedForecast = record.forecasts.boostedQuantile;
    const boostedResidual = QUANTILES.map(
      (_, index) => row.outputTokens - boostedForecast[index],
    );
    boostedResidualGlobal.push(boostedResidual);
    if (!boostedResidualByWorkload.has(row.workloadId)) {
      boostedResidualByWorkload.set(row.workloadId, []);
    }
    boostedResidualByWorkload.get(row.workloadId).push(boostedResidual);
    const boostedPriorMaxForecast = record.forecasts.boostedPriorMax;
    const boostedPriorMaxResidual = QUANTILES.map(
      (_, index) => row.outputTokens - boostedPriorMaxForecast[index],
    );
    boostedPriorMaxResidualGlobal.push(boostedPriorMaxResidual);
    if (!boostedPriorMaxResidualByWorkload.has(row.workloadId)) {
      boostedPriorMaxResidualByWorkload.set(row.workloadId, []);
    }
    boostedPriorMaxResidualByWorkload.get(row.workloadId).push(boostedPriorMaxResidual);
    addHistory(histories.prompt, row.turnPrompt?.promptHash, row.outputTokens);
    addHistory(histories.session, row.sessionId, row.outputTokens);
    addHistory(histories.workload, row.workloadId, row.outputTokens);
  }
}

const sessionIds = scored.map((record) => record.row.sessionId ?? null);
const baselineLosses = scored.map((record) => totalLoss(record.row, record.forecasts.baseline));
const results = {};
for (const name of candidateNames) {
  const metrics = evaluateRecords(scored, name);
  const differences = scored.map(
    (record, index) => totalLoss(record.row, record.forecasts[name]) - baselineLosses[index],
  );
  const comparison =
    name === "baseline" ? null : blockBootstrapDifference(differences, sessionIds);
  results[name] = {
    ...metrics,
    vsBaseline: comparison,
    relativeLossReduction:
      name === "baseline" ? 0 : (results.baseline?.loss ?? evaluateRecords(scored, "baseline").loss) > 0
        ? -comparison.meanDifference / evaluateRecords(scored, "baseline").loss
        : 0,
  };
}

const baselineMetrics = results.baseline;
for (const [name, result] of Object.entries(results)) {
  if (name === "baseline") continue;
  result.relativeLossReduction = -result.vsBaseline.meanDifference / baselineMetrics.loss;
  result.adopts = result.vsBaseline.ciUpper < 0;
  result.breakthrough = result.adopts && result.relativeLossReduction >= 0.05;
}

function compareCandidates(candidate, comparator) {
  return blockBootstrapDifference(
    scored.map(
      (record) =>
        totalLoss(record.row, record.forecasts[candidate]) -
        totalLoss(record.row, record.forecasts[comparator]),
    ),
    sessionIds,
  );
}
const incrementalComparisons = {
  resolvedContextVsPortable: compareCandidates(
    "boostedResolvedContext",
    "boostedPortable",
  ),
  resolvedWriteHurdleVsSemantic: compareCandidates(
    "resolvedWriteHurdle",
    "semanticWriteHurdle",
  ),
  resolvedLongArtifactHurdleVsSemantic: compareCandidates(
    "resolvedLongArtifactHurdle",
    "semanticLongArtifactHurdle",
  ),
  contextWriteHurdleVsSemantic: compareCandidates(
    "contextWriteHurdle",
    "semanticWriteHurdle",
  ),
  contextLongArtifactHurdleVsSemantic: compareCandidates(
    "contextLongArtifactHurdle",
    "semanticLongArtifactHurdle",
  ),
};

function segmentTable(accessor, minimum = 100) {
  const groups = new Map();
  for (const record of scored) {
    const value = accessor(record.row);
    const label = value === null || value === undefined ? "(unknown)" : String(value);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(record);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .filter(([, records]) => records.length >= minimum)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([label, records]) => [
        label,
        {
          n: records.length,
          baseline: evaluateRecords(records, "baseline"),
          artifactRate: mean(records.map((record) => (record.row.isLongArtifact ? 1 : 0))),
          writeRate: mean(records.map((record) => (record.row.isWrite ? 1 : 0))),
        },
      ]),
  );
}

const byLevel = LEVELS.map((level, index) => {
  let total = 0;
  let over = 0;
  let under = 0;
  for (const record of scored) {
    const forecast = record.forecasts.baseline[index];
    const loss = pinball(record.row.outputTokens, forecast, QUANTILES[index]);
    total += loss;
    if (record.row.outputTokens <= forecast) over += loss;
    else under += loss;
  }
  return {
    level,
    meanLoss: total / scored.length,
    shareOfLoss: total / baselineLosses.reduce((sum, value) => sum + value, 0),
    overForecastLossShare: total ? over / total : 0,
    underForecastLossShare: total ? under / total : 0,
  };
});

const sortedMisses = [...scored]
  .map((record) => ({
    record,
    loss: totalLoss(record.row, record.forecasts.baseline),
  }))
  .sort((left, right) => right.loss - left.loss);
const totalBaselineLoss = sortedMisses.reduce((sum, entry) => sum + entry.loss, 0);
const concentration = Object.fromEntries(
  [0.01, 0.05, 0.1].map((fraction) => {
    const count = Math.max(1, Math.round(sortedMisses.length * fraction));
    const share =
      sortedMisses.slice(0, count).reduce((sum, entry) => sum + entry.loss, 0) /
      totalBaselineLoss;
    return [fraction, share];
  }),
);
const worstMisses = sortedMisses.slice(0, 30).map(({ record, loss }, index) => ({
  rank: index + 1,
  auditId: createHash("sha256").update(record.row.requestId).digest("hex").slice(0, 12),
  model: record.row.model,
  thinking: record.row.thinking,
  promptPath: record.row.promptPath,
  workloadId: record.row.workloadId,
  sessionPositionBucket: record.row.sessionPositionBucket,
  loopDepth: record.row.loopDepthExact ? record.row.loopDepth : null,
  deliverableType: record.row.turnPrompt?.deliverableType ?? null,
  requestedFormat: record.row.turnPrompt?.requestedFormat ?? null,
  artifactIntent: record.row.turnPrompt?.artifactIntent ?? null,
  priorWrite: record.row.priorWrite,
  action: record.row.action,
  isLongArtifact: record.row.isLongArtifact,
  actual: record.row.outputTokens,
  forecast: record.forecasts.baseline,
  loss,
}));

const semanticClassifiers = {
  write: classifierMetrics(scored, "semanticWrite", (row) => row.isWrite),
  longArtifact: classifierMetrics(
    scored,
    "semanticLongArtifact",
    (row) => row.isLongArtifact,
  ),
  resolvedWrite: classifierMetrics(scored, "resolvedWrite", (row) => row.isWrite),
  resolvedLongArtifact: classifierMetrics(
    scored,
    "resolvedLongArtifact",
    (row) => row.isLongArtifact,
  ),
  contextWrite: classifierMetrics(scored, "contextWrite", (row) => row.isWrite),
  contextLongArtifact: classifierMetrics(
    scored,
    "contextLongArtifact",
    (row) => row.isLongArtifact,
  ),
};

function hindsightCeiling(accessor, minimum = MIN_GROUP) {
  const grouped = new Map();
  for (const record of scored) {
    const value = accessor(record.row);
    if (value === null || value === undefined) continue;
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(
      QUANTILES.map(
        (_, index) => record.row.outputTokens - record.forecasts.baseline[index],
      ),
    );
  }
  const fits = new Map(
    [...grouped.entries()]
      .filter(([, residuals]) => residuals.length >= minimum)
      .map(([value, residuals]) => [
        value,
        QUANTILES.map((probability, index) =>
          quantile(
            residuals.map((row) => row[index]),
            probability,
          ),
        ),
      ]),
  );
  const losses = [];
  const forecasts = [];
  for (const record of scored) {
    const value = accessor(record.row);
    const correction = fits.get(value);
    const forecast = correction
      ? QUANTILES.map((_, index) =>
          Math.max(0, Math.round(record.forecasts.baseline[index] + correction[index])),
        )
      : [...record.forecasts.baseline];
    forecast[1] = Math.max(forecast[0], forecast[1]);
    forecast[2] = Math.max(forecast[1], forecast[2]);
    forecasts.push(forecast);
    losses.push(totalLoss(record.row, forecast));
  }
  const differences = losses.map((loss, index) => loss - baselineLosses[index]);
  const comparison = blockBootstrapDifference(differences, sessionIds);
  let coverage = [0, 0, 0];
  let widths = [0, 0];
  for (let rowIndex = 0; rowIndex < scored.length; rowIndex++) {
    for (let level = 0; level < QUANTILES.length; level++) {
      coverage[level] +=
        scored[rowIndex].row.outputTokens <= forecasts[rowIndex][level] ? 1 : 0;
    }
    widths[0] += forecasts[rowIndex][1] - forecasts[rowIndex][0];
    widths[1] += forecasts[rowIndex][2] - forecasts[rowIndex][0];
  }
  return {
    minimum,
    groupsFitted: fits.size,
    meanLoss: mean(losses),
    vsBaseline: comparison,
    relativeCeiling: -comparison.meanDifference / baselineMetrics.loss,
    coverage: coverage.map((value) => value / scored.length),
    width: widths.map((value) => value / scored.length),
    note: "optimistic hindsight fit on the held-out outcomes; ceiling only",
  };
}

const oracleCeilings = {
  globalCalibration: hindsightCeiling(() => "single-user"),
  workload: hindsightCeiling((row) => row.workloadId),
  sessionPosition: hindsightCeiling((row) => row.sessionPositionBucket),
  loopDepth: hindsightCeiling((row) => row.depthBucket),
  deliverable: hindsightCeiling((row) => row.turnPrompt?.deliverableType ?? null),
  requestedFormat: hindsightCeiling((row) => row.turnPrompt?.requestedFormat ?? null),
  artifactIntent: hindsightCeiling((row) => row.turnPrompt?.artifactIntent ?? null),
  resolvedPaths: hindsightCeiling((row) => row.resolvedPathBucket),
  resultResolvedPaths: hindsightCeiling((row) => row.resultResolvedPathBucket),
  readNotMutatedPaths: hindsightCeiling((row) => row.readNotMutatedBucket),
  vaguePromptResolvedFile: hindsightCeiling((row) =>
    row.vaguePromptResolvedFile ? "yes" : "no",
  ),
  priorMax: hindsightCeiling((row) => row.priorMaxFineBucket),
  workloadAndPriorMax: hindsightCeiling((row) =>
    row.workloadId && row.priorMaxFineBucket
      ? `${row.workloadId}|${row.priorMaxFineBucket}`
      : null,
  ),
  sessionIdentity: hindsightCeiling((row) => row.sessionId, 20),
  promptIdentity: hindsightCeiling((row) => row.turnPrompt?.promptHash ?? null, 20),
  trueAction: results.oracleAction,
  trueWrite: results.oracleWriteHurdle,
  trueLongArtifact: results.oracleLongArtifactHurdle,
  trueLongOutput: results.oracleLongOutputGroup,
};

// How accurate would caller-provided expected-action telemetry need to be?
// Selection is deterministic from request-id hashes so this table reproduces.
const detectorQuality = [];
for (const recall of [0.5, 0.7, 0.9]) {
  for (const falsePositiveRate of [0.01, 0.03, 0.05]) {
    const losses = scored.map((record) => {
      const hash = createHash("sha256")
        .update(`detector-sim\0${record.row.requestId}`)
        .digest();
      const draw = hash.readUInt32BE(0) / 2 ** 32;
      const positive = record.row.isWrite
        ? draw < recall
        : draw < falsePositiveRate;
      return totalLoss(
        record.row,
        positive ? record.writePositiveForecast : record.writeNegativeForecast,
      );
    });
    const comparison = blockBootstrapDifference(
      losses.map((loss, index) => loss - baselineLosses[index]),
      sessionIds,
    );
    detectorQuality.push({
      recall,
      falsePositiveRate,
      meanLoss: mean(losses),
      relativeReduction: -comparison.meanDifference / baselineMetrics.loss,
      vsBaseline: comparison,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  source: projectsDir,
  methodology: {
    split: `${CV_FOLDS}-fold rolling origin after ${TRAIN_FRACTION} seed`,
    minGroup: MIN_GROUP,
    comparison: "paired session-block bootstrap; candidate minus baseline",
    breakthrough: "CI upper < 0 and at least 5% loss reduction",
    preCallOnly: true,
  },
  dataset: {
    filesScanned,
    calls: rows.length,
    holdoutCalls: scored.length,
    sessions: new Set(rows.map((row) => row.sessionId).filter(Boolean)).size,
    workloads: new Set(rows.map((row) => row.workloadId).filter(Boolean)).size,
    users: 1,
    promptCoverage: rows.filter((row) => row.turnPrompt).length / rows.length,
    writeRate: mean(rows.map((row) => (row.isWrite ? 1 : 0))),
    longArtifactRate: mean(rows.map((row) => (row.isLongArtifact ? 1 : 0))),
  },
  results,
  incrementalComparisons,
  oracleCeilings,
  detectorQuality,
  semanticClassifiers,
  decomposition: {
    byLevel,
    concentration,
    byModelThinking: segmentTable((row) => `${row.model}|thinking=${row.thinking}`),
    byPromptPath: segmentTable((row) => row.promptPath),
    byWorkload: segmentTable((row) => row.workloadId),
    bySessionPosition: segmentTable((row) => row.sessionPositionBucket),
    byDeliverable: segmentTable((row) => row.turnPrompt?.deliverableType ?? null),
    byArtifactIntent: segmentTable((row) => row.turnPrompt?.artifactIntent ?? null),
  },
  worstMisses,
};

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

console.log("\nCandidate results (rolling origin; negative difference wins):\n");
console.log(
  `  ${"candidate".padEnd(34)}${"loss".padStart(9)}${"diff".padStart(10)}` +
    `${"95% CI".padStart(24)}${"p50/p90/p99".padStart(20)}${"p99-p50".padStart(11)}  decision`,
);
for (const [name, result] of Object.entries(results).sort(
  (left, right) => left[1].loss - right[1].loss,
)) {
  const comparison = result.vsBaseline;
  const decision =
    name === "baseline"
      ? "baseline"
      : result.breakthrough
        ? "BREAKTHROUGH"
        : result.adopts
          ? "adopts (<5%)"
          : comparison.ciLower > 0
            ? "worse"
            : "reject/noise";
  console.log(
    `  ${name.padEnd(34)}${result.loss.toFixed(1).padStart(9)}` +
      `${(comparison ? comparison.meanDifference.toFixed(1) : "-").padStart(10)}` +
      `${(comparison ? `[${comparison.ciLower.toFixed(1)}, ${comparison.ciUpper.toFixed(1)}]` : "-").padStart(24)}` +
      `${result.coverage.map((value) => (value * 100).toFixed(1)).join("/").padStart(20)}` +
      `${Math.round(result.width[1]).toLocaleString("en-US").padStart(11)}  ${decision}`,
  );
}

console.log(
  `\nSemantic Stage A: Write AUC ${semanticClassifiers.write.auc?.toFixed(3)}, ` +
    `top-decile lift ${semanticClassifiers.write.topDecileLift?.toFixed(2)}x; ` +
    `long-artifact AUC ${semanticClassifiers.longArtifact.auc?.toFixed(3)}, ` +
    `lift ${semanticClassifiers.longArtifact.topDecileLift?.toFixed(2)}x.`,
);
console.log(
  `Worst 1% carry ${pct(concentration[0.01])}; ${fmt(worstMisses.filter((row) => row.action === "Write").length)}` +
    ` of the top ${worstMisses.length} misses are Write.`,
);
console.log(`Wrote ${jsonOut}`);

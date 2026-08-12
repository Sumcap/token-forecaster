#!/usr/bin/env node
/**
 * Probe for BACKLOG fix direction (2): train turn-root rows as their own
 * regime. At a turn root every agent-loop feature is zero, so the shipped
 * correction routes all drafts into the same leaves and prompt wording moves
 * nothing. A correction trained only on turn-root rows removes that variance
 * competition: prompt features are the only live columns.
 *
 * Grades three forecasters on a chronological turn-root holdout:
 *   baseline   -- the group ladder alone
 *   shipped    -- ladder + general v2 correction (all rows)
 *   turnRoot   -- ladder + correction trained on turn-root rows only
 * Then simulates a user typing the demo prompt phrase by phrase and prints
 * the forecast trajectory for each forecaster.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  derivePromptFeatures,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { trainPortableQuantileBoost } from "./lib/quantile-boost.mjs";
import { blockBootstrapDifference, pinball, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/turn-root-regime.json"),
);
const MIN_LEAF = Number(argValue("--min-leaf", "40"));
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;

const { rows: loaded } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
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
const sessions = new Map();
for (const row of rows) {
  const session = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(session)) sessions.set(session, []);
  sessions.get(session).push(row);
}
for (const session of sessions.values()) {
  session.sort((left, right) => left.timestampMs - right.timestampMs);
  for (let index = 0; index < session.length; index++) session[index].sessionPosition = index;
}
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
  row.promptImage =
    row.turnHasImage === null ? null : row.turnHasImage ? "yes" : "no";
  let parent = row.parentRequestId === null ? null : byId.get(row.parentRequestId) ?? null;
  let priorCalls = 0;
  let priorMaxOutput = 0;
  let priorArtifacts = 0;
  let priorWrites = 0;
  const seen = new Set();
  while (parent && priorCalls < 200 && !seen.has(parent.requestId)) {
    seen.add(parent.requestId);
    priorCalls++;
    const action = parent.tools[0] ?? "(no-tool)";
    const artifact = action === "Write" || (action === "Edit" && parent.toolChars >= 4_000);
    if (action === "Write") priorWrites++;
    if (artifact) priorArtifacts++;
    priorMaxOutput = Math.max(priorMaxOutput, parent.outputTokens);
    parent =
      parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
}

const isTurnRoot = (row) =>
  row.priorCalls === 0 && (row.loopDepth ?? 0) === 0 && row.turnPrompt !== null;

function fit(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    q: QUANTILES.map((probability) => Math.round(quantile(sorted, probability))),
  };
}
function fitGroups(trainRows, keyFn) {
  const grouped = new Map();
  for (const row of trainRows) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.outputTokens);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length >= MIN_GROUP)
      .map(([key, values]) => [key, fit(values)]),
  );
}
const key = {
  mtp: (row) =>
    row.promptPath === null
      ? null
      : `model=${row.model}|thinking=${row.thinking}|promptPath=${row.promptPath}`,
  path: (row) => (row.promptPath === null ? null : `promptPath=${row.promptPath}`),
  mt: (row) => `model=${row.model}|thinking=${row.thinking}`,
  model: (row) => `model=${row.model}`,
};
function makeBase(trainRows) {
  const keys = [key.mtp, key.path, key.mt, key.model];
  const fits = keys.map((keyFn) => fitGroups(trainRows, keyFn));
  const overall = fit(trainRows.map((row) => row.outputTokens));
  return (row) => {
    for (let index = 0; index < keys.length; index++) {
      const group = keys[index](row);
      if (group === null) continue;
      const found = fits[index].get(group);
      if (found) return found;
    }
    return overall;
  };
}
const loss = (row, forecast) =>
  QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, forecast[index], probability),
    0,
  );
function metrics(records, field) {
  const result = { n: records.length, loss: 0, coverage: [0, 0, 0] };
  for (const record of records) {
    const forecast = record[field];
    result.loss += loss(record.row, forecast);
    for (let index = 0; index < QUANTILES.length; index++) {
      result.coverage[index] += record.row.outputTokens <= forecast[index] ? 1 : 0;
    }
  }
  result.loss /= records.length;
  result.coverage = result.coverage.map((value) => value / records.length);
  return result;
}
const comparePair = (records, treatment, control) =>
  blockBootstrapDifference(
    records.map(
      (record) => loss(record.row, record[treatment]) - loss(record.row, record[control]),
    ),
    records.map((record) => record.row.sessionId ?? null),
  );

// Chronological split over ALL rows (matches the shipped trainer), then grade
// on the turn-root subset of the holdout.
const split = Math.floor(rows.length * 0.8);
const train = rows.slice(0, split);
const holdout = rows.slice(split);
const trainTurnRoots = train.filter(isTurnRoot);
const holdoutTurnRoots = holdout.filter(isTurnRoot);

const base = makeBase(train);
const shipped = trainPortableQuantileBoost(train, (row) => base(row).q, {
  featureSchema: "portable-precall-v2",
});

// Sweep: turn-root corrections either replace the shipped correction (base =
// ladder) or stack on top of it (base = shipped prediction).
const CONFIGS = [];
for (const minimumLeaf of [40, 60, 80]) {
  for (const [iterations, maxDepth] of [
    [48, 3],
    [24, 2],
    [16, 2],
  ]) {
    for (const stacked of [false, true]) {
      CONFIGS.push({ minimumLeaf, iterations, maxDepth, stacked });
    }
  }
}
const candidates = CONFIGS.map((config) => {
  const baseFn = config.stacked
    ? (row) => shipped.predict(row)
    : (row) => base(row).q;
  const trained = trainPortableQuantileBoost(trainTurnRoots, baseFn, {
    featureSchema: "portable-precall-v2",
    minimumLeaf: config.minimumLeaf,
    iterations: config.iterations,
    maxDepth: config.maxDepth,
  });
  return { config, trained, baseFn };
});

const records = holdoutTurnRoots.map((row) => {
  const record = {
    row,
    baseline: base(row).q,
    shipped: shipped.predict(row),
  };
  candidates.forEach((candidate, index) => {
    record[`c${index}`] = candidate.trained.predict(row);
  });
  return record;
});

function splitCounts(model) {
  const counts = new Map();
  const walk = (node) => {
    if (node.feature === undefined) return;
    counts.set(node.feature, (counts.get(node.feature) ?? 0) + 1);
    walk(node.left);
    walk(node.right);
  };
  for (const trees of model.ensembles) for (const tree of trees) walk(tree);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

// Live-typing simulation: the demo prompt, accumulated phrase by phrase, as a
// synthetic turn root on the corpus's dominant model with thinking on. A demo
// needs the forecast to move upward as intent accumulates, so score each
// candidate on monotone growth of p50 across the phrases too.
const modelCounts = new Map();
for (const row of trainTurnRoots) {
  modelCounts.set(row.model, (modelCounts.get(row.model) ?? 0) + 1);
}
const demoModel =
  [...modelCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
const PHRASES = [
  "can you write",
  "can you write a small report",
  "can you write a small report into a file",
  "can you write a small report into a file lets say ./here.txt",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr in the internet",
];
const demoRow = (text) => {
  const prompt = derivePromptFeatures(text);
  return {
    model: demoModel,
    thinking: "yes",
    turnPrompt: prompt,
    promptPath: prompt.mentionsPath ? "yes" : "no",
    promptImage: "no",
    sessionPosition: 1,
    loopDepth: 0,
    priorCalls: 0,
    priorMaxOutput: null,
    priorArtifactCount: null,
    priorWrite: null,
    priorArtifact: null,
  };
};
function trajectory(predict) {
  const p50s = PHRASES.map((text) => predict(demoRow(text))[0]);
  let drops = 0;
  let dropMagnitude = 0;
  for (let index = 1; index < p50s.length; index++) {
    if (p50s[index] < p50s[index - 1]) {
      drops++;
      dropMagnitude += p50s[index - 1] - p50s[index];
    }
  }
  return {
    p50s,
    growth: p50s[p50s.length - 1] - p50s[0],
    drops,
    dropMagnitude,
  };
}

const summaries = candidates.map((candidate, index) => {
  const field = `c${index}`;
  return {
    ...candidate.config,
    holdout: metrics(records, field),
    vsShipped: comparePair(records, field, "shipped"),
    splits: splitCounts(candidate.trained.model),
    typing: trajectory((row) => candidate.trained.predict(row)),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  dataset: {
    calls: rows.length,
    turnRoots: rows.filter(isTurnRoot).length,
    trainTurnRoots: trainTurnRoots.length,
    holdoutTurnRoots: holdoutTurnRoots.length,
    demoModel,
  },
  holdout: {
    baseline: metrics(records, "baseline"),
    shipped: metrics(records, "shipped"),
  },
  shippedTyping: trajectory((row) => shipped.predict(row)),
  baselineTyping: trajectory((row) => base(row).q),
  candidates: summaries,
};
await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const show = (evaluation) =>
  `loss=${evaluation.loss.toFixed(1)} cov=${evaluation.coverage
    .map((value) => `${(value * 100).toFixed(0)}%`)
    .join("/")}`;
console.log(
  `turn roots: ${report.dataset.turnRoots} of ${rows.length} calls ` +
    `(train ${trainTurnRoots.length}, holdout ${holdoutTurnRoots.length}), demo model ${demoModel}`,
);
console.log(`baseline ${show(report.holdout.baseline)} typing=${report.baselineTyping.p50s.join(",")}`);
console.log(`shipped  ${show(report.holdout.shipped)} typing=${report.shippedTyping.p50s.join(",")}`);
for (const summary of summaries) {
  console.log(
    `leaf=${summary.minimumLeaf} it=${summary.iterations} d=${summary.maxDepth} ` +
      `${summary.stacked ? "stacked" : "replace"}: ${show(summary.holdout)} ` +
      `vsShipped=${summary.vsShipped.meanDifference.toFixed(1)} ` +
      `[${summary.vsShipped.ciLower.toFixed(1)}, ${summary.vsShipped.ciUpper.toFixed(1)}] ` +
      `typing=${summary.typing.p50s.join(",")} drops=${summary.typing.drops}`,
  );
}
console.log(`Wrote ${jsonOut}`);

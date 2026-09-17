#!/usr/bin/env node
/**
 * Does the prompt-path rung earn its place in the SHIPPED BASE?
 *
 * The loss ladder in claude-code-history-eval.json is not monotone. On the
 * 7 Aug chronological split the strict rungs read:
 *
 *   model+thinking                 520.29
 *   model+thinking+promptPath      538.48   <- costs 18.2 per call
 *
 * and eval-winning-boost.mjs trains its correction on a base whose first rung
 * is exactly that losing one:
 *
 *   model+thinking+promptPath -> pooled promptPath -> model+thinking -> model
 *
 * The boost then wins 16.2 back (538.48 -> 522.25), which lands the shipped
 * stack ~2 points ABOVE the plain model+thinking rung. That is the shape of a
 * correction spending its capacity undoing a base-rung mistake rather than
 * modelling anything new.
 *
 * THE QUESTION: drop the two promptPath rungs from the base ladder, retrain the
 * SAME correction on top, and does the stack get better?
 *
 *   shipped base  = mtp -> path -> mt -> model -> overall
 *   candidate base =               mt -> model -> overall
 *
 * Both bases are fitted on the same train rows and scored on the same test rows
 * inside one fitAndScore call, so every comparison here is paired per call and
 * the block bootstrap resamples SESSIONS (house rule 14), matching the adoption
 * gate in eval-winning-boost.mjs.
 *
 * KILL CONDITION, pre-committed: the candidate replaces the shipped base only if
 * the paired rolling CI for (candidate stack - shipped stack) is entirely below
 * zero AND p90 coverage stays in [0.88, 0.93]. A CI that straddles zero means
 * the promptPath rungs are noise, not a win, and the ladder stays as shipped --
 * this probe is then a documentation fact, not a ship change.
 *
 * Writes experiments/artifacts/base-ladder-probe.json. Reads nothing but the
 * local transcript corpus; changes no shipped artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  redactHome,
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
  path.join(process.cwd(), "experiments/artifacts/base-ladder-probe.json"),
);
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;
const SHIPPED_SCHEMA = "portable-precall-v2";

// --- corpus load and row prep, identical to eval-winning-boost.mjs ----------
const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
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
    parent = parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
  row.isWrite = (row.tools[0] ?? "(no-tool)") === "Write";
}

// --- rung machinery, identical to eval-winning-boost.mjs -------------------
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
const LADDERS = {
  shipped: [key.mtp, key.path, key.mt, key.model],
  noPromptPath: [key.mt, key.model],
};
function makeBase(trainRows, keys) {
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
function loss(row, forecast) {
  return QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, forecast[index], probability),
    0,
  );
}
function metrics(records, field) {
  const result = { n: records.length, loss: 0, coverage: [0, 0, 0], width: [0, 0] };
  for (const record of records) {
    const forecast = record[field];
    result.loss += loss(record.row, forecast);
    for (let index = 0; index < QUANTILES.length; index++) {
      result.coverage[index] += record.row.outputTokens <= forecast[index] ? 1 : 0;
    }
    result.width[0] += forecast[1] - forecast[0];
    result.width[1] += forecast[2] - forecast[0];
  }
  result.loss /= records.length;
  result.coverage = result.coverage.map((value) => value / records.length);
  result.width = result.width.map((value) => value / records.length);
  return result;
}
function comparePair(records, treatment, control) {
  const differences = records.map(
    (record) => loss(record.row, record[treatment]) - loss(record.row, record[control]),
  );
  return blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
}

/**
 * Both ladders, both bases, and both boosts fitted on the SAME train rows and
 * scored on the SAME test rows, so all four series are paired call-for-call.
 */
function fitAndScore(train, test, fold = null) {
  const shippedBase = makeBase(train, LADDERS.shipped);
  const plainBase = makeBase(train, LADDERS.noPromptPath);
  const shippedBoost = trainPortableQuantileBoost(train, (row) => shippedBase(row).q, {
    featureSchema: SHIPPED_SCHEMA,
  });
  const plainBoost = trainPortableQuantileBoost(train, (row) => plainBase(row).q, {
    featureSchema: SHIPPED_SCHEMA,
  });
  return test.map((row) => ({
    row,
    fold,
    shippedBase: shippedBase(row).q,
    plainBase: plainBase(row).q,
    shippedStack: shippedBoost.predict(row),
    plainStack: plainBoost.predict(row),
  }));
}

const SERIES = ["shippedBase", "plainBase", "shippedStack", "plainStack"];
const summarise = (records) => ({
  n: records.length,
  ...Object.fromEntries(SERIES.map((series) => [series, metrics(records, series)])),
  /** The ship question: candidate stack minus shipped stack. Negative = drop promptPath. */
  stackDifference: comparePair(records, "plainStack", "shippedStack"),
  /** The same question one layer down, before any correction. */
  baseDifference: comparePair(records, "plainBase", "shippedBase"),
  /** How much each correction is worth on top of its own base. */
  shippedBoostGain: comparePair(records, "shippedStack", "shippedBase"),
  plainBoostGain: comparePair(records, "plainStack", "plainBase"),
});

const split = Math.floor(rows.length * 0.8);
const singleRecords = fitAndScore(rows.slice(0, split), rows.slice(split));
const singleSplit = {
  trainCalls: split,
  holdoutCalls: rows.length - split,
  trainThrough: new Date(rows[split - 1].timestampMs).toISOString(),
  holdoutFrom: new Date(rows[split].timestampMs).toISOString(),
  ...summarise(singleRecords),
};

const blockSize = Math.floor((rows.length - split) / 5);
const rollingRecords = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  rollingRecords.push(...fitAndScore(rows.slice(0, start), rows.slice(start, end), fold + 1));
}
const rolling = {
  folds: Array.from({ length: 5 }, (_, index) => ({
    fold: index + 1,
    ...summarise(rollingRecords.filter((record) => record.fold === index + 1)),
  })),
  ...summarise(rollingRecords),
};

// --- pre-committed gate ----------------------------------------------------
const p90Coverage = rolling.plainStack.coverage[1];
const gate = {
  rule:
    "adopt the promptPath-free base iff the paired rolling (plainStack - shippedStack) CI " +
    "upper bound < 0 AND plainStack p90 coverage in [0.88, 0.93]",
  meanDifference: rolling.stackDifference.meanDifference,
  ciLower: rolling.stackDifference.ciLower,
  ciUpper: rolling.stackDifference.ciUpper,
  p90Coverage,
  beatsShipped: rolling.stackDifference.ciUpper < 0,
  coverageInBand: p90Coverage >= 0.88 && p90Coverage <= 0.93,
};
gate.adopt = gate.beatsShipped && gate.coverageInBand;

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  question:
    "Does the promptPath rung earn its place in the shipped base ladder, given " +
    "that the trained correction is fitted on top of it?",
  ladders: {
    shipped: "model+thinking+promptPath -> pooled promptPath -> model+thinking -> model -> overall",
    noPromptPath: "model+thinking -> model -> overall",
  },
  dataset: { filesScanned, calls: rows.length, sessions: sessions.size },
  singleSplit,
  rolling,
  gate,
};

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const show = (label, m) =>
  `${label.padEnd(24)} loss ${m.loss.toFixed(2).padStart(8)}  p90 cov ${m.coverage[1].toFixed(3)}`;
const ci = (label, c) =>
  `${label.padEnd(24)} ${c.meanDifference.toFixed(2).padStart(8)}  CI [${c.ciLower.toFixed(2)}, ${c.ciUpper.toFixed(2)}]`;
console.log(`corpus: ${rows.length} calls, ${sessions.size} sessions, ${filesScanned} files`);
console.log(`\n--- single split (holdout n=${singleSplit.n}) ---`);
for (const series of SERIES) console.log(show(series, singleSplit[series]));
console.log(ci("plain - shipped (stack)", singleSplit.stackDifference));
console.log(ci("plain - shipped (base)", singleSplit.baseDifference));
console.log(`\n--- rolling, 5 folds (n=${rolling.n}) ---`);
for (const series of SERIES) console.log(show(series, rolling[series]));
console.log(ci("plain - shipped (stack)", rolling.stackDifference));
console.log(ci("plain - shipped (base)", rolling.baseDifference));
console.log(ci("shipped boost gain", rolling.shippedBoostGain));
console.log(ci("plain boost gain", rolling.plainBoostGain));
console.log(`\ngate: adopt=${gate.adopt} (beats=${gate.beatsShipped}, coverage=${gate.coverageInBand}, p90=${p90Coverage.toFixed(3)})`);
console.log(`wrote ${jsonOut}`);

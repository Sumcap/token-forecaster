#!/usr/bin/env node
/**
 * Final evaluator/generator for the adopted portable quantile correction.
 * Candidate selection belongs in probe-breakthroughs.mjs; this file freezes the
 * winner and provides the reproducible single-split, rolling-origin, segment,
 * and deployment-profile path.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultProjectsDir, hasThinkingBlock, loadRequests } from "./lib/load-history.mjs";
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
  path.join(process.cwd(), "experiments/artifacts/winning-boost-eval.json"),
);
const baseProfileFile = argValue("--base-profile");
const profileOut = argValue("--profile-out");
const bundledOut = argValue("--bundled-profile-out");
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;

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
    parent =
      parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
  row.isWrite = (row.tools[0] ?? "(no-tool)") === "Write";
}

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
const compare = (records) => comparePair(records, "boosted", "baseline");
/** v3 minus v2 on identical folds: positive means the new feature costs loss. */
const compareSchemas = (records) => comparePair(records, "candidate", "boosted");
// Schema v3 (compression follow-up, feature 37) is graded against the shipped
// v2 on identical folds. Both are trained here so the comparison is paired: the
// only difference between the two models is the extra candidate column.
const SHIPPED_SCHEMA = "portable-precall-v2";
const CANDIDATE_SCHEMA = "portable-precall-v3";

function fitAndScore(train, test, fold = null) {
  const base = makeBase(train);
  const shipped = trainPortableQuantileBoost(train, (row) => base(row).q, {
    featureSchema: SHIPPED_SCHEMA,
  });
  const candidate = trainPortableQuantileBoost(train, (row) => base(row).q, {
    featureSchema: CANDIDATE_SCHEMA,
  });
  return {
    model: shipped.model,
    candidateModel: candidate.model,
    records: test.map((row) => ({
      row,
      fold,
      baseline: base(row).q,
      boosted: shipped.predict(row),
      candidate: candidate.predict(row),
    })),
  };
}

const split = Math.floor(rows.length * 0.8);
const single = fitAndScore(rows.slice(0, split), rows.slice(split));
const singleSplit = {
  trainCalls: split,
  holdoutCalls: rows.length - split,
  trainThrough: new Date(rows[split - 1].timestampMs).toISOString(),
  holdoutFrom: new Date(rows[split].timestampMs).toISOString(),
  baseline: metrics(single.records, "baseline"),
  boosted: metrics(single.records, "boosted"),
  candidate: metrics(single.records, "candidate"),
  comparison: compare(single.records),
  schemaComparison: compareSchemas(single.records),
};

const blockSize = Math.floor((rows.length - split) / 5);
const rollingRecords = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  rollingRecords.push(
    ...fitAndScore(rows.slice(0, start), rows.slice(start, end), fold + 1).records,
  );
}
const rolling = {
  folds: Array.from({ length: 5 }, (_, index) => {
    const records = rollingRecords.filter((record) => record.fold === index + 1);
    return {
      fold: index + 1,
      n: records.length,
      baseline: metrics(records, "baseline"),
      boosted: metrics(records, "boosted"),
      candidate: metrics(records, "candidate"),
      comparison: compare(records),
      schemaComparison: compareSchemas(records),
    };
  }),
  baseline: metrics(rollingRecords, "baseline"),
  boosted: metrics(rollingRecords, "boosted"),
  candidate: metrics(rollingRecords, "candidate"),
  comparison: compare(rollingRecords),
  schemaComparison: compareSchemas(rollingRecords),
};

function segment(accessor, minimum = 100) {
  const groups = new Map();
  for (const record of rollingRecords) {
    const raw = accessor(record.row);
    const value = raw === null || raw === undefined ? "(unknown)" : String(raw);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(record);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .filter(([, records]) => records.length >= minimum)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([value, records]) => [
        value,
        {
          n: records.length,
          baseline: metrics(records, "baseline"),
          boosted: metrics(records, "boosted"),
          candidate: metrics(records, "candidate"),
          comparison: compare(records),
          schemaComparison: compareSchemas(records),
          writeRate: records.filter((record) => record.row.isWrite).length / records.length,
        },
      ]),
  );
}

/**
 * Adoption gate for feature schema v3, graded on the rolling-origin holdout.
 * The bundled profile only moves to v3 when the extra column costs nothing:
 * no provable pinball regression against the shipped v2 (paired session-block
 * bootstrap, lower bound of the v3−v2 CI at or below zero) and P90 coverage
 * still inside the band the shipped correction holds (91.9% at adoption of
 * §6.24; band 88–93%).
 */
const P90_COVERAGE_BAND = [0.88, 0.93];
// A support floor comes first, because without it the gate is vacuous: the
// trainer's minimum leaf is 150 rows, so a feature that fires on fewer than
// that can never be chosen as a split and v3 trains byte-identical trees to v2
// -- a zero difference that would read as "no regression" and adopt a schema
// whose new column is dead. Grade support before grading loss.
const BOOST_MINIMUM_LEAF = 150;
const candidateFeatureRows = rows.filter(
  (row) => row.turnPrompt?.followupCompression === true,
).length;
const candidateFeatureTurns = new Set(
  rows
    .filter((row) => row.turnPrompt?.followupCompression === true)
    .map((row) => row.turnPrompt.promptHash),
).size;
const schemaGate = {
  shippedSchema: SHIPPED_SCHEMA,
  candidateSchema: CANDIDATE_SCHEMA,
  rule:
    `adopt v3 iff the new feature fires on >= ${BOOST_MINIMUM_LEAF} training rows ` +
    "AND the paired rolling v3-v2 CI lower bound <= 0 (no provable pinball " +
    `regression) AND v3 P90 coverage in [${P90_COVERAGE_BAND.join(", ")}]`,
  candidateFeatureRows,
  candidateFeatureTurns,
  supported: candidateFeatureRows >= BOOST_MINIMUM_LEAF,
  meanDifference: rolling.schemaComparison.meanDifference,
  ciLower: rolling.schemaComparison.ciLower,
  ciUpper: rolling.schemaComparison.ciUpper,
  p90Coverage: rolling.candidate.coverage[1],
  noRegression: rolling.schemaComparison.ciLower <= 0,
  coverageInBand:
    rolling.candidate.coverage[1] >= P90_COVERAGE_BAND[0] &&
    rolling.candidate.coverage[1] <= P90_COVERAGE_BAND[1],
};
schemaGate.adopt =
  schemaGate.supported && schemaGate.noRegression && schemaGate.coverageInBand;
const deployedSchema = schemaGate.adopt ? CANDIDATE_SCHEMA : SHIPPED_SCHEMA;

let deployment = null;
if (baseProfileFile) {
  const baseProfile = JSON.parse(await readFile(baseProfileFile, "utf8"));
  const profileBase = (row) => {
    for (const groupKey of [key.mtp(row), key.path(row), key.mt(row), key.model(row), "overall"]) {
      if (groupKey === null) continue;
      const group = baseProfile.groups[groupKey];
      if (group?.sampleSize >= MIN_GROUP) return [group.p50, group.p90, group.p99];
    }
    return [1_000, 4_000, 12_000];
  };
  const trained = trainPortableQuantileBoost(rows, profileBase, {
    featureSchema: deployedSchema,
  });
  const profile = { ...baseProfile, boostedCorrection: trained.model };
  deployment = {
    profileId: profile.id,
    trainingSamples: trained.model.trainingSamples,
    featureSchema: trained.model.featureSchema,
    treesPerQuantile: trained.model.ensembles.map((trees) => trees.length),
    schemaGate,
  };
  if (profileOut) {
    await mkdir(path.dirname(profileOut), { recursive: true });
    await writeFile(profileOut, `${JSON.stringify(profile, null, 2)}\n`);
  }
  if (bundledOut) {
    await mkdir(path.dirname(bundledOut), { recursive: true });
    await writeFile(
      bundledOut,
      `import type { HistoricalForecastProfile } from "./historical.js";\n\n/**\n * Generated by eval-claude-code-history.mjs + eval-winning-boost.mjs.\n * Privacy-safe aggregates and shallow portable correction only; no prompt text.\n */\nexport const BUNDLED_CLAUDE_CODE_PROFILE: HistoricalForecastProfile = ${JSON.stringify(profile, null, 2)};\n`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  source: projectsDir,
  predictorVersion: "baseline-3-boosted/0.3.0",
  dataset: {
    filesScanned,
    calls: rows.length,
    sessions: new Set(rows.map((row) => row.sessionId).filter(Boolean)).size,
    users: 1,
  },
  method: {
    base: "model+thinking+promptPath -> pooled promptPath -> model+thinking -> model -> overall",
    correction: `48 depth-3 trees per quantile; portable structured pre-call, deployed schema ${deployedSchema}`,
    adoption: "paired session-block bootstrap CI upper < 0",
    breakthrough: "at least 5% loss reduction or material width reduction without calibration damage",
  },
  singleSplit,
  rolling,
  segments: {
    byWorkload: segment((row) => row.workloadId),
    byModelThinking: segment((row) => `${row.model}|thinking=${row.thinking}`),
    byPromptPath: segment((row) => row.promptPath),
    bySessionPosition: segment((row) =>
      row.sessionPosition < 5
        ? "0-4"
        : row.sessionPosition < 20
          ? "5-19"
          : row.sessionPosition < 60
            ? "20-59"
            : "60+",
    ),
    byDeliverable: segment((row) => row.turnPrompt?.deliverableType ?? null),
    byFollowupCompression: segment(
      (row) =>
        row.turnPrompt === null || row.turnPrompt === undefined
          ? null
          : row.turnPrompt.followupCompression
            ? "yes"
            : "no",
      1,
    ),
  },
  schemaGate,
  deployment,
};
await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const show = (label, evaluation) =>
  `${label}: loss=${evaluation.loss.toFixed(1)} coverage=${evaluation.coverage.map((value) => `${(value * 100).toFixed(1)}%`).join("/")} widths=${evaluation.width.map((value) => Math.round(value)).join("/")}`;
console.log(show("Single baseline", singleSplit.baseline));
console.log(show("Single boosted ", singleSplit.boosted));
console.log(
  `Single diff ${singleSplit.comparison.meanDifference.toFixed(1)} ` +
    `[${singleSplit.comparison.ciLower.toFixed(1)}, ${singleSplit.comparison.ciUpper.toFixed(1)}]`,
);
console.log(show("Rolling baseline", rolling.baseline));
console.log(show("Rolling boosted ", rolling.boosted));
console.log(
  `Rolling diff ${rolling.comparison.meanDifference.toFixed(1)} ` +
    `[${rolling.comparison.ciLower.toFixed(1)}, ${rolling.comparison.ciUpper.toFixed(1)}]`,
);
for (const fold of rolling.folds) {
  console.log(
    `  fold ${fold.fold}: ${fold.comparison.meanDifference.toFixed(1)} ` +
      `[${fold.comparison.ciLower.toFixed(1)}, ${fold.comparison.ciUpper.toFixed(1)}]`,
  );
}
console.log(show("Rolling v3     ", rolling.candidate));
console.log(
  `Schema v3-v2 ${schemaGate.meanDifference.toFixed(2)} ` +
    `[${schemaGate.ciLower.toFixed(2)}, ${schemaGate.ciUpper.toFixed(2)}] ` +
    `p90cov=${(schemaGate.p90Coverage * 100).toFixed(1)}% ` +
    `support=${candidateFeatureRows} calls / ${candidateFeatureTurns} turns -> ` +
    `${schemaGate.adopt ? "ADOPTED" : "NOT ADOPTED"} (deploying ${deployedSchema})`,
);
const compressionSegment = report.segments.byFollowupCompression.yes;
if (compressionSegment) {
  console.log(
    `  compression follow-ups n=${compressionSegment.n}: v3-v2 ` +
      `${compressionSegment.schemaComparison.meanDifference.toFixed(2)} ` +
      `[${compressionSegment.schemaComparison.ciLower.toFixed(2)}, ` +
      `${compressionSegment.schemaComparison.ciUpper.toFixed(2)}]`,
  );
}
console.log(`Wrote ${jsonOut}`);

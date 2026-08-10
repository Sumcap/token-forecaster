#!/usr/bin/env node
/**
 * Audit the TARGET, not another feature: is total pinball (p50+p90+p99) the
 * product's loss?
 *
 * The product use is a RESERVATION. A caller reserves R tokens of context for
 * the reply (typically R = p90, R = p99 when truncation is expensive):
 *
 *   waste    = max(0, R - y)   tokens reserved but never used  (cheap-ish)
 *   overflow = y > R           the reply did not fit            (expensive)
 *   excess   = max(0, y - R)   how far it did not fit
 *
 * A reservation loss family L_k = waste + k * excess prices one overflow token
 * at k wasted ones. L_9 at R=p90 is exactly 10x the p90 pinball loss, and L_99
 * at R=p99 is 100x the p99 pinball — so pinball IS a reservation loss at one
 * fixed exchange rate per quantile, and total pinball is a particular blend.
 * What has never been checked is whether any adopt/reject verdict DEPENDS on
 * that blend. This probe re-grades every open verdict under:
 *
 *   - per-quantile pinball (p50-only / p90-only / p99-only), and
 *   - L_k at R=p90 for k in {1, 4, 9, 19, 49},
 *
 * with the same paired session-block bootstrap. If every verdict keeps its
 * sign and gate status everywhere, the pinball target is vindicated and the
 * question closes; any flip is the finding.
 *
 * Verdicts re-graded (candidate vs baseline):
 *   promptPath   mtp ladder            vs model+thinking     (ADOPTED 5 Aug)
 *   prevOutput   mtp+prevOutput ladder vs mtp ladder         (REFUSED §7.1)
 *   boosted      trained correction    vs mtp ladder         (ADOPTED 6 Aug)
 *   window14     14-day hard window    vs full history       (REJECTED §6.8)
 *   decay7       7d-half-life weights  vs full history       (REFUSED, calibration probe)
 *   thinkPooled  pooled thinking rung  vs overall, LOMO      (ADOPTED, cold-start probe)
 *
 * Writes experiments/artifacts/reservation-metric-probe.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { trainPortableQuantileBoost } from "./lib/quantile-boost.mjs";
import {
  blockBootstrapDifference,
  fmt,
  pct,
  pinball,
  quantile,
} from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/reservation-metric-probe.json"),
);
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;
const KAPPAS = [1, 4, 9, 19, 49];
const DAY_MS = 24 * 3600 * 1000;

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withLoopContext: true,
});
const rows = loaded
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      Number.isFinite(row.outputTokens) &&
      row.outputTokens >= 0 &&
      (asOfMs === null || row.timestampMs < asOfMs),
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
  const parent = row.parentRequestId === null ? null : byId.get(row.parentRequestId);
  row.previousOutputTokens = parent ? parent.outputTokens : null;
  // Boost features (mirrors eval-winning-boost.mjs).
  let chain = parent ?? null;
  let priorCalls = 0;
  let priorMaxOutput = 0;
  let priorArtifacts = 0;
  let priorWrites = 0;
  const seen = new Set();
  while (chain && priorCalls < 200 && !seen.has(chain.requestId)) {
    seen.add(chain.requestId);
    priorCalls++;
    const action = chain.tools[0] ?? "(no-tool)";
    const artifact = action === "Write" || (action === "Edit" && chain.toolChars >= 4_000);
    if (action === "Write") priorWrites++;
    if (artifact) priorArtifacts++;
    priorMaxOutput = Math.max(priorMaxOutput, chain.outputTokens);
    chain = chain.parentRequestId === null ? null : byId.get(chain.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
}
console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls` +
    `${asOf === null ? "" : `  (truncated at ${asOf})`}\n`,
);

function fit(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return QUANTILES.map((probability) => Math.round(quantile(sorted, probability)));
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
const PREV_EDGES = [200, 800, 3000];
const prevBucket = (tokens) => {
  if (tokens === null || tokens === undefined) return null;
  if (tokens < PREV_EDGES[0]) return `lt${PREV_EDGES[0]}`;
  if (tokens < PREV_EDGES[1]) return `${PREV_EDGES[0]}-${PREV_EDGES[1]}`;
  if (tokens < PREV_EDGES[2]) return `${PREV_EDGES[1]}-${PREV_EDGES[2]}`;
  return `gte${PREV_EDGES[2]}`;
};
const key = {
  mtp: (row) =>
    row.promptPath === null
      ? null
      : `model=${row.model}|thinking=${row.thinking}|promptPath=${row.promptPath}`,
  path: (row) => (row.promptPath === null ? null : `promptPath=${row.promptPath}`),
  mt: (row) => `model=${row.model}|thinking=${row.thinking}`,
  model: (row) => `model=${row.model}`,
  prev: (row) => {
    const bucket = prevBucket(row.previousOutputTokens);
    return bucket === null
      ? null
      : `model=${row.model}|thinking=${row.thinking}|prevOutput=${bucket}`;
  },
  thinking: (row) => `thinking=${row.thinking}`,
};
function makeLadder(trainRows, rungs) {
  const fits = rungs.map((rung) => fitGroups(trainRows, key[rung]));
  const overall = fit(trainRows.map((row) => row.outputTokens));
  return (row) => {
    for (let index = 0; index < rungs.length; index++) {
      const group = key[rungs[index]](row);
      if (group === null) continue;
      const found = fits[index].get(group);
      if (found) return found;
    }
    return overall;
  };
}
const applyWindow = (trainRows, days) => {
  const cutoff = trainRows[trainRows.length - 1].timestampMs - days * DAY_MS;
  return trainRows.filter((row) => row.timestampMs >= cutoff);
};

const split = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - split) / 5);
const folds = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

// Weighted quantiles for the decay candidate (same as calibration probe).
function makeDecayLadder(trainRows, halfLifeDays) {
  const tEnd = trainRows[trainRows.length - 1].timestampMs;
  const lambda = Math.LN2 / (halfLifeDays * DAY_MS);
  const weightOf = (row) => Math.exp(-lambda * (tEnd - row.timestampMs));
  const rungs = ["mtp", "path", "mt", "model"];
  const fitsPerRung = rungs.map((rung) => {
    const grouped = new Map();
    for (const row of trainRows) {
      const groupKey = key[rung](row);
      if (groupKey === null) continue;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(row);
    }
    const fitted = new Map();
    for (const [groupKey, groupRows] of grouped) {
      if (groupRows.length < MIN_GROUP) continue;
      const pairs = groupRows
        .map((row) => [row.outputTokens, weightOf(row)])
        .sort((a, b) => a[0] - b[0]);
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      fitted.set(
        groupKey,
        QUANTILES.map((p) => {
          const target = p * total;
          let cumulative = 0;
          for (const [value, weight] of pairs) {
            cumulative += weight;
            if (cumulative >= target) return value;
          }
          return pairs[pairs.length - 1][0];
        }),
      );
    }
    return fitted;
  });
  const base = makeLadder(trainRows, rungs);
  return (row) => {
    for (let index = 0; index < rungs.length; index++) {
      const groupKey = key[rungs[index]](row);
      if (groupKey === null) continue;
      const found = fitsPerRung[index].get(groupKey);
      if (found) return found;
    }
    return base(row);
  };
}

// ---------------------------------------------------------------------------
// Score every candidate/baseline pair per fold
// ---------------------------------------------------------------------------

console.log("Fitting per-fold predictors (incl. boosted training) ...");
const records = [];
for (const fold of folds) {
  const mt = makeLadder(fold.train, ["mt", "model"]);
  const mtp = makeLadder(fold.train, ["mtp", "path", "mt", "model"]);
  const prev = makeLadder(fold.train, ["mtp", "path", "prev", "mt", "model"]);
  const window14 = makeLadder(applyWindow(fold.train, 14), ["mtp", "path", "mt", "model"]);
  const decay7 = makeDecayLadder(fold.train, 7);
  const boosted = trainPortableQuantileBoost(fold.train, (row) => mtp(row));
  for (const row of fold.test) {
    records.push({
      row,
      mt: mt(row),
      mtp: mtp(row),
      prev: prev(row),
      window14: window14(row),
      decay7: decay7(row),
      boosted: boosted.predict(row),
    });
  }
}

// LOMO records for the pooled-thinking fallback verdict.
const lomoRecords = [];
for (const fold of folds) {
  const models = new Set(fold.test.map((row) => row.model));
  for (const excluded of models) {
    const trainWithout = fold.train.filter((row) => row.model !== excluded);
    if (trainWithout.length < MIN_GROUP) continue;
    const overall = fit(trainWithout.map((row) => row.outputTokens));
    const thinkingFits = fitGroups(trainWithout, key.thinking);
    for (const row of fold.test) {
      if (row.model !== excluded) continue;
      lomoRecords.push({
        row,
        overallOnly: overall,
        thinkPooled: thinkingFits.get(key.thinking(row)) ?? overall,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

const METRICS = {
  totalPinball: (row, q) =>
    QUANTILES.reduce((s, p, i) => s + pinball(row.outputTokens, q[i], p), 0),
  pinballP50: (row, q) => pinball(row.outputTokens, q[0], 0.5),
  pinballP90: (row, q) => pinball(row.outputTokens, q[1], 0.9),
  pinballP99: (row, q) => pinball(row.outputTokens, q[2], 0.99),
};
for (const kappa of KAPPAS) {
  METRICS[`reserveP90_k${kappa}`] = (row, q) => {
    const waste = Math.max(0, q[1] - row.outputTokens);
    const excess = Math.max(0, row.outputTokens - q[1]);
    return waste + kappa * excess;
  };
}
METRICS.reserveP99_k99 = (row, q) => {
  const waste = Math.max(0, q[2] - row.outputTokens);
  const excess = Math.max(0, row.outputTokens - q[2]);
  return waste + 99 * excess;
};

const COMPARISONS = [
  ["promptPath (ADOPTED)", records, "mtp", "mt"],
  ["prevOutput (REFUSED)", records, "prev", "mtp"],
  ["boosted (ADOPTED)", records, "boosted", "mtp"],
  ["window14 (REJECTED)", records, "window14", "mtp"],
  ["decay7 (REFUSED)", records, "decay7", "mtp"],
  ["thinkPooled LOMO (ADOPTED)", lomoRecords, "thinkPooled", "overallOnly"],
];

const report = {
  generatedAt: new Date().toISOString(),
  source: projectsDir,
  calls: rows.length,
  holdoutCalls: records.length,
  lomoCalls: lomoRecords.length,
  kappaNote:
    "L_k at R=p90: one overflow token costs k wasted tokens. k=9 is 10x p90 pinball.",
  comparisons: {},
};

console.log("\nVERDICTS UNDER EVERY METRIC (mean per-call diff, [95% CI], gate = CI upper < 0)\n");
for (const [label, recordSet, candidate, baseline] of COMPARISONS) {
  console.log(`${label}: ${candidate} vs ${baseline} on ${recordSet.length} calls`);
  report.comparisons[label] = {};
  for (const [metricName, metricFn] of Object.entries(METRICS)) {
    const differences = recordSet.map(
      (record) =>
        metricFn(record.row, record[candidate]) - metricFn(record.row, record[baseline]),
    );
    const comparison = blockBootstrapDifference(
      differences,
      recordSet.map((record) => record.row.sessionId ?? null),
    );
    report.comparisons[label][metricName] = comparison;
    console.log(
      `    ${metricName.padEnd(18)} ${comparison.meanDifference.toFixed(2).padStart(10)} ` +
        `[${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]` +
        `${comparison.ciUpper < 0 ? "  PASS" : comparison.ciLower > 0 ? "  ANTI (worse, CI clear of 0)" : "  inconclusive"}`,
    );
  }
}

// Overflow-rate calibration under product terms, shipped ladder.
const overflow = {
  p90: records.filter((r) => r.row.outputTokens > r.mtp[1]).length / records.length,
  p99: records.filter((r) => r.row.outputTokens > r.mtp[2]).length / records.length,
};
report.shippedOverflowRates = overflow;
console.log(
  `\nShipped ladder overflow rates: p90 reservation overflows ${pct(overflow.p90)} of calls ` +
    `(promise: 10.0%), p99 ${pct(overflow.p99)} (promise: 1.0%)`,
);

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

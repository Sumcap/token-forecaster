#!/usr/bin/env node
/**
 * Chase the P50 miscalibration (57% coverage against a 50% target) and the
 * monotone P90 coverage drift flagged on 4 August and never diagnosed.
 *
 * Two jobs, in order:
 *
 *   A. FIND THE MECHANISM, not just the number. Candidates:
 *        1. quantile-estimator bias in small groups
 *             -> refuted/confirmed by in-sample coverage of each fitted group
 *                on its own training rows (an unbiased estimator sits at the
 *                target by construction);
 *        2. within-group drift: the same (model, thinking) cell produces
 *             shorter outputs now than over the training history
 *             -> measured directly as train-vs-holdout quantile ratios per
 *                group per fold;
 *        3. composition shift across groups
 *             -> cannot move group-conditional coverage, only the blend, so it
 *                is checked against `overall` separately.
 *
 *   B. GRADE THE CHEAPEST COLD FIX: a split-conformal additive (and
 *      multiplicative) recalibration layer fitted on the most recent slice of
 *      the training data. It needs no caller context — the deltas live in the
 *      profile — so it works on the zero-context path the product depends on.
 *      Adoption is judged exactly like everything else: paired session-block
 *      bootstrap on per-call total pinball, CI upper < 0. Coverage movement is
 *      reported next to it because coverage IS the product promise; a fix that
 *      repairs coverage at neutral pinball is still interesting, and the
 *      report says so explicitly rather than burying it.
 *
 * Population and fold construction match eval-winning-boost.mjs.
 * Writes experiments/artifacts/calibration-probe.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  redactHome,
} from "./lib/load-history.mjs";
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
  path.join(process.cwd(), "experiments/artifacts/calibration-probe.json"),
);
// Freeze the corpus at an instant so probes run minutes apart grade the same
// exam — the corpus is live and grows while this very session works.
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;
// Trailing share of each fold's training slice reserved for conformal deltas.
const CALIBRATION_FRACTION = 0.25;
// A conformal delta is only estimated where the calibration slice has support.
const MIN_CALIBRATION = 50;

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
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
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
}
console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls` +
    `${asOf === null ? "" : `  (truncated at ${asOf})`}\n`,
);

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
      if (found) return found.q;
    }
    return overall.q;
  };
}
const totalLoss = (row, q) =>
  QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, q[index], probability),
    0,
  );

const split = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - split) / 5);
const folds = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  calls: rows.length,
  minGroup: MIN_GROUP,
  calibrationFraction: CALIBRATION_FRACTION,
  minCalibration: MIN_CALIBRATION,
};

// ---------------------------------------------------------------------------
// A1. Estimator bias: in-sample coverage of each fitted group
// ---------------------------------------------------------------------------

console.log("A1. ESTIMATOR CHECK: in-sample coverage of fitted (model,thinking) groups\n");
{
  const inSample = [];
  for (const fold of folds) {
    const fits = fitGroups(fold.train, key.mt);
    for (const [group, fitted] of fits) {
      const values = fold.train
        .filter((row) => key.mt(row) === group)
        .map((row) => row.outputTokens);
      inSample.push({
        group,
        n: values.length,
        coverage: QUANTILES.map(
          (p, i) => values.filter((v) => v <= fitted.q[i]).length / values.length,
        ),
      });
    }
  }
  const meanCov = [0, 1, 2].map(
    (i) => inSample.reduce((s, g) => s + g.coverage[i], 0) / inSample.length,
  );
  report.inSampleCoverage = { groups: inSample.length, meanCoverage: meanCov };
  console.log(
    `  ${inSample.length} fitted group-folds: mean in-sample coverage ` +
      `${meanCov.map(pct).join(" / ")}  (targets 50/90/99 — deviation here would be estimator bias)`,
  );
}

// ---------------------------------------------------------------------------
// A2. Within-group drift: train quantiles vs holdout quantiles, same group
// ---------------------------------------------------------------------------

console.log("\nA2. WITHIN-GROUP DRIFT: train vs holdout quantiles per (model,thinking) fold-group\n");
{
  const drifts = [];
  for (const [foldIndex, fold] of folds.entries()) {
    const byGroup = new Map();
    for (const row of fold.test) {
      const group = key.mt(row);
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(row.outputTokens);
    }
    const fits = fitGroups(fold.train, key.mt);
    for (const [group, holdoutValues] of byGroup) {
      const fitted = fits.get(group);
      if (!fitted || holdoutValues.length < 30) continue;
      const sorted = [...holdoutValues].sort((a, b) => a - b);
      drifts.push({
        fold: foldIndex + 1,
        group,
        holdoutN: holdoutValues.length,
        // >1 means the training history runs LONGER than the present at that
        // quantile, i.e. the forecast sits too high.
        ratio: QUANTILES.map(
          (p, i) => fitted.q[i] / Math.max(1, quantile(sorted, p)),
        ),
        holdoutCoverage: QUANTILES.map(
          (p, i) => sorted.filter((v) => v <= fitted.q[i]).length / sorted.length,
        ),
      });
    }
  }
  report.withinGroupDrift = drifts;
  const weighted = [0, 1, 2].map((i) => {
    const totalN = drifts.reduce((s, d) => s + d.holdoutN, 0);
    return drifts.reduce((s, d) => s + d.ratio[i] * d.holdoutN, 0) / totalN;
  });
  console.log(
    `  ${drifts.length} group-folds; holdout-weighted mean train/holdout quantile ratio: ` +
      `p50 ${weighted[0].toFixed(3)}  p90 ${weighted[1].toFixed(3)}  p99 ${weighted[2].toFixed(3)}`,
  );
  console.log(
    `  (1.000 = no drift; above 1 = the fitted quantile overshoots today's workload)`,
  );
  const high = drifts.filter((d) => d.ratio[0] > 1.05).length;
  console.log(
    `  group-folds where the fitted p50 overshoots by >5%: ${high}/${drifts.length}`,
  );
  report.withinGroupDriftSummary = { weightedRatio: weighted, overshootShare: high / drifts.length };
}

// ---------------------------------------------------------------------------
// A3. The corpus-level trend the rolling window drags in
// ---------------------------------------------------------------------------

console.log("\nA3. OUTPUT LENGTH BY FORTNIGHT (is the workload itself getting shorter?)\n");
{
  const byPeriod = new Map();
  for (const row of rows) {
    const period = Math.floor(row.timestampMs / (14 * 24 * 3600 * 1000));
    if (!byPeriod.has(period)) byPeriod.set(period, []);
    byPeriod.get(period).push(row.outputTokens);
  }
  const trend = [...byPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, values]) => ({
      from: new Date(period * 14 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      n: values.length,
      p50: Math.round(quantile(values, 0.5)),
      p90: Math.round(quantile(values, 0.9)),
    }));
  report.fortnightTrend = trend;
  for (const t of trend) {
    console.log(`  ${t.from}  n=${String(t.n).padStart(6)}  p50=${String(t.p50).padStart(5)}  p90=${String(t.p90).padStart(6)}`);
  }
}

// ---------------------------------------------------------------------------
// B. Split-conformal recalibration, additive and multiplicative
// ---------------------------------------------------------------------------

console.log("\nB. SPLIT-CONFORMAL RECALIBRATION (deltas fitted on the trailing training slice)\n");

/**
 * Conformal deltas per scope on the calibration slice.
 *
 * For quantile level p: additive delta = p-quantile of (y - qhat_p);
 * multiplicative delta = p-quantile of (y / max(qhat_p, 1)). Applying the
 * additive delta shifts the forecast so that calibration coverage is exactly p;
 * multiplicative does the same in ratio space, which respects the heavy tail.
 */
function fitConformal(calibrationRows, base, scopeFn) {
  const residuals = new Map(); // scope -> per-quantile arrays
  for (const row of calibrationRows) {
    const q = base(row);
    for (const scope of [scopeFn(row), "__global"]) {
      if (!residuals.has(scope)) {
        residuals.set(scope, { add: [[], [], []], mul: [[], [], []] });
      }
      const bucket = residuals.get(scope);
      for (let i = 0; i < QUANTILES.length; i++) {
        bucket.add[i].push(row.outputTokens - q[i]);
        bucket.mul[i].push(row.outputTokens / Math.max(1, q[i]));
      }
    }
  }
  const deltas = new Map();
  for (const [scope, bucket] of residuals) {
    if (scope !== "__global" && bucket.add[0].length < MIN_CALIBRATION) continue;
    deltas.set(scope, {
      n: bucket.add[0].length,
      add: QUANTILES.map((p, i) => quantile(bucket.add[i], p)),
      mul: QUANTILES.map((p, i) => quantile(bucket.mul[i], p)),
    });
  }
  return { deltas, scopeFn };
}
function applyConformal(conformal, row, q, kind) {
  const scoped =
    conformal.deltas.get(conformal.scopeFn(row)) ?? conformal.deltas.get("__global");
  if (!scoped) return q;
  return q.map((value, i) => {
    const adjusted =
      kind === "add" ? value + scoped.add[i] : value * scoped.mul[i];
    // Quantiles must stay ordered and non-negative.
    return Math.max(0, Math.round(adjusted));
  });
}

const VARIANTS = [
  ["confAddGlobal", "add", () => "__global"],
  ["confAddModel", "add", (row) => row.model],
  ["confAddMT", "add", (row) => key.mt(row)],
  ["confMulGlobal", "mul", () => "__global"],
  ["confMulModel", "mul", (row) => row.model],
  ["confMulMT", "mul", (row) => key.mt(row)],
];

const records = [];
for (const fold of folds) {
  const calibrationStart = Math.floor(fold.train.length * (1 - CALIBRATION_FRACTION));
  const properTrain = fold.train.slice(0, calibrationStart);
  const calibration = fold.train.slice(calibrationStart);
  const base = makeBase(properTrain);
  // The reference must be the ladder fitted on the FULL training slice — the
  // shipped construction — otherwise the comparison would credit conformal for
  // data the baseline was denied.
  const shipped = makeBase(fold.train);
  const conformals = VARIANTS.map(([name, kind, scopeFn]) => [
    name,
    kind,
    fitConformal(calibration, base, scopeFn),
  ]);
  for (const row of fold.test) {
    const record = { row, shipped: shipped(row) };
    const properQ = base(row);
    for (const [name, kind, conformal] of conformals) {
      record[name] = applyConformal(conformal, row, properQ, kind);
    }
    records.push(record);
  }
}

function metrics(field) {
  const result = { n: records.length, loss: 0, coverage: [0, 0, 0], width: [0, 0] };
  for (const record of records) {
    const q = record[field];
    result.loss += totalLoss(record.row, q);
    for (let i = 0; i < QUANTILES.length; i++) {
      result.coverage[i] += record.row.outputTokens <= q[i] ? 1 : 0;
    }
    result.width[0] += q[1] - q[0];
    result.width[1] += q[2] - q[0];
  }
  result.loss /= records.length;
  result.coverage = result.coverage.map((v) => v / records.length);
  result.width = result.width.map((v) => v / records.length);
  return result;
}

report.conformal = {};
const shippedMetrics = metrics("shipped");
report.conformal.shipped = shippedMetrics;
console.log(
  `  shipped ladder          loss ${shippedMetrics.loss.toFixed(1)}  cov ${shippedMetrics.coverage.map(pct).join("/")}  widths ${shippedMetrics.width.map((w) => fmt(w)).join("/")}`,
);
for (const [name] of VARIANTS) {
  const m = metrics(name);
  const differences = records.map(
    (record) => totalLoss(record.row, record[name]) - totalLoss(record.row, record.shipped),
  );
  const comparison = blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
  report.conformal[name] = { metrics: m, comparison };
  console.log(
    `  ${name.padEnd(22)} loss ${m.loss.toFixed(1)}  cov ${m.coverage.map(pct).join("/")}  ` +
      `widths ${m.width.map((w) => fmt(w)).join("/")}  ` +
      `diff ${comparison.meanDifference.toFixed(2)} [${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]` +
      `${comparison.ciUpper < 0 ? "  <- clears the gate" : ""}`,
  );
}

// ---------------------------------------------------------------------------
// C. Exponential time-decay weighting — the mechanism-directed fix
// ---------------------------------------------------------------------------
//
// §6.8 rejected HARD recency windows: 7 days was far worse (too few samples),
// 14/30/90 indistinguishable on a corpus then under 30 days wide. The
// qualitatively new evidence licensing a re-visit is A2/A3 above: a measured,
// monotone, within-group drift on a corpus now ~6 weeks wide. Exponential
// decay is the soft version of a window — every sample still contributes, so
// the tail never starves, but the fit tilts toward the present at a rate the
// half-life controls.

console.log("\nC. EXPONENTIAL TIME-DECAY WEIGHTED LADDER (half-life sweep, gated)\n");

function weightedQuantile(sortedPairs, totalWeight, probability) {
  // sortedPairs: [value, weight][] ascending by value.
  const target = probability * totalWeight;
  let cumulative = 0;
  for (const [value, weight] of sortedPairs) {
    cumulative += weight;
    if (cumulative >= target) return value;
  }
  return sortedPairs[sortedPairs.length - 1][0];
}
function makeWeightedBase(trainRows, halfLifeDays) {
  const tEnd = trainRows[trainRows.length - 1].timestampMs;
  const lambda = Math.LN2 / (halfLifeDays * 24 * 3600 * 1000);
  const weightOf = (row) => Math.exp(-lambda * (tEnd - row.timestampMs));
  const keys = [key.mtp, key.path, key.mt, key.model];
  const fitsPerKey = keys.map((keyFn) => {
    const grouped = new Map();
    for (const row of trainRows) {
      const groupKey = keyFn(row);
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
        QUANTILES.map((p) => Math.round(weightedQuantile(pairs, total, p))),
      );
    }
    return fitted;
  });
  const overallPairs = trainRows
    .map((row) => [row.outputTokens, weightOf(row)])
    .sort((a, b) => a[0] - b[0]);
  const overallTotal = overallPairs.reduce((s, [, w]) => s + w, 0);
  const overall = QUANTILES.map((p) =>
    Math.round(weightedQuantile(overallPairs, overallTotal, p)),
  );
  return (row) => {
    for (let index = 0; index < keys.length; index++) {
      const groupKey = keys[index](row);
      if (groupKey === null) continue;
      const found = fitsPerKey[index].get(groupKey);
      if (found) return found;
    }
    return overall;
  };
}

const HALF_LIVES = [7, 14, 28, 56];
report.decay = {};
for (const halfLife of HALF_LIVES) {
  const name = `decay${halfLife}d`;
  for (const fold of folds) {
    fold.__weighted = makeWeightedBase(fold.train, halfLife);
  }
  // records were pushed fold by fold in this same iteration order.
  let index = 0;
  for (const fold of folds) {
    for (const row of fold.test) {
      records[index][name] = fold.__weighted(row);
      index++;
    }
  }
  const m = metrics(name);
  const differences = records.map(
    (record) => totalLoss(record.row, record[name]) - totalLoss(record.row, record.shipped),
  );
  const comparison = blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
  report.decay[name] = { metrics: m, comparison };
  console.log(
    `  ${name.padEnd(10)} loss ${m.loss.toFixed(1)}  cov ${m.coverage.map(pct).join("/")}  ` +
      `widths ${m.width.map((w) => fmt(w)).join("/")}  ` +
      `diff ${comparison.meanDifference.toFixed(2)} [${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]` +
      `${comparison.ciUpper < 0 ? "  <- clears the gate" : ""}`,
  );
}

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

#!/usr/bin/env node
/**
 * Tests docs/GENERATIVE-MODEL.md §4 -- "action type is a 12x signal" -- and
 * §6 step 3, the mixture over action type.
 *
 * §4 is the largest claimed effect in the corpus, and it has never been through
 * the gates that rejected `effort` in §3. It is exposed to exactly the same
 * failure mode: `Write` had n=117 before the loader fix, and a tool used
 * heavily on one day would produce a large between-tool spread that is really a
 * between-day spread.
 *
 * So this runs, in order:
 *
 *   A. The naive contrast, reproduced.
 *   B. The STEP 0 gates: (day, model) support -> within-cell contrast ->
 *      replication across cells. Same code path as probe-effort-confound.mjs.
 *   C. Is pi_k(x) predictable at all? §8 says the mixture is worthless if the
 *      classifier is near chance. Multinomial logistic on strictly pre-call
 *      features, graded on rolling-origin holdouts.
 *   D. Does the mixture actually pay? Pinball loss against the marginal
 *      forecast, plus an ORACLE that is told the true action -- which bounds
 *      the prize and separates "the signal is small" from "our classifier is
 *      bad".
 *
 * Repo rule from STATE-OF-PLAY: a change only replaces the previous predictor
 * if it BEATS it on held-out data, and a difference inside the fold-to-fold
 * noise is not a win. Differences are therefore reported paired across folds.
 *
 * Privacy: aggregates only. No prompt or response text is retained.
 *
 * Usage:
 *   node experiments/evaluation/probe-action-type.mjs
 *     [--projects-dir <dir>] [--json <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultProjectsDir, loadRequests } from "./lib/load-history.mjs";
import {
  bootstrapLogRatioSe,
  fmt,
  heterogeneity,
  median,
  mulberry32,
  pct,
  pinball,
  quantile,
  stratifiedRankTest,
} from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue("--json", null);

const MIN_CLASS = 100; // the repo's minimum-sample floor
const QUANTILES = [0.5, 0.9, 0.99];
const NO_TOOL = "(no-tool)";
const OTHER_TOOL = "(other-tool)";

const day = (row) => new Date(row.timestampMs).toISOString().slice(0, 10);
const cellKey = (row) => `${day(row)}|${row.model}`;

const { rows: allRows, filesScanned } = await loadRequests(projectsDir);
const rows = allRows
  .filter((row) => Number.isFinite(row.timestampMs) && row.outputTokens > 0)
  .sort((a, b) => a.timestampMs - b.timestampMs);
const report = { generatedAt: new Date().toISOString(), source: projectsDir };

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls\n`,
);

// Action classes: the first tool the turn calls, floored at MIN_CLASS.
const firstToolCounts = new Map();
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  firstToolCounts.set(tool, (firstToolCounts.get(tool) ?? 0) + 1);
}
const CLASSES = [...firstToolCounts.entries()]
  .filter(([tool, count]) => count >= MIN_CLASS && tool !== NO_TOOL)
  .sort((a, b) => b[1] - a[1])
  .map(([tool]) => tool);
CLASSES.push(NO_TOOL, OTHER_TOOL);
const classIndex = new Map(CLASSES.map((name, i) => [name, i]));
const actionOf = (row) => {
  const tool = row.tools[0] ?? NO_TOOL;
  return classIndex.has(tool) ? tool : OTHER_TOOL;
};
for (const row of rows) row.action = actionOf(row);

// ---------------------------------------------------------------------------
// A. The naive contrast
// ---------------------------------------------------------------------------

console.log("A. NAIVE CONTRAST BY FIRST TOOL (reproduces §4)\n");
report.naive = {};
const byAction = new Map();
for (const row of rows) {
  if (!byAction.has(row.action)) byAction.set(row.action, []);
  byAction.get(row.action).push(row.outputTokens);
}
for (const name of CLASSES) {
  const values = byAction.get(name);
  if (!values) continue;
  report.naive[name] = {
    n: values.length,
    p50: median(values),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
  };
  console.log(
    `  ${name.padEnd(14)} n=${String(values.length).padStart(6)}` +
      `  p50=${fmt(median(values)).padStart(7)}` +
      `  p90=${fmt(quantile(values, 0.9)).padStart(7)}` +
      `  p99=${fmt(quantile(values, 0.99)).padStart(8)}`,
  );
}
const medians = CLASSES.map((name) => report.naive[name]?.p50).filter(Boolean);
const spread = Math.max(...medians) / Math.min(...medians);
console.log(`\n  median spread across classes: ${spread.toFixed(1)}x`);
report.naiveSpread = spread;

// ---------------------------------------------------------------------------
// B. The STEP 0 gates
// ---------------------------------------------------------------------------

const REFERENCE = CLASSES[0]; // the most common action
console.log(`\nB. THE STEP 0 GATES, vs ${REFERENCE} (day and model held fixed)\n`);

const cells = new Map();
for (const row of rows) {
  const key = cellKey(row);
  if (!cells.has(key)) cells.set(key, new Map());
  const byClass = cells.get(key);
  if (!byClass.has(row.action)) byClass.set(row.action, []);
  byClass.get(row.action).push(row.outputTokens);
}

console.log(
  `  ${"action".padEnd(14)}${"days".padStart(6)}${"cells".padStart(7)}` +
    `${"shared".padStart(8)}${"effect".padStart(9)}${"z".padStart(9)}` +
    `${"ratio".padStart(9)}${"naive".padStart(9)}${"  Q p".padStart(10)}${"  I2".padStart(8)}` +
    `${"sign".padStart(9)}${"sign p".padStart(10)}`,
);
const bootstrapRandom = mulberry32(20260803);
report.gates = {};
for (const name of CLASSES) {
  if (name === REFERENCE) continue;
  const strata = [];
  const logRatios = [];
  const estimates = [];
  const daysSeen = new Set();
  let cellCount = 0;
  for (const [key, byClass] of cells) {
    const treated = byClass.get(name);
    if (!treated) continue;
    cellCount++;
    daysSeen.add(key.split("|")[0]);
    const control = byClass.get(REFERENCE);
    if (!control) continue;
    strata.push({ treated, control });
    if (treated.length >= 10 && control.length >= 10) {
      logRatios.push({
        weight: Math.min(treated.length, control.length),
        value: Math.log(median(treated) / median(control)),
      });
    }
    if (treated.length >= 8 && control.length >= 8) {
      const se = bootstrapLogRatioSe(treated, control, bootstrapRandom, 600);
      if (se && se > 0) {
        estimates.push({ theta: Math.log(median(treated) / median(control)), se });
      }
    }
  }
  const test = stratifiedRankTest(strata);
  if (!test) {
    console.log(`  ${name.padEnd(14)} not comparable in any cell`);
    report.gates[name] = { comparable: false };
    continue;
  }
  // Cochran's Q asks whether the effect SIZE is constant. With 50 cells that
  // is a stiff question and a rejection says little -- magnitudes vary. The
  // question that separates a real effect from `effort=xhigh` is whether the
  // effect keeps its SIGN. A sign test across cells answers that directly.
  const signs = logRatios.filter((r) => r.value !== 0);
  const positive = signs.filter((r) => r.value > 0).length;
  const agreeing = Math.max(positive, signs.length - positive);
  // Two-sided binomial tail against p=0.5, computed exactly.
  let tail = 0;
  for (let i = agreeing; i <= signs.length; i++) {
    let logChoose = 0;
    for (let j = 0; j < i; j++) {
      logChoose += Math.log(signs.length - j) - Math.log(j + 1);
    }
    tail += Math.exp(logChoose + signs.length * Math.log(0.5));
  }
  const signP = Math.min(1, 2 * tail);
  const totalWeight = logRatios.reduce((s, r) => s + r.weight, 0);
  const ratio = totalWeight
    ? Math.exp(logRatios.reduce((s, r) => s + r.weight * r.value, 0) / totalWeight)
    : null;
  const naive = report.naive[name].p50 / report.naive[REFERENCE].p50;
  const het = heterogeneity(estimates);
  console.log(
    `  ${name.padEnd(14)}${String(daysSeen.size).padStart(6)}` +
      `${String(cellCount).padStart(7)}${String(test.strataUsed).padStart(8)}` +
      `${test.effect.toFixed(3).padStart(9)}${test.z.toFixed(2).padStart(9)}` +
      `${(ratio ? `${ratio.toFixed(2)}x` : "n/a").padStart(9)}` +
      `${`${naive.toFixed(2)}x`.padStart(9)}` +
      `${(het.testable ? (het.p < 1e-4 ? "<0.0001" : het.p.toFixed(4)) : "n/a").padStart(10)}` +
      `${(het.testable ? pct(het.iSquared) : "n/a").padStart(8)}` +
      `${(signs.length ? `${agreeing}/${signs.length}` : "n/a").padStart(9)}` +
      `${(signs.length ? (signP < 1e-4 ? "<0.0001" : signP.toFixed(4)) : "n/a").padStart(10)}`,
  );
  report.gates[name] = {
    comparable: true,
    days: daysSeen.size,
    cells: cellCount,
    sharedCells: test.strataUsed,
    effect: test.effect,
    z: test.z,
    withinCellRatio: ratio,
    naiveRatio: naive,
    heterogeneity: het,
    signAgreement: signs.length ? agreeing / signs.length : null,
    signCells: signs.length,
    signP: signs.length ? signP : null,
  };
}
console.log(
  "\n  effect = P(Y_action > Y_reference) within a shared cell; 0.50 = no difference.",
);
console.log(
  "  Q p tests whether the effect SIZE is constant across cells; `sign` tests",
);
console.log(
  "  whether it keeps its DIRECTION. `effort=xhigh` failed both on 2 cells.",
);
console.log(
  "  Failing Q while passing sign on ~50 cells means the magnitude varies but",
);
console.log("  the effect is always there -- which is what a real signal looks like.");

// ---------------------------------------------------------------------------
// C. Is pi_k(x) predictable from strictly pre-call features?
// ---------------------------------------------------------------------------

console.log("\nC. IS pi_k(x) PREDICTABLE? (multinomial logistic, pre-call features only)\n");

// Build per-session sequences so "previous call" features are legal.
const sessions = new Map();
for (const row of rows) {
  const key = row.sessionId ?? "(none)";
  if (!sessions.has(key)) sessions.set(key, []);
  sessions.get(key).push(row);
}
for (const session of sessions.values()) {
  session.sort((a, b) => a.timestampMs - b.timestampMs);
  let loopDepth = 0;
  let previous = null;
  for (const row of session) {
    row.feat = {
      prevAction: previous ? previous.action : "(start)",
      prevStop: previous ? (previous.stopReason ?? "(null)") : "(start)",
      loopDepth: Math.min(loopDepth, 5),
      logPrevY: previous ? Math.log(previous.outputTokens) : 0,
      hasPrev: previous ? 1 : 0,
      model: row.model,
    };
    // stop_reason of the PREVIOUS call is known; this call's is not.
    loopDepth = previous && previous.stopReason === "tool_use" ? loopDepth + 1 : 0;
    previous = row;
  }
}

const CATEGORICALS = [
  ["prevAction", [...CLASSES, "(start)"]],
  ["prevStop", ["tool_use", "end_turn", "max_tokens", "(null)", "(start)"]],
  ["loopDepth", [0, 1, 2, 3, 4, 5]],
  ["model", [...new Set(rows.map((r) => r.model))]],
];
const featureNames = [];
for (const [field, values] of CATEGORICALS) {
  for (const value of values) featureNames.push(`${field}=${value}`);
}
featureNames.push("logPrevY", "hasPrev", "bias");

function encode(row) {
  const vector = new Float64Array(featureNames.length);
  let offset = 0;
  for (const [field, values] of CATEGORICALS) {
    const index = values.indexOf(row.feat[field]);
    if (index >= 0) vector[offset + index] = 1;
    offset += values.length;
  }
  vector[offset] = row.feat.logPrevY / 8; // roughly unit-scaled
  vector[offset + 1] = row.feat.hasPrev;
  vector[offset + 2] = 1;
  return vector;
}

function trainSoftmax(trainRows, iterations = 250, l2 = 1e-4) {
  const p = featureNames.length;
  const k = CLASSES.length;
  const W = Array.from({ length: k }, () => new Float64Array(p));
  const mAdam = Array.from({ length: k }, () => new Float64Array(p));
  const vAdam = Array.from({ length: k }, () => new Float64Array(p));
  const encoded = trainRows.map(encode);
  const labels = trainRows.map((row) => classIndex.get(row.action));
  const n = trainRows.length;
  const lr = 0.25;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const grad = Array.from({ length: k }, () => new Float64Array(p));
    for (let i = 0; i < n; i++) {
      const x = encoded[i];
      const logits = new Float64Array(k);
      let maxLogit = -Infinity;
      for (let c = 0; c < k; c++) {
        let sum = 0;
        for (let j = 0; j < p; j++) if (x[j] !== 0) sum += W[c][j] * x[j];
        logits[c] = sum;
        if (sum > maxLogit) maxLogit = sum;
      }
      let denominator = 0;
      for (let c = 0; c < k; c++) {
        logits[c] = Math.exp(logits[c] - maxLogit);
        denominator += logits[c];
      }
      for (let c = 0; c < k; c++) {
        const error = logits[c] / denominator - (labels[i] === c ? 1 : 0);
        if (error === 0) continue;
        for (let j = 0; j < p; j++) if (x[j] !== 0) grad[c][j] += error * x[j];
      }
    }
    const beta1 = 0.9;
    const beta2 = 0.999;
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < p; j++) {
        const g = grad[c][j] / n + l2 * W[c][j];
        mAdam[c][j] = beta1 * mAdam[c][j] + (1 - beta1) * g;
        vAdam[c][j] = beta2 * vAdam[c][j] + (1 - beta2) * g * g;
        const mHat = mAdam[c][j] / (1 - beta1 ** iteration);
        const vHat = vAdam[c][j] / (1 - beta2 ** iteration);
        W[c][j] -= (lr * mHat) / (Math.sqrt(vHat) + 1e-8);
      }
    }
  }
  return W;
}

function predictProbabilities(W, row) {
  const x = encode(row);
  const k = CLASSES.length;
  const logits = new Float64Array(k);
  let maxLogit = -Infinity;
  for (let c = 0; c < k; c++) {
    let sum = 0;
    for (let j = 0; j < x.length; j++) if (x[j] !== 0) sum += W[c][j] * x[j];
    logits[c] = sum;
    if (sum > maxLogit) maxLogit = sum;
  }
  let denominator = 0;
  for (let c = 0; c < k; c++) {
    logits[c] = Math.exp(logits[c] - maxLogit);
    denominator += logits[c];
  }
  for (let c = 0; c < k; c++) logits[c] /= denominator;
  return logits;
}

// Rolling-origin folds: the last 20% split into 5 contiguous blocks.
const holdoutStart = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - holdoutStart) / 5);
const folds = [];
for (let f = 0; f < 5; f++) {
  const start = holdoutStart + f * blockSize;
  const end = f === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

// ---------------------------------------------------------------------------
// D. Does the mixture pay?
// ---------------------------------------------------------------------------

function empiricalSorted(values) {
  return Float64Array.from(values).sort();
}
function cdfAt(sorted, y) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= y) low = mid + 1;
    else high = mid;
  }
  return low / sorted.length;
}
function invertMixture(candidates, componentSorted, weights, p) {
  let low = 0;
  let high = candidates.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    let f = 0;
    for (let c = 0; c < weights.length; c++) {
      if (weights[c] === 0 || !componentSorted[c]) continue;
      f += weights[c] * cdfAt(componentSorted[c], candidates[mid]);
    }
    if (f >= p) high = mid;
    else low = mid + 1;
  }
  return candidates[low];
}

const foldResults = [];
for (const [index, fold] of folds.entries()) {
  const W = trainSoftmax(fold.train);

  // Component distributions and the marginal, both fitted on train only.
  const componentValues = new Map();
  for (const row of fold.train) {
    if (!componentValues.has(row.action)) componentValues.set(row.action, []);
    componentValues.get(row.action).push(row.outputTokens);
  }
  const componentSorted = CLASSES.map((name) => {
    const values = componentValues.get(name);
    return values && values.length >= MIN_CLASS ? empiricalSorted(values) : null;
  });
  const marginalSorted = empiricalSorted(fold.train.map((r) => r.outputTokens));
  const marginalQ = QUANTILES.map((p) => quantile(fold.train.map((r) => r.outputTokens), p));
  const candidates = Float64Array.from(
    new Set(fold.train.map((r) => r.outputTokens)),
  ).sort();

  // Class priors on train, used to renormalise when a component is too thin.
  const priors = new Float64Array(CLASSES.length);
  for (const row of fold.train) priors[classIndex.get(row.action)]++;
  for (let c = 0; c < priors.length; c++) priors[c] /= fold.train.length;

  let lossMarginal = 0;
  let lossMixture = 0;
  let lossOracle = 0;
  let logLossModel = 0;
  let logLossBaseline = 0;
  let correct = 0;
  let correctBaseline = 0;
  const majority = priors.indexOf(Math.max(...priors));

  for (const row of fold.test) {
    const y = row.outputTokens;
    const probabilities = predictProbabilities(W, row);
    const trueClass = classIndex.get(row.action);

    logLossModel -= Math.log(Math.max(probabilities[trueClass], 1e-12));
    logLossBaseline -= Math.log(Math.max(priors[trueClass], 1e-12));
    if (probabilities.indexOf(Math.max(...probabilities)) === trueClass) correct++;
    if (majority === trueClass) correctBaseline++;

    // Renormalise over components that actually have a fitted distribution;
    // mass on thin classes falls back to the marginal.
    const weights = new Float64Array(CLASSES.length);
    let usable = 0;
    for (let c = 0; c < CLASSES.length; c++) {
      if (componentSorted[c]) {
        weights[c] = probabilities[c];
        usable += probabilities[c];
      }
    }
    for (const [i, p] of QUANTILES.entries()) {
      lossMarginal += pinball(y, marginalQ[i], p);

      let mixtureForecast;
      if (usable < 0.5) {
        mixtureForecast = marginalQ[i];
      } else {
        const normalised = new Float64Array(CLASSES.length);
        for (let c = 0; c < CLASSES.length; c++) normalised[c] = weights[c] / usable;
        mixtureForecast = invertMixture(candidates, componentSorted, normalised, p);
      }
      lossMixture += pinball(y, mixtureForecast, p);

      const oracleSorted = componentSorted[trueClass];
      const oracleForecast = oracleSorted
        ? oracleSorted[
            Math.min(
              oracleSorted.length - 1,
              Math.max(0, Math.round((oracleSorted.length - 1) * p)),
            )
          ]
        : marginalQ[i];
      lossOracle += pinball(y, oracleForecast, p);
    }
  }

  const n = fold.test.length;
  foldResults.push({
    fold: index + 1,
    n,
    marginal: lossMarginal / n,
    mixture: lossMixture / n,
    oracle: lossOracle / n,
    logLossModel: logLossModel / n,
    logLossBaseline: logLossBaseline / n,
    accuracy: correct / n,
    accuracyBaseline: correctBaseline / n,
  });
}

console.log(
  `  ${"fold".padEnd(6)}${"n".padStart(6)}${"logloss".padStart(10)}` +
    `${"baseline".padStart(10)}${"acc".padStart(8)}${"base acc".padStart(10)}`,
);
for (const r of foldResults) {
  console.log(
    `  ${String(r.fold).padEnd(6)}${String(r.n).padStart(6)}` +
      `${r.logLossModel.toFixed(3).padStart(10)}${r.logLossBaseline.toFixed(3).padStart(10)}` +
      `${pct(r.accuracy).padStart(8)}${pct(r.accuracyBaseline).padStart(10)}`,
  );
}
const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const sd = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};
const logLossGain =
  mean(foldResults.map((r) => r.logLossBaseline - r.logLossModel));
console.log(
  `\n  mean log loss: model ${mean(foldResults.map((r) => r.logLossModel)).toFixed(3)}` +
    ` vs baseline ${mean(foldResults.map((r) => r.logLossBaseline)).toFixed(3)}` +
    `  (improvement ${logLossGain.toFixed(3)} nats)`,
);
console.log(
  `  mean accuracy: model ${pct(mean(foldResults.map((r) => r.accuracy)))}` +
    ` vs majority ${pct(mean(foldResults.map((r) => r.accuracyBaseline)))}`,
);
report.classifier = {
  folds: foldResults.map((r) => ({
    fold: r.fold,
    logLossModel: r.logLossModel,
    logLossBaseline: r.logLossBaseline,
    accuracy: r.accuracy,
    accuracyBaseline: r.accuracyBaseline,
  })),
  meanLogLossGain: logLossGain,
};

console.log("\nD. DOES THE MIXTURE PAY? (mean pinball per call, lower is better)\n");
console.log(
  `  ${"fold".padEnd(6)}${"marginal".padStart(11)}${"mixture".padStart(11)}` +
    `${"oracle".padStart(11)}${"mix-marg".padStart(11)}${"oracle-marg".padStart(13)}`,
);
for (const r of foldResults) {
  console.log(
    `  ${String(r.fold).padEnd(6)}${r.marginal.toFixed(1).padStart(11)}` +
      `${r.mixture.toFixed(1).padStart(11)}${r.oracle.toFixed(1).padStart(11)}` +
      `${(r.mixture - r.marginal).toFixed(1).padStart(11)}` +
      `${(r.oracle - r.marginal).toFixed(1).padStart(13)}`,
  );
}
const mixDiff = foldResults.map((r) => r.mixture - r.marginal);
const oracleDiff = foldResults.map((r) => r.oracle - r.marginal);
const se = (values) => sd(values) / Math.sqrt(values.length);
console.log(
  `\n  mixture vs marginal: ${mean(mixDiff).toFixed(2)} +/- ${se(mixDiff).toFixed(2)}` +
    ` (paired SE)  t=${(mean(mixDiff) / se(mixDiff)).toFixed(2)}` +
    `${mean(mixDiff) < 0 ? "   <- improvement" : "   <- WORSE"}`,
);
console.log(
  `  oracle  vs marginal: ${mean(oracleDiff).toFixed(2)} +/- ${se(oracleDiff).toFixed(2)}` +
    ` (paired SE)  t=${(mean(oracleDiff) / se(oracleDiff)).toFixed(2)}`,
);
const captured =
  mean(oracleDiff) !== 0 ? mean(mixDiff) / mean(oracleDiff) : 0;
console.log(
  `\n  The oracle bounds the prize: knowing the action exactly is worth` +
    ` ${Math.abs(mean(oracleDiff)).toFixed(1)} pinball/call.`,
);
console.log(
  `  The classifier captures ${pct(Math.max(0, captured))} of that bound.`,
);
report.mixture = {
  folds: foldResults.map((r) => ({
    fold: r.fold,
    marginal: r.marginal,
    mixture: r.mixture,
    oracle: r.oracle,
  })),
  mixtureVsMarginal: { mean: mean(mixDiff), se: se(mixDiff) },
  oracleVsMarginal: { mean: mean(oracleDiff), se: se(oracleDiff) },
  shareOfOracleCaptured: captured,
};

if (jsonOut) {
  await mkdir(path.dirname(jsonOut), { recursive: true });
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}

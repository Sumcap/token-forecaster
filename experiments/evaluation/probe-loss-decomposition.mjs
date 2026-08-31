#!/usr/bin/env node
/**
 * STEP 3: where does the width actually come from?
 *
 * Before adding any more features, decompose the held-out pinball the shipped
 * predictor already pays: by quantile level, by group, and -- most usefully --
 * by individual call. "Total pinball 535" is an average over 2,800 calls whose
 * individual losses span four orders of magnitude, and an average that shape is
 * not describing a typical call. It is describing a handful of them.
 *
 * Three questions, in order:
 *   A. Which of the three quantile levels carries the loss?
 *   B. Which of the 10 shipped groups carries the TOTAL loss (not the mean --
 *      a tiny group with a terrible mean cannot be the thing to fix), and is it
 *      p50, p90 or p99 driving that group?
 *   C. Which individual held-out calls cost the most, and what do they look
 *      like? Aggregates cannot tell you whether the loss is a broad fog or a
 *      few catastrophic misses; only the worst-miss table can.
 *
 * Privacy: aggregates and per-call METADATA only -- model, thinking flag, tool
 * name, loop depth, token counts. No prompt or response text is read or stored.
 *
 * Usage:
 *   node experiments/evaluation/probe-loss-decomposition.mjs
 *     [--projects-dir <dir>] [--json <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  redactHome,
} from "./lib/load-history.mjs";
import { fmt, median, pct, pinball, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/loss-decomposition-probe.json"),
);

const MIN_GROUP = 100;
const QUANTILES = [0.5, 0.9, 0.99];
const LEVEL_NAMES = ["p50", "p90", "p99"];
const NO_TOOL = "(no-tool)";
const OTHER_TOOL = "(other-tool)";

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;

const { rows: allRows, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
});
const rows = allRows
  .filter((row) => Number.isFinite(row.timestampMs) && row.outputTokens > 0)
  .sort((a, b) => a.timestampMs - b.timestampMs);
const report = { generatedAt: new Date().toISOString(), source: redactHome(projectsDir) };

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls\n`,
);

const firstToolCounts = new Map();
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  firstToolCounts.set(tool, (firstToolCounts.get(tool) ?? 0) + 1);
}
const knownTools = new Set(
  [...firstToolCounts.entries()]
    .filter(([tool, count]) => count >= MIN_GROUP && tool !== NO_TOOL)
    .map(([tool]) => tool),
);
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
  const tool = row.tools[0] ?? NO_TOOL;
  row.action = tool === NO_TOOL ? NO_TOOL : knownTools.has(tool) ? tool : OTHER_TOOL;
}

// The shipped predictor, rebuilt per fold: model+thinking+promptPath, backing
// off through pooled promptPath, model+thinking, model, then overall, with the
// same 100-sample floor the profile ships with. A missing prompt skips both
// path rungs; unknown is not the `no` level.
const keyOf = (row) => `model=${row.model}|thinking=${row.thinking}`;
const modelKeyOf = (row) => `model=${row.model}`;
const promptPathKeyOf = (row) =>
  row.promptPath === null ? null : `promptPath=${row.promptPath}`;
const jointPromptPathKeyOf = (row) => {
  const prompt = promptPathKeyOf(row);
  return prompt === null ? null : `${keyOf(row)}|${prompt}`;
};

function fitShipped(trainRows) {
  const buckets = new Map();
  const add = (key, value) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(value);
  };
  for (const row of trainRows) {
    add("overall", row.outputTokens);
    add(modelKeyOf(row), row.outputTokens);
    add(keyOf(row), row.outputTokens);
    const prompt = promptPathKeyOf(row);
    const joint = jointPromptPathKeyOf(row);
    if (prompt !== null) add(prompt, row.outputTokens);
    if (joint !== null) add(joint, row.outputTokens);
  }
  const fits = new Map();
  for (const [key, sample] of buckets) {
    if (sample.length < MIN_GROUP) continue;
    const sorted = [...sample].sort((a, b) => a - b);
    fits.set(key, {
      key,
      q: QUANTILES.map((p) => Math.round(quantile(sorted, p))),
    });
  }
  const fallback = fits.get("overall");
  return (row) => {
    const prompt = promptPathKeyOf(row);
    const joint = jointPromptPathKeyOf(row);
    return (
      (joint === null ? undefined : fits.get(joint)) ??
      (prompt === null ? undefined : fits.get(prompt)) ??
      fits.get(keyOf(row)) ??
      fits.get(modelKeyOf(row)) ??
      fallback
    );
  };
}

const holdoutStart = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - holdoutStart) / 5);
const folds = [];
for (let f = 0; f < 5; f++) {
  const start = holdoutStart + f * blockSize;
  const end = f === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const scored = [];
for (const [foldIndex, fold] of folds.entries()) {
  const predict = fitShipped(fold.train);
  for (const row of fold.test) {
    const fit = predict(row);
    const losses = QUANTILES.map((p, i) => pinball(row.outputTokens, fit.q[i], p));
    scored.push({
      row,
      foldIndex,
      groupKey: fit.key,
      forecast: fit.q,
      losses,
      total: losses.reduce((s, v) => s + v, 0),
    });
  }
}
const grandTotal = scored.reduce((s, entry) => s + entry.total, 0);
console.log(
  `Held out: ${fmt(scored.length)} calls across 5 rolling-origin folds,` +
    ` mean total pinball ${(grandTotal / scored.length).toFixed(1)}/call\n`,
);

// ---------------------------------------------------------------------------
// A. By quantile level.
// ---------------------------------------------------------------------------

console.log("A. WHERE THE LOSS SITS, BY QUANTILE LEVEL\n");
console.log(
  `  ${"level".padEnd(7)}${"mean loss".padStart(11)}${"share".padStart(9)}` +
    `${"coverage".padStart(11)}${"target".padStart(9)}${"over-forecast".padStart(15)}${"under".padStart(9)}`,
);
report.byLevel = [];
for (const [i, p] of QUANTILES.entries()) {
  const levelTotal = scored.reduce((s, entry) => s + entry.losses[i], 0);
  const covered = scored.filter((entry) => entry.row.outputTokens <= entry.forecast[i]).length;
  // Pinball is asymmetric, so "which side is the loss on" is not the same
  // question as "is coverage right". A p90 can be perfectly calibrated and still
  // pay nearly all its loss on the few calls that overshoot it.
  const overShare =
    scored
      .filter((entry) => entry.row.outputTokens <= entry.forecast[i])
      .reduce((s, entry) => s + entry.losses[i], 0) / levelTotal;
  console.log(
    `  ${LEVEL_NAMES[i].padEnd(7)}${(levelTotal / scored.length).toFixed(1).padStart(11)}` +
      `${pct(levelTotal / grandTotal).padStart(9)}` +
      `${pct(covered / scored.length).padStart(11)}${pct(p).padStart(9)}` +
      `${pct(overShare).padStart(15)}${pct(1 - overShare).padStart(9)}`,
  );
  report.byLevel.push({
    level: LEVEL_NAMES[i],
    meanLoss: levelTotal / scored.length,
    share: levelTotal / grandTotal,
    coverage: covered / scored.length,
    target: p,
    lossShareFromOverForecast: overShare,
  });
}
console.log(
  "\n  `over-forecast` is the share of that level's loss paid on calls the forecast",
);
console.log(
  "  covered -- wasted reservation. `under` is the share paid on calls it missed.",
);

// ---------------------------------------------------------------------------
// B. By group, in TOTAL loss.
// ---------------------------------------------------------------------------

console.log("\n\nB. WHICH GROUP CARRIES THE TOTAL LOSS\n");
const byGroup = new Map();
for (const entry of scored) {
  if (!byGroup.has(entry.groupKey)) byGroup.set(entry.groupKey, []);
  byGroup.get(entry.groupKey).push(entry);
}
const groupRows = [...byGroup.entries()]
  .map(([key, entries]) => {
    const total = entries.reduce((s, e) => s + e.total, 0);
    return {
      key,
      n: entries.length,
      total,
      share: total / grandTotal,
      meanLoss: total / entries.length,
      levels: QUANTILES.map(
        (_, i) => entries.reduce((s, e) => s + e.losses[i], 0) / total,
      ),
      worstLevel:
        LEVEL_NAMES[
          QUANTILES.map((_, i) => entries.reduce((s, e) => s + e.losses[i], 0)).indexOf(
            Math.max(
              ...QUANTILES.map((_, i) => entries.reduce((s, e) => s + e.losses[i], 0)),
            ),
          )
        ],
    };
  })
  .sort((a, b) => b.total - a.total);
console.log(
  `  ${"group".padEnd(36)}${"n".padStart(6)}${"share of loss".padStart(15)}` +
    `${"mean/call".padStart(11)}${"p50".padStart(8)}${"p90".padStart(8)}${"p99".padStart(8)}  driver`,
);
for (const group of groupRows) {
  console.log(
    `  ${group.key.padEnd(36)}${String(group.n).padStart(6)}` +
      `${pct(group.share).padStart(15)}${group.meanLoss.toFixed(0).padStart(11)}` +
      group.levels.map((v) => pct(v).padStart(8)).join("") +
      `  ${group.worstLevel}`,
  );
}
report.byGroup = groupRows;
console.log(
  "\n  Share of loss is what a fix is worth; mean/call is how bad the group is.",
);
console.log(
  "  They rank differently, and the first column is the one that pays.",
);

// ---------------------------------------------------------------------------
// C. The worst individual misses.
// ---------------------------------------------------------------------------

console.log("\n\nC. WORST INDIVIDUAL HELD-OUT CALLS (largest pinball contribution)\n");
const worst = [...scored].sort((a, b) => b.total - a.total).slice(0, 25);
const worstShare = worst.reduce((s, e) => s + e.total, 0) / grandTotal;
console.log(
  `  ${"#".padEnd(4)}${"model".padEnd(18)}${"think".padEnd(7)}${"first tool".padEnd(13)}` +
    `${"depth".padStart(6)}${"actual".padStart(9)}${"p50".padStart(8)}${"p90".padStart(8)}` +
    `${"p99".padStart(8)}${"loss".padStart(9)}${"share".padStart(8)}`,
);
report.worstMisses = [];
for (const [index, entry] of worst.entries()) {
  const model = entry.row.model.replace(/^claude-/, "");
  console.log(
    `  ${String(index + 1).padEnd(4)}${model.padEnd(18)}${entry.row.thinking.padEnd(7)}` +
      `${entry.row.action.padEnd(13)}${String(entry.row.loopDepth).padStart(6)}` +
      `${fmt(entry.row.outputTokens).padStart(9)}` +
      entry.forecast.map((q) => fmt(q).padStart(8)).join("") +
      `${fmt(entry.total).padStart(9)}${pct(entry.total / grandTotal).padStart(8)}`,
  );
  report.worstMisses.push({
    rank: index + 1,
    model: entry.row.model,
    thinking: entry.row.thinking,
    firstTool: entry.row.action,
    loopDepth: entry.row.loopDepth,
    loopDepthExact: entry.row.loopDepthExact,
    actual: entry.row.outputTokens,
    forecast: entry.forecast,
    groupKey: entry.groupKey,
    loss: entry.total,
    shareOfTotal: entry.total / grandTotal,
  });
}
console.log(
  `\n  These 25 calls -- ${pct(25 / scored.length)} of the holdout -- carry ${pct(worstShare)} of all pinball paid.`,
);

// How concentrated is the loss? A forecaster whose error is a broad fog needs
// better features; one whose error is 30 calls needs a better tail.
const sortedLosses = [...scored].map((e) => e.total).sort((a, b) => b - a);
report.concentration = {};
console.log("\n  Concentration of the total loss:");
for (const share of [0.01, 0.05, 0.1, 0.25, 0.5]) {
  const count = Math.max(1, Math.round(scored.length * share));
  const carried = sortedLosses.slice(0, count).reduce((s, v) => s + v, 0) / grandTotal;
  console.log(
    `    worst ${pct(share).padStart(5)} of calls (${String(count).padStart(4)}) carry ${pct(carried)} of the loss`,
  );
  report.concentration[share] = carried;
}

// What do the worst calls have in common? Compare their composition to the
// holdout's, so "Write is over-represented" is a claim with a denominator.
console.log("\n  Composition of the worst 5% vs the whole holdout:\n");
const worstCount = Math.round(scored.length * 0.05);
const worstSet = new Set([...scored].sort((a, b) => b.total - a.total).slice(0, worstCount));
const composition = (accessor, label) => {
  const overall = new Map();
  const inWorst = new Map();
  for (const entry of scored) {
    const key = accessor(entry);
    overall.set(key, (overall.get(key) ?? 0) + 1);
    if (worstSet.has(entry)) inWorst.set(key, (inWorst.get(key) ?? 0) + 1);
  }
  const table = [...overall.entries()]
    .map(([key, count]) => ({
      key,
      share: count / scored.length,
      worstShare: (inWorst.get(key) ?? 0) / worstCount,
      lift: (inWorst.get(key) ?? 0) / worstCount / (count / scored.length),
    }))
    .sort((a, b) => b.lift - a.lift);
  console.log(`    ${label}`);
  console.log(
    `      ${"value".padEnd(16)}${"holdout".padStart(9)}${"worst 5%".padStart(10)}${"lift".padStart(8)}`,
  );
  for (const t of table) {
    if (t.share < 0.01) continue;
    console.log(
      `      ${String(t.key).padEnd(16)}${pct(t.share).padStart(9)}` +
        `${pct(t.worstShare).padStart(10)}${`${t.lift.toFixed(2)}x`.padStart(8)}`,
    );
  }
  return table;
};
report.worstComposition = {
  thinking: composition((e) => e.row.thinking, "by thinking"),
  firstTool: composition((e) => e.row.action, "by first tool"),
  loopDepth: composition(
    (e) => (e.row.loopDepthExact ? `d${Math.min(e.row.loopDepth, 6)}` : "(unknown)"),
    "by loop depth",
  ),
};

// The counterfactual the table implies: if the biggest single lever is the tool,
// how much of the worst-case loss would knowing it actually remove?
// The joint cell has to be allowed to back off to the action alone. `Write` is
// 3% of calls, so model x thinking x Write is below the 100-sample floor in
// every fold -- an oracle restricted to the joint cell would be told the answer
// and then forbidden from using it, which measures the floor, not the signal.
const oracleFits = new Map();
for (const [foldIndex, fold] of folds.entries()) {
  const buckets = new Map();
  const add = (key, value) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(value);
  };
  for (const row of fold.train) {
    add(`${keyOf(row)}|action=${row.action}`, row.outputTokens);
    add(`action=${row.action}`, row.outputTokens);
  }
  for (const [key, sample] of buckets) {
    if (sample.length < MIN_GROUP) continue;
    const sorted = [...sample].sort((a, b) => a - b);
    oracleFits.set(
      `${foldIndex}|${key}`,
      QUANTILES.map((p) => Math.round(quantile(sorted, p))),
    );
  }
}
let oracleWorstLoss = 0;
let shippedWorstLoss = 0;
let oracleUsedJoint = 0;
let oracleUsedAction = 0;
for (const entry of worstSet) {
  const joint = oracleFits.get(
    `${entry.foldIndex}|${keyOf(entry.row)}|action=${entry.row.action}`,
  );
  const actionOnly = oracleFits.get(`${entry.foldIndex}|action=${entry.row.action}`);
  if (joint) oracleUsedJoint++;
  else if (actionOnly) oracleUsedAction++;
  const forecast = joint ?? actionOnly ?? entry.forecast;
  oracleWorstLoss += QUANTILES.reduce(
    (s, p, i) => s + pinball(entry.row.outputTokens, forecast[i], p),
    0,
  );
  shippedWorstLoss += entry.total;
}
console.log(
  `\n  On those worst 5%, an oracle told the true tool would pay ${fmt(oracleWorstLoss / worstCount)}/call` +
    ` against the shipped ${fmt(shippedWorstLoss / worstCount)}/call` +
    ` (${pct(1 - oracleWorstLoss / shippedWorstLoss)} less).`,
);
console.log(
  `  (${oracleUsedJoint} of those used a model x thinking x action cell;` +
    ` ${oracleUsedAction} had to back off to the action alone.)`,
);
report.worstOracle = {
  n: worstCount,
  shippedMean: shippedWorstLoss / worstCount,
  oracleMean: oracleWorstLoss / worstCount,
  reduction: 1 - oracleWorstLoss / shippedWorstLoss,
  usedJointCell: oracleUsedJoint,
  usedActionOnly: oracleUsedAction,
};

console.log(
  `\n  For scale: the holdout's own median output is ${fmt(median(scored.map((e) => e.row.outputTokens)))} tokens` +
    ` and its p99 is ${fmt(quantile(scored.map((e) => e.row.outputTokens), 0.99))}.`,
);
console.log(
  `  Mean loss on the worst 5% is ${(shippedWorstLoss / worstCount / (grandTotal / scored.length)).toFixed(0)}x the holdout average.`,
);

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

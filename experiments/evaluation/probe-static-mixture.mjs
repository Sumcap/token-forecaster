#!/usr/bin/env node
/**
 * The untested middle ground of §6.12: a STATIC action-type mixture.
 *
 * §6.12 measured the action mixture with per-call classifier weights (captures
 * ~2% of the oracle) and with oracle weights (-112.6 vs the marginal), and
 * shipped nothing because weights are not knowable per call. What was never
 * tried: FIXED weights — the train-corpus action shares within each
 * (model, thinking) group — blending per-action outcome distributions that are
 * pooled across groups. Fully cold-start: the mixture quantiles are baked into
 * the profile at generation time, the caller passes nothing new.
 *
 * Why it could beat the pooled empirical quantiles it replaces: a thin
 * (model, thinking) cell sees few `Write` calls, so its own p99 wobbles; the
 * pooled per-action components estimate each tail once over the whole corpus,
 * and the group only contributes its (well-estimated) action MIX. Same reason
 * the pooled action rung fixed the oracle in §4.2a.
 *
 * The narrow question (from NEXT-PROMPT task 5): does the blend buy a narrower
 * P99-P50 band at equal coverage vs the pooled empirical tail? If not, §6.12
 * closes permanently with this number.
 *
 * Variants:
 *   mixAll   p50/p90/p99 all read off the blended CDF
 *   mixTail  p50/p90 from the plain group, p99 from the blended CDF
 * Components:
 *   byAction          F_k pooled over all train rows of action k
 *   byActionThinking  F_k|t pooled within the thinking stratum
 *
 * Writes experiments/artifacts/static-mixture-probe.json.
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
  path.join(process.cwd(), "experiments/artifacts/static-mixture-probe.json"),
);
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;
const NO_TOOL = "(no-tool)";
const OTHER_TOOL = "(other-tool)";

const { rows: loaded, filesScanned } = await loadRequests(projectsDir);
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
}
console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls` +
    `${asOf === null ? "" : `  (truncated at ${asOf})`}\n`,
);

// Action classes fixed over the WHOLE corpus (as in probe-loop-depth), so a
// sweep changes fitting, not the alphabet.
const firstToolCounts = new Map();
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  firstToolCounts.set(tool, (firstToolCounts.get(tool) ?? 0) + 1);
}
const CLASSES = [...firstToolCounts.entries()]
  .filter(([tool, count]) => count >= MIN_GROUP && tool !== NO_TOOL)
  .sort((a, b) => b[1] - a[1])
  .map(([tool]) => tool);
CLASSES.push(NO_TOOL, OTHER_TOOL);
const known = new Set(CLASSES);
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  row.action = known.has(tool) ? tool : OTHER_TOOL;
}
console.log(`Action alphabet: ${CLASSES.join(", ")}\n`);

const mtKey = (row) => `model=${row.model}|thinking=${row.thinking}`;

function fit(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return QUANTILES.map((p) => Math.round(quantile(sorted, p)));
}

/** Empirical CDF component: sorted values + binary-search P(Y <= y). */
function makeComponent(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    cdf(y) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= y) lo = mid + 1;
        else hi = mid;
      }
      return lo / sorted.length;
    },
  };
}

/** Quantile of a finite mixture of empirical CDFs, by bisection on y. */
function mixtureQuantile(components, weights, probability, maxY) {
  let lo = 0;
  let hi = maxY;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    let f = 0;
    for (let i = 0; i < components.length; i++) {
      f += weights[i] * components[i].cdf(mid);
    }
    if (f >= probability) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Fit both mixture variants for one training slice. Returns per-(m,t)-group
 * quantile triplets for: plain (the incumbent), mixAll, mixTail — for each
 * component scheme.
 */
function buildPredictors(trainRows) {
  const maxY = Math.max(...trainRows.map((row) => row.outputTokens)) + 1;
  // Incumbent: plain empirical quantiles per (m,t), backoff model -> overall.
  const byGroup = new Map();
  const byModel = new Map();
  for (const row of trainRows) {
    const g = mtKey(row);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(row);
    if (!byModel.has(row.model)) byModel.set(row.model, []);
    byModel.get(row.model).push(row);
  }
  const plainFits = new Map(
    [...byGroup]
      .filter(([, rs]) => rs.length >= MIN_GROUP)
      .map(([g, rs]) => [g, fit(rs.map((r) => r.outputTokens))]),
  );
  const modelFits = new Map(
    [...byModel]
      .filter(([, rs]) => rs.length >= MIN_GROUP)
      .map(([m, rs]) => [m, fit(rs.map((r) => r.outputTokens))]),
  );
  const overall = fit(trainRows.map((row) => row.outputTokens));

  // Pooled components.
  const componentsByAction = new Map();
  const componentsByActionThinking = new Map();
  for (const cls of CLASSES) {
    const all = trainRows.filter((row) => row.action === cls);
    if (all.length >= MIN_GROUP) {
      componentsByAction.set(cls, makeComponent(all.map((r) => r.outputTokens)));
    }
    for (const t of ["yes", "no"]) {
      const sub = all.filter((row) => row.thinking === t);
      if (sub.length >= MIN_GROUP) {
        componentsByActionThinking.set(
          `${cls}|${t}`,
          makeComponent(sub.map((r) => r.outputTokens)),
        );
      }
    }
  }

  // Static mixture quantiles per fitted (m,t) group.
  const mixFits = { byAction: new Map(), byActionThinking: new Map() };
  for (const [g, groupRows] of byGroup) {
    if (groupRows.length < MIN_GROUP) continue;
    const t = groupRows[0].thinking;
    const shares = new Map();
    for (const row of groupRows) {
      shares.set(row.action, (shares.get(row.action) ?? 0) + 1);
    }
    for (const [scheme, componentMap, keyOf] of [
      ["byAction", componentsByAction, (cls) => cls],
      ["byActionThinking", componentsByActionThinking, (cls) => `${cls}|${t}`],
    ]) {
      const components = [];
      const weights = [];
      let covered = 0;
      for (const [cls, count] of shares) {
        const component = componentMap.get(keyOf(cls));
        if (!component) continue;
        components.push(component);
        weights.push(count / groupRows.length);
        covered += count;
      }
      if (covered / groupRows.length < 0.9) continue; // mixture must describe the group
      const norm = weights.reduce((s, w) => s + w, 0);
      const normalized = weights.map((w) => w / norm);
      mixFits[scheme].set(
        g,
        QUANTILES.map((p) => mixtureQuantile(components, normalized, p, maxY)),
      );
    }
  }

  const plain = (row) =>
    plainFits.get(mtKey(row)) ?? modelFits.get(row.model) ?? overall;
  const predictor = (scheme, tailOnly) => (row) => {
    const base = plain(row);
    const mixed = mixFits[scheme].get(mtKey(row));
    if (!mixed) return base;
    return tailOnly ? [base[0], base[1], mixed[2]] : mixed;
  };
  return {
    plain,
    mixAllByAction: predictor("byAction", false),
    mixTailByAction: predictor("byAction", true),
    mixAllByActionThinking: predictor("byActionThinking", false),
    mixTailByActionThinking: predictor("byActionThinking", true),
  };
}

const split = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - split) / 5);
const records = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  const predictors = buildPredictors(rows.slice(0, start));
  for (const row of rows.slice(start, end)) {
    const record = { row };
    for (const [name, predict] of Object.entries(predictors)) {
      record[name] = predict(row);
    }
    records.push(record);
  }
}

const totalLoss = (row, q) =>
  QUANTILES.reduce((s, p, i) => s + pinball(row.outputTokens, q[i], p), 0);
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

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  calls: rows.length,
  holdoutCalls: records.length,
  actionAlphabet: CLASSES,
  variants: {},
};
console.log("STATIC MIXTURE vs POOLED EMPIRICAL QUANTILES (identical holdout calls)\n");
const plainMetrics = metrics("plain");
report.variants.plain = { metrics: plainMetrics };
console.log(
  `  plain (incumbent)        loss ${plainMetrics.loss.toFixed(1)}  cov ${plainMetrics.coverage.map(pct).join("/")}  ` +
    `p90-p50 ${fmt(plainMetrics.width[0])}  p99-p50 ${fmt(plainMetrics.width[1])}`,
);
for (const name of [
  "mixAllByAction",
  "mixTailByAction",
  "mixAllByActionThinking",
  "mixTailByActionThinking",
]) {
  const m = metrics(name);
  const differences = records.map(
    (record) => totalLoss(record.row, record[name]) - totalLoss(record.row, record.plain),
  );
  const comparison = blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
  report.variants[name] = { metrics: m, comparison };
  console.log(
    `  ${name.padEnd(24)} loss ${m.loss.toFixed(1)}  cov ${m.coverage.map(pct).join("/")}  ` +
      `p90-p50 ${fmt(m.width[0])}  p99-p50 ${fmt(m.width[1])}  ` +
      `diff ${comparison.meanDifference.toFixed(2)} [${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]` +
      `${comparison.ciUpper < 0 ? "  <- clears the gate" : ""}`,
  );
}

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

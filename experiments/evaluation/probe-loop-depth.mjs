#!/usr/bin/env node
/**
 * STEP 1 of the range-narrowing brief: does re-forecasting at each step of the
 * agent loop produce a TIGHTER forecast than the shipped one?
 *
 * docs/STATE-OF-PLAY.md §6e argues it should. The biggest measured signal in the
 * corpus is which tool the turn calls (worth ~92-96 pinball/call against the
 * marginal), and only ~5% of it is capturable because the action is unknown
 * before the call. But in an agent loop the PREVIOUS action has already
 * happened, and every tool result is a free, legal, pre-call feature for the
 * next forecast.
 *
 * Two things this probe does differently from probe-action-type.mjs, both
 * deliberate:
 *
 *   1. It grades against the SHIPPED model+thinking predictor, not the marginal.
 *      The 92 was measured against a forecast with no features at all, and the
 *      shipped predictor already captures some of it. §4.4 of
 *      docs/GENERATIVE-MODEL.md flags this as the comparison that decides
 *      shipping and has never been run. It gates everything below.
 *
 *   2. It reconstructs the loop from the transcript's parentUuid chain rather
 *      than from "the previous call in this session, by time". Sidechains run
 *      concurrently inside one session, so the time-ordered version hands a
 *      subagent's call a parent it never saw. See lib/load-history.mjs.
 *
 * HEADLINE DIAGNOSTIC (§6e): band width (p99 - p50) and pinball BY LOOP DEPTH.
 * KILL CONDITION (§6e): if depth >= 3 is no tighter than depth 0, re-forecasting
 * is an API convenience with no accuracy benefit -- say so and stop.
 *
 * Privacy: aggregates only. No prompt or response text is retained.
 *
 * ORACLE MEASUREMENT (added 4 August 2026). Section E used to price the ceiling
 * with a single JOINT rung `m|t|action`, which at a 100-sample floor cannot fire
 * on the class that matters. `Write` is ~3% of the corpus, so per fold exactly
 * one of six (model, thinking) cells clears 100 for it -- and it is the model
 * that has left recent traffic. The oracle was therefore falling straight back
 * to the shipped predictor on every opus-5 `Write`, i.e. on precisely the calls
 * §5 identifies as the whole prize. A POOLED `action=<tool>` rung below the
 * joint one fixes that without loosening the sample floor, and section E now
 * reports the rung-firing rates that make the difference auditable.
 *
 * Usage:
 *   node experiments/evaluation/probe-loop-depth.mjs
 *     [--projects-dir <dir>] [--json <path>]
 *     [--min-group <n>]   quantile-fitting floor (default 100)
 *     [--as-of <ISO>]     drop calls at or after this instant, for replication
 *                         at a second corpus endpoint
 *     [--no-sweep]        skip the minGroup sensitivity sweep
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
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/loop-depth-probe.json"),
);

const MIN_GROUP = Number(argValue("--min-group", "100")); // quantile-fitting floor
// The action ALPHABET is held at the shipped floor even when --min-group moves,
// so a sweep changes one thing (how much data a group needs before its
// quantiles are fitted) rather than two. Otherwise "the 7-way tool oracle" would
// silently become a 12-way one at minGroup=25 and the rows would not compare.
const CLASS_MIN = 100;
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}
const runSweep = !args.includes("--no-sweep");
const QUANTILES = [0.5, 0.9, 0.99];
const NO_TOOL = "(no-tool)";
const OTHER_TOOL = "(other-tool)";

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const sd = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};
const se = (values) => sd(values) / Math.sqrt(values.length);

const { rows: allRows, filesScanned } = await loadRequests(projectsDir, {
  withLoopContext: true,
});
const rows = allRows
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      row.outputTokens > 0 &&
      (asOfMs === null || row.timestampMs < asOfMs),
  )
  .sort((a, b) => a.timestampMs - b.timestampMs);
const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  minGroup: MIN_GROUP,
  classMin: CLASS_MIN,
  asOf,
};

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls` +
    `${asOf === null ? "" : `  (truncated at ${asOf})`}\n`,
);
if (MIN_GROUP !== 100) console.log(`  minGroup = ${MIN_GROUP}\n`);

// ---------------------------------------------------------------------------
// Feature construction. Everything here is knowable BEFORE the call it
// describes: it is a property of the step that already completed.
// ---------------------------------------------------------------------------

const firstToolCounts = new Map();
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  firstToolCounts.set(tool, (firstToolCounts.get(tool) ?? 0) + 1);
}
const CLASSES = [...firstToolCounts.entries()]
  .filter(([tool, count]) => count >= CLASS_MIN && tool !== NO_TOOL)
  .sort((a, b) => b[1] - a[1])
  .map(([tool]) => tool);
CLASSES.push(NO_TOOL, OTHER_TOOL);
const knownClass = new Set(CLASSES);
const actionOf = (row) => {
  const tool = row.tools[0] ?? NO_TOOL;
  return knownClass.has(tool) ? tool : OTHER_TOOL;
};

// Parent links are recorded as requestIds. Index every loaded call by its id --
// including calls filtered out of `rows`, so a parent that happens to be
// unusable still terminates the chain rather than silently looking absent.
const idOf = new Map(allRows.map((row) => [row.requestId, row]));

// Labelled over allRows, not just `rows`: a call excluded from scoring can still
// be some other call's parent, and an unlabelled parent would produce a junk
// feature value rather than an honest "unknown".
for (const row of allRows) {
  row.action = actionOf(row);
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
}

for (const row of rows) {
  const parent = row.parentRequestId === null ? null : idOf.get(row.parentRequestId);
  row.parent = parent && parent !== row ? parent : null;
  // Two clocks, and only one of them is legal.
  //
  // `toolMs` runs from the previous call finishing to its results arriving: the
  // time the tools took. A caller about to re-forecast has already watched it
  // elapse, so it is a pre-call feature.
  //
  // `wallMs` runs from the previous call to THIS one, which also contains the
  // time this call spent generating -- and generation time rises with output
  // length. It is the answer wearing a clock. It is scored below only as a
  // labelled control, never as a candidate.
  row.toolMs =
    row.parent &&
    Number.isFinite(row.parent.timestampMs) &&
    Number.isFinite(row.resultArrivedMs)
      ? row.resultArrivedMs - row.parent.timestampMs
      : null;
  row.wallMs =
    row.parent && Number.isFinite(row.parent.timestampMs)
      ? row.timestampMs - row.parent.timestampMs
      : null;
}

// The whole loop so far, not just the last step. GENERATIVE-MODEL.md §5b found
// corr(log Y_prev, log Y_next) = 0.152 and argued that "sessions have long-output
// regimes"; if that is right, averaging over the ancestors should beat reading
// only the most recent one, because it averages the noise out of the regime
// estimate. Capped at 8 ancestors: beyond that it stops being this turn.
const CHAIN_LOOKBACK = 8;
for (const row of rows) {
  let sum = 0;
  let count = 0;
  let ancestor = row.parent;
  while (ancestor && count < CHAIN_LOOKBACK) {
    sum += Math.log(Math.max(ancestor.outputTokens, 1));
    count++;
    ancestor = ancestor.parentRequestId === null ? null : idOf.get(ancestor.parentRequestId);
  }
  row.chainMeanY = count > 0 ? Math.exp(sum / count) : null;
  row.chainSeen = count;
}

const depthBucket = (row) =>
  row.loopDepthExact ? `d${Math.min(row.loopDepth, 6)}` : null;
const prevYBucket = (y) =>
  y < 200 ? "lt200" : y < 800 ? "200-800" : y < 3000 ? "800-3k" : "gte3k";
const resultBucket = (row) => {
  if (row.resultChars === null) return null;
  if (row.resultIsError) return "error";
  const c = row.resultChars;
  return c < 500 ? "lt500" : c < 5000 ? "500-5k" : c < 50000 ? "5k-50k" : "gte50k";
};
const elapsedBucket = (ms) =>
  ms === null || !Number.isFinite(ms) || ms < 0
    ? null
    : ms < 5000
      ? "lt5s"
      : ms < 30000
        ? "5-30s"
        : ms < 300000
          ? "30s-5m"
          : "gte5m";

// ---------------------------------------------------------------------------
// A. How much loop context is actually recoverable?
// ---------------------------------------------------------------------------

console.log("A. LOOP CONTEXT RECOVERED FROM THE TRANSCRIPT\n");
const withParent = rows.filter((r) => r.parent).length;
const afterUser = rows.filter((r) => r.afterUserMessage).length;
const broken = rows.filter((r) => r.chainBroken).length;
const exactDepth = rows.filter((r) => r.loopDepthExact).length;
const withResult = rows.filter((r) => r.resultChars !== null).length;
console.log(`  calls with a resolved preceding call   ${fmt(withParent)}  (${pct(withParent / rows.length)})`);
console.log(`  calls opening a turn (after a human)   ${fmt(afterUser)}  (${pct(afterUser / rows.length)})`);
console.log(`  calls whose ancestry is truncated      ${fmt(broken)}  (${pct(broken / rows.length)})`);
console.log(`  calls with an EXACT loop depth         ${fmt(exactDepth)}  (${pct(exactDepth / rows.length)})`);
console.log(`  calls with a measured result size      ${fmt(withResult)}  (${pct(withResult / rows.length)})`);
console.log(
  "\n  Truncated ancestry is a transcript artifact (compaction, copied sessions),",
);
console.log(
  "  not a property of a real caller: a live agent always knows its own depth.",
);
console.log("  Those calls are excluded from the depth diagnostic in D.");
report.coverage = {
  calls: rows.length,
  withParent,
  afterUser,
  chainBroken: broken,
  exactDepth,
  withResult,
};

// ---------------------------------------------------------------------------
// B. Marginal contrasts on the new features
// ---------------------------------------------------------------------------

function contrast(label, keyFn, subset = rows) {
  const groups = new Map();
  for (const row of subset) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.outputTokens);
  }
  const table = [...groups.entries()]
    .filter(([, values]) => values.length >= MIN_GROUP)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([key, values]) => ({
      key,
      n: values.length,
      p50: median(values),
      p90: quantile(values, 0.9),
      p99: quantile(values, 0.99),
      band: quantile(values, 0.99) - median(values),
    }));
  console.log(`\n  ${label}`);
  console.log(
    `    ${"group".padEnd(14)}${"n".padStart(7)}${"p50".padStart(8)}` +
      `${"p90".padStart(9)}${"p99".padStart(9)}${"p99/p50".padStart(9)}`,
  );
  for (const r of table) {
    console.log(
      `    ${String(r.key).padEnd(14)}${String(r.n).padStart(7)}` +
        `${fmt(r.p50).padStart(8)}${fmt(r.p90).padStart(9)}${fmt(r.p99).padStart(9)}` +
        `${`${(r.p99 / Math.max(r.p50, 1)).toFixed(1)}x`.padStart(9)}`,
    );
  }
  return table;
}

console.log("\n\nB. WHAT THE PRECEDING STEP LOOKS LIKE (marginal, all calls)");
report.marginalContrasts = {
  loopDepth: contrast("by exact loop depth", depthBucket),
  prevAction: contrast("by previous action", (r) => (r.parent ? r.parent.action : null)),
  prevStop: contrast("by previous stop_reason", (r) =>
    r.parent ? (r.parent.stopReason ?? "(null)") : null,
  ),
  prevOutput: contrast("by previous output size", (r) =>
    r.parent ? prevYBucket(r.parent.outputTokens) : null,
  ),
  resultSize: contrast("by size of the result it answers", resultBucket),
  toolTime: contrast("by how long those tools took (legal)", (r) =>
    elapsedBucket(r.toolMs),
  ),
  wallTimeLeaky: contrast("by previous-call-to-this-call wall time (LEAKY)", (r) =>
    elapsedBucket(r.wallMs),
  ),
};

// Quantify the leak rather than asserting it: the wall-clock gap should track
// output length, and the tool-time gap should not.
const logCorr = (pairs) => {
  const xs = pairs.map(([x]) => Math.log(Math.max(x, 1)));
  const ys = pairs.map(([, y]) => Math.log(Math.max(y, 1)));
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return { r: num / Math.sqrt(dx * dy), n: xs.length };
};
const wallPairs = rows
  .filter((r) => r.wallMs !== null && r.wallMs > 0)
  .map((r) => [r.wallMs, r.outputTokens]);
const toolPairs = rows
  .filter((r) => r.toolMs !== null && r.toolMs > 0)
  .map((r) => [r.toolMs, r.outputTokens]);
const wallCorr = logCorr(wallPairs);
const toolCorr = logCorr(toolPairs);
console.log("\n  Leak check -- corr(log gap, log output tokens):");
console.log(
  `    wall time (prev call -> this call)  r=${wallCorr.r.toFixed(3)}  n=${fmt(wallCorr.n)}   <- contains this call's own generation time`,
);
console.log(
  `    tool time (prev call -> its results) r=${toolCorr.r.toFixed(3)}  n=${fmt(toolCorr.n)}   <- ends before this call is issued`,
);
report.leakCheck = { wall: wallCorr, tool: toolCorr };

// ---------------------------------------------------------------------------
// B2. The STEP 0 gates on the feature that survives C, applied before believing
//     it. Support first, then significance, then DIRECTION across cells -- the
//     order that rejected `effort` and cleared action type.
// ---------------------------------------------------------------------------

function runGates(label, keyOf, reference, subset) {
  console.log(`\n\nB2. THE STEP 0 GATES ON ${label}, vs ${reference} (day and model held fixed)\n`);
  const cells = new Map();
  const marginal = new Map();
  for (const row of subset) {
    const key = keyOf(row);
    if (key === null) continue;
    const cell = `${new Date(row.timestampMs).toISOString().slice(0, 10)}|${row.model}`;
    if (!cells.has(cell)) cells.set(cell, new Map());
    const byLevel = cells.get(cell);
    if (!byLevel.has(key)) byLevel.set(key, []);
    byLevel.get(key).push(row.outputTokens);
    if (!marginal.has(key)) marginal.set(key, []);
    marginal.get(key).push(row.outputTokens);
  }
  console.log(
    `  ${"level".padEnd(12)}${"days".padStart(6)}${"cells".padStart(7)}` +
      `${"effect".padStart(9)}${"z".padStart(9)}${"ratio".padStart(9)}` +
      `${"naive".padStart(9)}${"sign".padStart(9)}${"sign p".padStart(10)}`,
  );
  const random = mulberry32(20260803);
  const out = {};
  for (const level of [...marginal.keys()].sort()) {
    if (level === reference) continue;
    const strata = [];
    const logRatios = [];
    const estimates = [];
    const days = new Set();
    let cellCount = 0;
    for (const [cell, byLevel] of cells) {
      const treated = byLevel.get(level);
      if (!treated) continue;
      cellCount++;
      days.add(cell.split("|")[0]);
      const control = byLevel.get(reference);
      if (!control) continue;
      strata.push({ treated, control });
      if (treated.length >= 10 && control.length >= 10) {
        logRatios.push({
          weight: Math.min(treated.length, control.length),
          value: Math.log(median(treated) / median(control)),
        });
      }
      if (treated.length >= 8 && control.length >= 8) {
        const seEstimate = bootstrapLogRatioSe(treated, control, random, 400);
        if (seEstimate && seEstimate > 0) {
          estimates.push({
            theta: Math.log(median(treated) / median(control)),
            se: seEstimate,
          });
        }
      }
    }
    const test = stratifiedRankTest(strata);
    if (!test) continue;
    const signs = logRatios.filter((r) => r.value !== 0);
    const positive = signs.filter((r) => r.value > 0).length;
    const agreeing = Math.max(positive, signs.length - positive);
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
      ? Math.exp(
          logRatios.reduce((s, r) => s + r.weight * r.value, 0) / totalWeight,
        )
      : null;
    const naive = median(marginal.get(level)) / median(marginal.get(reference));
    console.log(
      `  ${level.padEnd(12)}${String(days.size).padStart(6)}${String(cellCount).padStart(7)}` +
        `${test.effect.toFixed(3).padStart(9)}${test.z.toFixed(2).padStart(9)}` +
        `${(ratio ? `${ratio.toFixed(2)}x` : "n/a").padStart(9)}` +
        `${`${naive.toFixed(2)}x`.padStart(9)}` +
        `${(signs.length ? `${agreeing}/${signs.length}` : "n/a").padStart(9)}` +
        `${(signs.length ? (signP < 1e-4 ? "<0.0001" : signP.toFixed(4)) : "n/a").padStart(10)}`,
    );
    out[level] = {
      days: days.size,
      cells: cellCount,
      effect: test.effect,
      z: test.z,
      withinCellRatio: ratio,
      naiveRatio: naive,
      signAgreement: signs.length ? agreeing / signs.length : null,
      signCells: signs.length,
      signP: signs.length ? signP : null,
      heterogeneity: heterogeneity(estimates),
    };
  }
  return out;
}

report.gates = runGates(
  "PREVIOUS OUTPUT SIZE",
  (r) => (r.parent ? prevYBucket(r.parent.outputTokens) : null),
  "200-800",
  rows,
);
console.log(
  "\n  Compare `ratio` (day and model held fixed) with `naive`. `effort` collapsed",
);
console.log(
  "  from 0.67x to 0.81x under this test; a real effect barely moves. `sign` is",
);
console.log("  the gate that matters: does the effect keep its DIRECTION across cells?");

// ---------------------------------------------------------------------------
// C. Forecasters. Every one is a backoff ladder of empirical quantile lookups,
//    fitted on training rows only, exactly like the shipped predictor.
// ---------------------------------------------------------------------------

function fitQuantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    q: QUANTILES.map((p) => Math.round(quantile(sorted, p))),
  };
}

function fitGroups(trainRows, keyFn, minGroup = MIN_GROUP) {
  const grouped = new Map();
  for (const row of trainRows) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.outputTokens);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length >= minGroup)
      .map(([key, values]) => [key, fitQuantiles(values)]),
  );
}

/**
 * A rung whose key is null for a given row is SKIPPED, not treated as a level
 * of the feature. That is the unknown-is-not-false discipline §6a added for
 * `thinking`: a call with no recoverable parent must fall through to the
 * broader group rather than be filed under "no previous action".
 *
 * Returns which rung fired alongside the fit. That index is not decoration: it
 * is what shows an oracle ladder falling all the way back to the shipped
 * predictor on the calls it was supposed to price.
 */
function makeLadder(trainRows, keyFns, minGroup = MIN_GROUP) {
  const fits = keyFns.map((fn) => fitGroups(trainRows, fn, minGroup));
  const global = fitQuantiles(trainRows.map((r) => r.outputTokens));
  return (row) => {
    for (let i = 0; i < keyFns.length; i++) {
      const key = keyFns[i](row);
      if (key === null) continue;
      const fit = fits[i].get(key);
      if (fit !== undefined) return { fit, rung: i };
    }
    return { fit: global, rung: keyFns.length };
  };
}

const KEY = {
  modelThinking: (r) => `m=${r.model}|t=${r.thinking}`,
  model: (r) => `m=${r.model}`,
};
const withMT = (suffix) => (r) => {
  const value = suffix(r);
  return value === null ? null : `${KEY.modelThinking(r)}|${value}`;
};

const prevActionKey = withMT((r) => (r.parent ? `pa=${r.parent.action}` : null));
const depthKey = withMT((r) => {
  const bucket = depthBucket(r);
  return bucket === null ? null : `depth=${bucket}`;
});
const prevYKey = withMT((r) =>
  r.parent ? `py=${prevYBucket(r.parent.outputTokens)}` : null,
);
const prevStopKey = withMT((r) =>
  r.parent ? `ps=${r.parent.stopReason ?? "(null)"}` : null,
);
const resultKey = withMT((r) => {
  const bucket = resultBucket(r);
  return bucket === null ? null : `res=${bucket}`;
});
const toolTimeKey = withMT((r) => {
  const bucket = elapsedBucket(r.toolMs);
  return bucket === null ? null : `tt=${bucket}`;
});
const wallTimeKey = withMT((r) => {
  const bucket = elapsedBucket(r.wallMs);
  return bucket === null ? null : `wt=${bucket}`;
});
const oracleKey = withMT((r) => `action=${r.action}`);
// The same fact, pooled across (model, thinking). A joint rung needs
// minGroup samples in EVERY cell it wants to price; a pooled rung needs them
// once. For a 3%-of-corpus class like `Write` that is the difference between
// pricing it on one model and pricing it on all of them.
const oraclePooledKey = (r) => `action=${r.action}`;
const isWrite = (r) => (r.action === "Write" ? "yes" : "no");
const oracleWriteKey = withMT((r) => `write=${isWrite(r)}`);
const oracleWritePooledKey = (r) => `write=${isWrite(r)}`;

const CANDIDATES = {
  // The predictor that ships today, rebuilt per fold. Its number here should
  // land on the rolling-origin figure the main eval reports.
  shipped: [KEY.modelThinking, KEY.model],
  prevAction: [prevActionKey, KEY.modelThinking, KEY.model],
  loopDepth: [depthKey, KEY.modelThinking, KEY.model],
  prevOutput: [prevYKey, KEY.modelThinking, KEY.model],
  prevStop: [prevStopKey, KEY.modelThinking, KEY.model],
  resultSize: [resultKey, KEY.modelThinking, KEY.model],
  toolTime: [toolTimeKey, KEY.modelThinking, KEY.model],
  prevActionPrevOutput: [
    withMT((r) =>
      r.parent ? `pa=${r.parent.action}|py=${prevYBucket(r.parent.outputTokens)}` : null,
    ),
    prevActionKey,
    KEY.modelThinking,
    KEY.model,
  ],
  prevActionDepth: [
    withMT((r) => {
      const bucket = depthBucket(r);
      return r.parent && bucket !== null ? `pa=${r.parent.action}|depth=${bucket}` : null;
    }),
    prevActionKey,
    KEY.modelThinking,
    KEY.model,
  ],
  prevActionResult: [
    withMT((r) => {
      const bucket = resultBucket(r);
      return r.parent && bucket !== null ? `pa=${r.parent.action}|res=${bucket}` : null;
    }),
    prevActionKey,
    KEY.modelThinking,
    KEY.model,
  ],
  chainRegime: [
    withMT((r) => (r.chainMeanY === null ? null : `cm=${prevYBucket(r.chainMeanY)}`)),
    KEY.modelThinking,
    KEY.model,
  ],
  prevOutputChainRegime: [
    withMT((r) =>
      r.parent && r.chainMeanY !== null
        ? `py=${prevYBucket(r.parent.outputTokens)}|cm=${prevYBucket(r.chainMeanY)}`
        : null,
    ),
    prevYKey,
    KEY.modelThinking,
    KEY.model,
  ],
  prevOutputToolTime: [
    withMT((r) => {
      const bucket = elapsedBucket(r.toolMs);
      return r.parent && bucket !== null
        ? `py=${prevYBucket(r.parent.outputTokens)}|tt=${bucket}`
        : null;
    }),
    prevYKey,
    KEY.modelThinking,
    KEY.model,
  ],
  // --- controls, neither shippable nor eligible to be "best" ---
  // Uses a clock that has not finished running when the forecast is due. Scored
  // to show what leakage looks like from the inside: if it beats every legal
  // feature, that is the leak, not a discovery.
  wallTimeLEAKY: [wallTimeKey, KEY.modelThinking, KEY.model],
  // Ceiling: told the action this call is about to take, on top of the shipped
  // conditioning. This is the 92-96 pinball/call figure re-measured against the
  // right baseline.
  //
  // Three variants, because the first one is an understatement and section E
  // shows why. All are ORACLES -- none is shippable, none may be "best".
  //   oracleAction        joint rung only. What this probe used to publish.
  //   oracleActionPooled  + a pooled `action=` rung, so a rare class can still
  //                       be priced when its (model, thinking) cells are thin.
  //   oracleWriteBinary   the same construction on the single bit §5.3 says
  //                       carries the prize: is this call a `Write`?
  oracleAction: [oracleKey, KEY.modelThinking, KEY.model],
  oracleActionPooled: [oracleKey, oraclePooledKey, KEY.modelThinking, KEY.model],
  oracleWriteBinary: [
    oracleWriteKey,
    oracleWritePooledKey,
    KEY.modelThinking,
    KEY.model,
  ],
};
const CONTROLS = new Set([
  "shipped",
  "wallTimeLEAKY",
  "oracleAction",
  "oracleActionPooled",
  "oracleWriteBinary",
]);
const ORACLES = ["oracleAction", "oracleActionPooled", "oracleWriteBinary"];

const holdoutStart = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - holdoutStart) / 5);
const folds = [];
for (let f = 0; f < 5; f++) {
  const start = holdoutStart + f * blockSize;
  const end = f === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const NAMES = Object.keys(CANDIDATES);
const perFold = new Map(NAMES.map((name) => [name, []]));
/** Per-row records for the depth diagnostic, pooled over the 5 disjoint folds. */
const scored = [];

for (const [foldIndex, fold] of folds.entries()) {
  const ladders = new Map(
    NAMES.map((name) => [name, makeLadder(fold.train, CANDIDATES[name])]),
  );
  const totals = new Map(NAMES.map((name) => [name, 0]));
  for (const row of fold.test) {
    const record = { row, foldIndex, forecasts: {} };
    for (const name of NAMES) {
      const { fit, rung } = ladders.get(name)(row);
      let loss = 0;
      for (const [i, p] of QUANTILES.entries()) {
        loss += pinball(row.outputTokens, fit.q[i], p);
      }
      totals.set(name, totals.get(name) + loss);
      record.forecasts[name] = {
        q: fit.q,
        loss,
        band: fit.q[2] - fit.q[0],
        rung,
      };
    }
    scored.push(record);
  }
  for (const name of NAMES) {
    perFold.get(name).push(totals.get(name) / fold.test.length);
  }
}

// The adoption statistic. Not the 5-fold paired t this probe used to print:
// that test aggregated ~3,000 held-out calls into 5 fold totals, then estimated
// its own error bar from those 5 numbers, and it adopted and refused the same
// stable effect twenty minutes apart (STATE-OF-PLAY §7.1, house rule 10). The
// per-call series is resampled in SESSION blocks because calls inside a session
// share a task and their errors move together -- the effective sample here is
// tens of sessions, not thousands of calls.
const perCallSessions = scored.map((s) => s.row.sessionId ?? null);
const gradeVsShipped = (name) =>
  blockBootstrapDifference(
    scored.map((s) => s.forecasts[name].loss - s.forecasts.shipped.loss),
    perCallSessions,
  );

console.log("\n\nC. HELD-OUT PINBALL PER CALL, 5 ROLLING-ORIGIN FOLDS\n");
const shippedFolds = perFold.get("shipped");
const grades = new Map(
  NAMES.filter((n) => n !== "shipped").map((n) => [n, gradeVsShipped(n)]),
);
const blockInfo = grades.get(NAMES.find((n) => n !== "shipped"));
console.log(
  `  Graded by a paired block bootstrap over ${fmt(scored.length)} held-out calls in` +
    ` ${blockInfo.blocks} ${blockInfo.blockKind} blocks,\n  ${fmt(blockInfo.resamples)} resamples, seed fixed.` +
    ` Adopt only if the whole 95% CI is below zero.\n`,
);
console.log(
  `  ${"predictor".padEnd(22)}${"mean".padStart(8)}${"vs shipped".padStart(12)}` +
    `${"95% CI".padStart(21)}${"fold t".padStart(9)}  verdict`,
);
report.candidates = {};
for (const name of NAMES) {
  const values = perFold.get(name);
  const diffs = values.map((v, i) => v - shippedFolds[i]);
  const legacySe = se(diffs);
  const legacyT = legacySe > 0 ? mean(diffs) / legacySe : 0;
  const grade = grades.get(name) ?? null;
  const verdict =
    name === "shipped"
      ? "(baseline)"
      : grade.ciUpper < 0
        ? "WINS"
        : grade.ciLower > 0
          ? "worse"
          : "inside the noise";
  const ci =
    grade === null
      ? "-"
      : `[${grade.ciLower.toFixed(1)}, ${grade.ciUpper.toFixed(1)}]`;
  console.log(
    `  ${name.padEnd(22)}${mean(values).toFixed(1).padStart(8)}` +
      `${(grade === null ? "-" : grade.meanDifference.toFixed(2)).padStart(12)}` +
      `${ci.padStart(21)}` +
      `${(name === "shipped" ? "-" : legacyT.toFixed(2)).padStart(9)}  ${verdict}`,
  );
  report.candidates[name] = {
    foldMeans: values,
    mean: mean(values),
    sd: sd(values),
    vsShipped: grade,
    // Retained so pre-4-August numbers stay checkable against the statistic
    // that produced them. Not used for any verdict.
    legacyFoldDiff: name === "shipped" ? null : mean(diffs),
    legacyFoldSe: name === "shipped" ? null : legacySe,
    legacyFoldT: name === "shipped" ? null : legacyT,
  };
}
console.log(
  "\n  The `fold t` column is the OLD statistic, kept only so pre-4-August",
);
console.log(
  "  numbers stay checkable. Where it disagrees with the CI, the CI is right.",
);

// ---------------------------------------------------------------------------
// D. THE HEADLINE DIAGNOSTIC: band width and pinball by loop depth.
// ---------------------------------------------------------------------------

// Pick the SIMPLEST ladder that is statistically tied with the lowest-scoring
// one, not the lowest-scoring one outright. The repo has already been bitten
// once by adopting a change that "won" by 0.16 total pinball on a +/-63 spread;
// choosing a longer ladder over a shorter one for a fraction of a standard error
// is the same mistake in a new costume.
const eligible = NAMES.filter((n) => !CONTROLS.has(n));
const leader = eligible.reduce((a, b) =>
  report.candidates[a].mean <= report.candidates[b].mean ? a : b,
);
// One standard error of the leader's difference, read off the bootstrap CI
// rather than off 5 fold totals -- the tie-break should use the same statistic
// as the verdict.
const leaderGrade = grades.get(leader);
const tieBand = (leaderGrade.ciUpper - leaderGrade.ciLower) / 3.92;
const tied = eligible.filter(
  (n) => report.candidates[n].mean - report.candidates[leader].mean <= tieBand,
);
const best = tied.reduce((a, b) =>
  CANDIDATES[a].length <= CANDIDATES[b].length ? a : b,
);
if (best !== leader) {
  console.log(
    `\n  Lowest mean was ${leader} (${report.candidates[leader].mean.toFixed(1)}); ` +
      `${best} (${report.candidates[best].mean.toFixed(1)}) is within one paired SE ` +
      `and simpler, so it is carried forward.`,
  );
}
report.selection = { leader, tied, chosen: best, tieBand };

console.log(
  `\n\nD. HEADLINE DIAGNOSTIC -- BAND WIDTH (p99-p50) AND PINBALL BY LOOP DEPTH` +
    `\n   shipped vs best learned ladder (${best}), held-out calls only\n`,
);

const depthRows = scored.filter((s) => s.row.loopDepthExact);
const depthGroups = new Map();
for (const record of depthRows) {
  const key = Math.min(record.row.loopDepth, 6);
  if (!depthGroups.has(key)) depthGroups.set(key, []);
  depthGroups.get(key).push(record);
}
console.log(
  `  ${"depth".padEnd(7)}${"n".padStart(6)}${"actual band".padStart(13)}` +
    `${"ship band".padStart(11)}${"new band".padStart(10)}${"band -%".padStart(9)}` +
    `${"ship loss".padStart(11)}${"new loss".padStart(10)}${"delta".padStart(9)}`,
);
report.byDepth = [];
for (const key of [...depthGroups.keys()].sort((a, b) => a - b)) {
  const group = depthGroups.get(key);
  if (group.length < 30) continue;
  const actual = group.map((s) => s.row.outputTokens);
  const actualBand = quantile(actual, 0.99) - median(actual);
  const shipBand = mean(group.map((s) => s.forecasts.shipped.band));
  const newBand = mean(group.map((s) => s.forecasts[best].band));
  const shipLoss = mean(group.map((s) => s.forecasts.shipped.loss));
  const newLoss = mean(group.map((s) => s.forecasts[best].loss));
  console.log(
    `  ${(key === 6 ? "6+" : String(key)).padEnd(7)}${String(group.length).padStart(6)}` +
      `${fmt(actualBand).padStart(13)}${fmt(shipBand).padStart(11)}${fmt(newBand).padStart(10)}` +
      `${`${(100 * (1 - newBand / shipBand)).toFixed(1)}%`.padStart(9)}` +
      `${shipLoss.toFixed(0).padStart(11)}${newLoss.toFixed(0).padStart(10)}` +
      `${(newLoss - shipLoss).toFixed(0).padStart(9)}`,
  );
  report.byDepth.push({
    depth: key,
    n: group.length,
    actualP50: median(actual),
    actualP99: quantile(actual, 0.99),
    actualBand,
    shippedBand: shipBand,
    newBand,
    shippedLoss: shipLoss,
    newLoss,
    lossGap: shipLoss - newLoss,
    bandGap: shipBand - newBand,
  });
}
console.log(
  "\n  `actual band` is the empirical p99-p50 of the calls in that bucket: how",
);
console.log(
  "  much irreducible spread is left once you know only the depth. `ship band`",
);
console.log(
  "  and `new band` are the mean widths of the forecasts actually issued.",
);

// The kill condition, evaluated rather than eyeballed.
const shallow = report.byDepth.filter((d) => d.depth === 0);
const deep = report.byDepth.filter((d) => d.depth >= 3);
const bandAt = (set, field) =>
  set.length === 0
    ? null
    : set.reduce((s, d) => s + d[field] * d.n, 0) / set.reduce((s, d) => s + d.n, 0);
const verdict = {
  shallowActualBand: bandAt(shallow, "actualBand"),
  deepActualBand: bandAt(deep, "actualBand"),
  shallowNewBand: bandAt(shallow, "newBand"),
  deepNewBand: bandAt(deep, "newBand"),
  shallowNewLoss: bandAt(shallow, "newLoss"),
  deepNewLoss: bandAt(deep, "newLoss"),
  shallowShippedLoss: bandAt(shallow, "shippedLoss"),
  deepShippedLoss: bandAt(deep, "shippedLoss"),
};
report.killCondition = verdict;
console.log(
  `\n  depth 0 : actual band ${fmt(verdict.shallowActualBand)}` +
    `  forecast band ${fmt(verdict.shallowNewBand)}  loss ${verdict.shallowNewLoss.toFixed(0)}`,
);
console.log(
  `  depth>=3: actual band ${fmt(verdict.deepActualBand)}` +
    `  forecast band ${fmt(verdict.deepNewBand)}  loss ${verdict.deepNewLoss.toFixed(0)}`,
);
const tighter = verdict.deepNewBand < verdict.shallowNewBand;
console.log(
  `\n  Deeper calls forecast tighter than depth 0, in absolute terms? ` +
    `${tighter ? "YES" : "NO"}`,
);
report.killCondition.deeperIsTighter = tighter;

// That absolute comparison is not the question, and on its own it is misleading.
// The SHIPPED predictor has no depth feature at all, yet its band also falls
// with depth -- because deep calls are a different mix of model and thinking,
// not because anything was learned from the loop. What re-forecasting buys is
// the GAP between the two curves, and §6e's claim ("the gain compounds with
// loop length") is the claim that the gap widens as depth grows.
const trend = (field) => {
  const points = report.byDepth.map((d) => [d.depth, d[field], d.n]);
  const wsum = points.reduce((s, [, , n]) => s + n, 0);
  const mx = points.reduce((s, [x, , n]) => s + x * n, 0) / wsum;
  const my = points.reduce((s, [, y, n]) => s + y * n, 0) / wsum;
  let num = 0;
  let den = 0;
  for (const [x, y, n] of points) {
    num += n * (x - mx) * (y - my);
    den += n * (x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
};
const gapSlopeLoss = trend("lossGap");
const gapSlopeBand = trend("bandGap");
console.log(
  `\n  Gain from re-forecasting (shipped loss - new loss), by depth:` +
    ` ${report.byDepth.map((d) => d.lossGap.toFixed(0)).join(", ")}`,
);
console.log(
  `  Band narrowing vs shipped (shipped band - new band), by depth:` +
    ` ${report.byDepth.map((d) => d.bandGap.toFixed(0)).join(", ")}`,
);
console.log(
  `\n  Weighted slope of the gain against depth:  ${gapSlopeLoss.toFixed(1)} pinball per level`,
);
console.log(
  `  Weighted slope of the narrowing against depth: ${gapSlopeBand.toFixed(1)} tokens per level`,
);
const compounds = gapSlopeLoss > 0 && gapSlopeBand > 0;
console.log(
  `\n  KILL CONDITION (§6e): does the gain compound with loop length? ` +
    `${compounds ? "YES" : "NO"}`,
);
report.killCondition.gainSlopePerDepth = gapSlopeLoss;
report.killCondition.bandSlopePerDepth = gapSlopeBand;
report.killCondition.compoundsWithDepth = compounds;

// ---------------------------------------------------------------------------
// E. The ceiling, restated against the right baseline.
// ---------------------------------------------------------------------------

console.log("\n\nE. THE CEILING, RE-MEASURED AGAINST THE SHIPPED PREDICTOR\n");

// E1. Why the joint-only oracle understates itself.
//
// An oracle that falls back to the shipped predictor is not an oracle on that
// call -- it scores exactly what the incumbent scores and contributes nothing to
// the ceiling. The joint rung `m|t|action` needs minGroup samples in EVERY
// (model, thinking, tool) cell. For `Write`, ~3% of the corpus, almost no cell
// clears it, so the published ceiling was measured with the oracle switched off
// on the class §5.3 says carries the loss.
const ORACLE_RUNG_LABELS = {
  oracleAction: ["m|t|action", "m|t", "m", "global"],
  oracleActionPooled: ["m|t|action", "action", "m|t", "m", "global"],
  oracleWriteBinary: ["m|t|write", "write", "m|t", "m", "global"],
};
// A rung at or past this index is the shipped predictor or broader: the oracle
// told the ladder the answer and the ladder had nowhere to put it.
const informativeRungs = (name) =>
  name === "oracleAction" ? 1 : 2;

console.log("  E1. WHICH RUNG THE ORACLE ACTUALLY FIRED ON (held-out calls)\n");
const writeRows = scored.filter((s) => s.row.action === "Write");
console.log(
  `  ${"oracle".padEnd(20)}${"rung".padEnd(12)}${"all calls".padStart(12)}` +
    `${"Write calls".padStart(14)}`,
);
report.oracleRungUsage = {};
for (const name of ORACLES) {
  const labels = ORACLE_RUNG_LABELS[name];
  const usage = [];
  for (let rung = 0; rung < labels.length; rung++) {
    const all = scored.filter((s) => s.forecasts[name].rung === rung).length;
    const writes = writeRows.filter(
      (s) => s.forecasts[name].rung === rung,
    ).length;
    if (all === 0 && writes === 0) continue;
    usage.push({ rung, label: labels[rung], all, writes });
    console.log(
      `  ${(rung === 0 ? name : "").padEnd(20)}${labels[rung].padEnd(12)}` +
        `${`${fmt(all)} (${pct(all / scored.length)})`.padStart(12)}` +
        `${`${fmt(writes)} (${pct(writes / Math.max(writeRows.length, 1))})`.padStart(14)}`,
    );
  }
  const informative = informativeRungs(name);
  const writesPriced = writeRows.filter(
    (s) => s.forecasts[name].rung < informative,
  ).length;
  report.oracleRungUsage[name] = {
    usage,
    writeCalls: writeRows.length,
    writesPriced,
    writeCoverage: writeRows.length ? writesPriced / writeRows.length : null,
  };
  console.log(
    `  ${"".padEnd(20)}-> the oracle is informed on ` +
      `${pct(writeRows.length ? writesPriced / writeRows.length : 0)} of ${fmt(writeRows.length)} held-out \`Write\` calls\n`,
  );
}

// Which (model, thinking) cells clear the floor for `Write` in the LAST fold's
// training set -- the concrete count behind the paragraph above.
const lastTrain = folds[folds.length - 1].train;
const writeCellCounts = new Map();
for (const row of lastTrain) {
  if (row.action !== "Write") continue;
  const cell = `${row.model}|t=${row.thinking}`;
  writeCellCounts.set(cell, (writeCellCounts.get(cell) ?? 0) + 1);
}
const writeCells = [...writeCellCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(
  `  \`Write\` training samples per (model, thinking) cell, final fold` +
    ` -- floor is ${MIN_GROUP}:`,
);
for (const [cell, count] of writeCells) {
  console.log(
    `    ${cell.padEnd(34)}${String(count).padStart(6)}` +
      `  ${count >= MIN_GROUP ? "CLEARS" : "below floor"}`,
  );
}
const clearing = writeCells.filter(([, c]) => c >= MIN_GROUP);
console.log(
  `    ${clearing.length} of ${writeCells.length} cells clear the floor` +
    `${clearing.length ? ` (${clearing.map(([c]) => c).join(", ")})` : ""}`,
);
console.log(
  `    Pooled across cells, \`Write\` has ` +
    `${fmt(writeCells.reduce((s, [, c]) => s + c, 0))} training samples.\n`,
);
report.writeCellSupport = {
  minGroup: MIN_GROUP,
  cells: writeCells.map(([cell, n]) => ({ cell, n, clears: n >= MIN_GROUP })),
  cellsClearing: clearing.length,
  pooledSamples: writeCells.reduce((s, [, c]) => s + c, 0),
};

// E2. The ceiling itself, all three constructions, on the adoption statistic.
console.log("  E2. THE CEILING\n");
console.log(
  `  ${"oracle".padEnd(22)}${"vs shipped".padStart(12)}${"95% CI".padStart(21)}` +
    `${"fold t".padStart(9)}`,
);
report.oracles = {};
for (const name of ORACLES) {
  const g = report.candidates[name].vsShipped;
  console.log(
    `  ${name.padEnd(22)}${g.meanDifference.toFixed(2).padStart(12)}` +
      `${`[${g.ciLower.toFixed(1)}, ${g.ciUpper.toFixed(1)}]`.padStart(21)}` +
      `${report.candidates[name].legacyFoldT.toFixed(2).padStart(9)}`,
  );
  report.oracles[name] = {
    vsShipped: g,
    shareOfShippedLoss:
      g.meanDifference / mean(scored.map((s) => s.forecasts.shipped.loss)),
  };
}
const shippedPerCall = mean(scored.map((s) => s.forecasts.shipped.loss));
console.log(
  `\n  Shipped predictor pays ${shippedPerCall.toFixed(1)} pinball/call on this holdout, so the`,
);
console.log(
  `  corrected ceiling is ${pct(Math.abs(report.oracles.oracleActionPooled.vsShipped.meanDifference) / shippedPerCall)}` +
    ` of shipped loss, not ${pct(Math.abs(report.oracles.oracleAction.vsShipped.meanDifference) / shippedPerCall)}.`,
);
const binaryShare =
  report.oracles.oracleWriteBinary.vsShipped.meanDifference /
  report.oracles.oracleActionPooled.vsShipped.meanDifference;
console.log(
  `  A BINARY "is this a \`Write\`?" detector is worth ${pct(binaryShare)} of the 7-way ceiling.`,
);
report.oracles.binaryShareOfPooled = binaryShare;

const bestDiff = perFold.get(best).map((v, i) => v - shippedFolds[i]);
const bestGrade = report.candidates[best].vsShipped;
console.log(
  `\n  best loop-context ladder        ${bestGrade.meanDifference.toFixed(2)}` +
    ` [${bestGrade.ciLower.toFixed(1)}, ${bestGrade.ciUpper.toFixed(1)}]  (${best})`,
);
console.log(
  `  share of the corrected ceiling captured   ` +
    `${pct(Math.max(0, bestGrade.meanDifference / report.oracles.oracleActionPooled.vsShipped.meanDifference))}`,
);
// The population that can actually be re-forecast. A call that opens a turn has
// no preceding step, so every ladder here reduces to the shipped predictor on
// it; averaging over those dilutes the effect a re-forecasting caller would see.
const inLoop = (record) => record.row.parent !== null;
const restricted = (name) => {
  const perFoldMeans = [];
  for (let f = 0; f < folds.length; f++) {
    const subset = scored.filter((s) => s.foldIndex === f && inLoop(s));
    perFoldMeans.push(mean(subset.map((s) => s.forecasts[name].loss)));
  }
  return perFoldMeans;
};
const inLoopShipped = restricted("shipped");
const inLoopBest = restricted(best);
const inLoopDiff = inLoopBest.map((v, i) => v - inLoopShipped[i]);
const inLoopCount = scored.filter(inLoop).length;
console.log(
  `\n  Restricted to the ${pct(inLoopCount / scored.length)} of held-out calls that` +
    ` actually have a preceding step:`,
);
console.log(
  `  best ladder vs shipped          ${mean(inLoopDiff).toFixed(2)} +/- ${se(inLoopDiff).toFixed(2)} pinball/call`,
);
report.inLoopOnly = {
  share: inLoopCount / scored.length,
  bestVsShipped: { mean: mean(inLoopDiff), se: se(inLoopDiff) },
};
console.log(
  `\n  For reference, probe-action-type measured the oracle at ~-96 against the`,
);
console.log(
  `  MARGINAL. The gap between that and the numbers above is how much of the`,
);
console.log(`  action signal the shipped model+thinking predictor already holds.`);
report.ceiling = {
  best,
  oracleVsShipped: report.candidates.oracleAction.vsShipped,
  oraclePooledVsShipped: report.candidates.oracleActionPooled.vsShipped,
  oracleWriteBinaryVsShipped: report.candidates.oracleWriteBinary.vsShipped,
  bestVsShipped: bestGrade,
  shippedPerCall: shippedPerCall,
  legacyFoldDiffs: { best: mean(bestDiff) },
  shareCaptured:
    bestGrade.meanDifference /
    report.candidates.oracleActionPooled.vsShipped.meanDifference,
};

// ---------------------------------------------------------------------------
// F. Sensitivity of the correction to the sample floor.
//
// The whole claim is that a threshold hid a class. So the correction has to be
// shown NOT to be its own threshold artifact: refit every oracle at 25, 50 and
// 100 and check the ordering holds. Only the quantile-fitting floor moves; the
// action alphabet stays fixed (see CLASS_MIN) so the rows compare.
// ---------------------------------------------------------------------------

if (runSweep) {
  console.log("\n\nF. THE SAME THREE ORACLES ACROSS THE SAMPLE FLOOR\n");
  console.log(
    `  ${"minGroup".padEnd(10)}${"joint only".padStart(13)}${"+ pooled".padStart(13)}` +
      `${"binary Write".padStart(15)}${"Write priced".padStart(14)}`,
  );
  report.minGroupSweep = [];
  for (const floor of [25, 50, 100]) {
    const perCallDiffs = new Map(ORACLES.map((n) => [n, []]));
    const sweepScored = [];
    for (const fold of folds) {
      const ladders = new Map(
        ["shipped", ...ORACLES].map((name) => [
          name,
          makeLadder(fold.train, CANDIDATES[name], floor),
        ]),
      );
      for (const row of fold.test) {
        const lossOf = (name) => {
          const { fit, rung } = ladders.get(name)(row);
          let loss = 0;
          for (const [i, p] of QUANTILES.entries()) {
            loss += pinball(row.outputTokens, fit.q[i], p);
          }
          return { loss, rung };
        };
        const base = lossOf("shipped").loss;
        const rungs = {};
        for (const name of ORACLES) {
          const { loss, rung } = lossOf(name);
          perCallDiffs.get(name).push(loss - base);
          rungs[name] = rung;
        }
        sweepScored.push({ row, rungs });
      }
    }
    const sessions = sweepScored.map((s) => s.row.sessionId ?? null);
    const graded = Object.fromEntries(
      ORACLES.map((n) => [
        n,
        blockBootstrapDifference(perCallDiffs.get(n), sessions),
      ]),
    );
    const sweepWrites = sweepScored.filter((s) => s.row.action === "Write");
    const pricedPooled = sweepWrites.filter(
      (s) => s.rungs.oracleActionPooled < 2,
    ).length;
    const show = (g) =>
      `${g.meanDifference.toFixed(1)}`.padStart(13);
    console.log(
      `  ${String(floor).padEnd(10)}${show(graded.oracleAction)}` +
        `${show(graded.oracleActionPooled)}${show(graded.oracleWriteBinary).padStart(15)}` +
        `${pct(sweepWrites.length ? pricedPooled / sweepWrites.length : 0).padStart(14)}`,
    );
    report.minGroupSweep.push({
      minGroup: floor,
      oracles: graded,
      writeCalls: sweepWrites.length,
      writesPricedByPooled: pricedPooled,
    });
  }
  console.log(
    "\n  `Write priced` is the share of held-out `Write` calls on which the pooled",
  );
  console.log(
    "  oracle actually got to use what it was told, rather than falling back to",
  );
  console.log("  the shipped predictor. That column is the whole finding.");
}

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

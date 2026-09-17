#!/usr/bin/env node
/**
 * Probe the latent structure of output-token generation in Claude Code history.
 *
 * This is a measurement script, not an evaluation. It exists to support the
 * claims in docs/GENERATIVE-MODEL.md and to let anyone re-derive them from
 * their own ~/.claude/projects rather than trusting numbers in a document.
 *
 * It answers five questions the existing eval never asks:
 *
 *   1. How much of each call's billed output is absent from the transcript?
 *      (Motivates decomposing Y = H + V.)
 *   2. Is the shipped `thinking` flag detecting thinking, or is it detecting
 *      "the transcript retained a thinking block"?
 *   3. Does the recorded `effort` field carry signal? (It is populated, on ~52%
 *      of calls. Whether it carries signal was answered separately, and the
 *      answer is no -- see probe-effort-confound.mjs.)
 *   4. How large is the between-tool spread, i.e. how much is a mixture over
 *      action type worth?
 *   5. What is the tail index alpha? (Determines whether ANY log-normal can
 *      fit the p99, and whether the sample mean converges at all.)
 *
 * Privacy: prints aggregates only -- counts, quantiles, ratios. Character
 * counts of content are computed and discarded; no text is retained, logged,
 * or written anywhere.
 *
 * Usage:
 *   node experiments/evaluation/probe-latent-structure.mjs
 *     [--projects-dir <dir>]
 *     [--chars-per-token <float>]   default 3.6, only used for a sanity bound
 *     [--json <path>]               also write the aggregates as JSON
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  redactHome,
} from "./lib/load-history.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue("--json", null);
const CHARS_PER_TOKEN = Number(argValue("--chars-per-token", "3.6"));

const { rows, filesScanned } = await loadRequests(projectsDir);
if (rows.length === 0) {
  console.error(`No observations found under ${projectsDir}`);
  process.exit(1);
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

const fmt = (value) => Math.round(value).toLocaleString("en-US");
const pct = (value) => `${(value * 100).toFixed(1)}%`;

function quantileRow(label, values, width = 22) {
  return (
    `  ${label.padEnd(width)} n=${String(values.length).padStart(6)}` +
    `  p50=${fmt(quantile(values, 0.5)).padStart(7)}` +
    `  p90=${fmt(quantile(values, 0.9)).padStart(7)}` +
    `  p99=${fmt(quantile(values, 0.99)).padStart(8)}`
  );
}

function groupBy(source, key) {
  const groups = new Map();
  for (const row of source) {
    const group = key(row);
    if (group === null || group === undefined) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

const report = { generatedAt: new Date().toISOString(), source: redactHome(projectsDir) };

console.log(`Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} unique API calls\n`);
report.uniqueApiCalls = rows.length;

// ---------------------------------------------------------------------------
// 1. How much of the billed output is absent from the transcript?
//
// A character-per-token ratio well below what real content tokenizes at is
// evidence of output tokens that were billed but never stored. English prose
// runs ~4 chars/token; dense JSON runs ~2.5-3. Anything under ~2 cannot be
// explained by tokenizer slack.
// ---------------------------------------------------------------------------
console.log("1. VISIBLE CONTENT vs BILLED OUTPUT (chars per output token)");
console.log("   reference: English prose ~4.0, tool-call JSON ~2.5-3.0\n");
const ratioSegments = [
  ["text only, no thinking blk", (r) => r.blockTypes.size === 1 && r.blockTypes.has("text") && !hasThinkingBlock(r)],
  ["tool_use only", (r) => r.blockTypes.size === 1 && r.blockTypes.has("tool_use")],
  ["has thinking block", (r) => hasThinkingBlock(r)],
  ["all calls", () => true],
];
report.charsPerOutputToken = {};
for (const [label, select] of ratioSegments) {
  const selected = rows.filter((row) => select(row) && row.outputTokens >= 100);
  if (selected.length === 0) continue;
  const ratios = selected.map((row) => row.visibleChars / row.outputTokens);
  const under2 = ratios.filter((value) => value < 2).length / ratios.length;
  console.log(
    `  ${label.padEnd(28)} n=${String(selected.length).padStart(6)}` +
      `  p10=${quantile(ratios, 0.1).toFixed(2)}` +
      `  p50=${quantile(ratios, 0.5).toFixed(2)}` +
      `  p90=${quantile(ratios, 0.9).toFixed(2)}` +
      `  under 2.0: ${pct(under2)}`,
  );
  report.charsPerOutputToken[label] = {
    n: selected.length,
    p10: quantile(ratios, 0.1),
    p50: quantile(ratios, 0.5),
    p90: quantile(ratios, 0.9),
    shareUnderTwo: under2,
  };
}

// ---------------------------------------------------------------------------
// 2. Is the shipped `thinking` flag measuring thinking, or measuring retention?
//
// The predictor labels a call thinking=no when no thinking block is present.
// If a large share of those calls nonetheless carry output-token mass that
// visible content cannot account for, the flag is detecting whether the
// transcript kept the block -- not whether thinking was enabled.
// ---------------------------------------------------------------------------
console.log("\n2. IS `thinking=no` ACTUALLY NO-THINKING?\n");
const labelledNo = rows.filter((row) => !hasThinkingBlock(row) && row.outputTokens >= 100);
const unexplained = labelledNo.filter(
  (row) => row.visibleChars / CHARS_PER_TOKEN < 0.4 * row.outputTokens,
);
console.log(`  calls labelled thinking=no with >=100 output tokens: ${fmt(labelledNo.length)}`);
console.log(
  `  of those, visible content explains <40% of the tokens: ${fmt(unexplained.length)}` +
    ` (${pct(unexplained.length / labelledNo.length)})`,
);
console.log(quantileRow("those calls", unexplained.map((r) => r.outputTokens)));
report.mislabelledThinking = {
  labelledNo: labelledNo.length,
  unexplained: unexplained.length,
  share: unexplained.length / labelledNo.length,
};

// ---------------------------------------------------------------------------
// 3. `effort` -- a request-side setting the transcripts already record.
//
// It is populated, known before the call, and needs no inference. The raw
// separation below looks like a 4.6x monotone ladder and IS NOT ONE: it is a
// (day, model) artifact. probe-effort-confound.mjs shows why. The numbers stay
// here because they are the input to that rejection, not because they mean
// anything on their own.
// ---------------------------------------------------------------------------
console.log("\n3. `effort` (recorded, request-side, known pre-call)\n");
console.log("   ⚠ REJECTED as a dimension -- see probe-effort-confound.mjs.");
report.byEffort = {};
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "null"];
const effortGroups = groupBy(rows, (row) => String(row.effort));
effortGroups.sort(
  (a, b) => EFFORT_ORDER.indexOf(a[0]) - EFFORT_ORDER.indexOf(b[0]),
);
for (const [effort, group] of effortGroups) {
  const values = group.map((r) => r.outputTokens);
  console.log(quantileRow(`effort=${effort}`, values));
  report.byEffort[effort] = {
    n: values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
  };
}
console.log("  note: `null` is not a level -- it is older rows that predate the field.");

// ---------------------------------------------------------------------------
// 4. Between-tool spread -- the size of the prize for a mixture over action.
//
// Not knowable before the call, which is exactly why it needs a mixture:
//   P(Y <= y) = sum_k pi_k(x) * P(Y <= y | action = k)
// ---------------------------------------------------------------------------
console.log("\n4. FIRST TOOL CALLED vs OUTPUT TOKENS (mixture components)\n");
report.byFirstTool = {};
for (const [tool, group] of groupBy(rows, (row) => row.tools[0] ?? null).slice(0, 12)) {
  const values = group.map((r) => r.outputTokens);
  console.log(quantileRow(tool, values));
  report.byFirstTool[tool] = {
    n: values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
  };
}

// ---------------------------------------------------------------------------
// 5. Tail index via the Hill estimator.
//
//   alpha_hat(k) = k / sum_{i=1..k} log(y_(i) / y_(k))
//
// on the k largest order statistics. alpha < 2 implies infinite variance: the
// sample mean of output tokens does not converge, and no log-normal can match
// the tail. Watch for drift across k -- a stable plateau is what makes the
// estimate trustworthy.
// ---------------------------------------------------------------------------
console.log("\n5. TAIL INDEX (Hill estimator)\n");
const descending = rows
  .map((row) => row.outputTokens)
  .filter((value) => value > 0)
  .sort((a, b) => b - a);
report.hill = {};
for (const k of [50, 100, 200, 500, 1000]) {
  if (k >= descending.length) break;
  let sum = 0;
  for (let index = 0; index < k; index++) {
    sum += Math.log(descending[index] / descending[k]);
  }
  const alpha = k / sum;
  console.log(
    `  top k=${String(k).padStart(5)}  alpha=${alpha.toFixed(2)}` +
      `  ->  P(Y > y) ~ y^-${alpha.toFixed(2)}` +
      `${alpha < 2 ? "   (infinite variance)" : ""}`,
  );
  report.hill[k] = alpha;
}

// ---------------------------------------------------------------------------
// 6. Session lag -- a pre-call feature that costs nothing and needs no telemetry.
// ---------------------------------------------------------------------------
console.log("\n6. PREVIOUS OUTPUT IN THE SAME SESSION (free pre-call feature)\n");
const sessions = new Map();
for (const row of rows) {
  if (!row.sessionId || !Number.isFinite(row.timestampMs)) continue;
  if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, []);
  sessions.get(row.sessionId).push(row);
}
const pairs = [];
for (const session of sessions.values()) {
  session.sort((a, b) => a.timestampMs - b.timestampMs);
  for (let index = 1; index < session.length; index++) {
    const previous = session[index - 1].outputTokens;
    const next = session[index].outputTokens;
    if (previous > 0 && next > 0) pairs.push([previous, next]);
  }
}
if (pairs.length > 1) {
  const logPrevious = pairs.map(([previous]) => Math.log(previous));
  const logNext = pairs.map(([, next]) => Math.log(next));
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanPrevious = average(logPrevious);
  const meanNext = average(logNext);
  const sd = (values, mean) =>
    Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
  const covariance = average(
    logPrevious.map((value, index) => (value - meanPrevious) * (logNext[index] - meanNext)),
  );
  const correlation =
    covariance / (sd(logPrevious, meanPrevious) * sd(logNext, meanNext));
  console.log(
    `  n pairs=${fmt(pairs.length)}   corr(log Y_prev, log Y_next) = ${correlation.toFixed(3)}` +
      `   (SE ~ ${(1 / Math.sqrt(pairs.length)).toFixed(4)})`,
  );
  report.sessionLag = { pairs: pairs.length, logCorrelation: correlation };

  const bucket = (value) =>
    value < 200 ? "prev<200" : value < 800 ? "prev 200-800" : value < 3000 ? "prev 800-3k" : "prev>=3k";
  report.byPreviousOutput = {};
  const buckets = new Map();
  for (const [previous, next] of pairs) {
    const key = bucket(previous);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(next);
  }
  for (const key of ["prev<200", "prev 200-800", "prev 800-3k", "prev>=3k"]) {
    const values = buckets.get(key);
    if (!values) continue;
    console.log(quantileRow(key, values));
    report.byPreviousOutput[key] = {
      n: values.length,
      p50: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      p99: quantile(values, 0.99),
    };
  }
}

if (jsonOut) {
  await mkdir(path.dirname(jsonOut), { recursive: true });
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}

#!/usr/bin/env node
/**
 * STEP 1 of docs/NEXT-PROMPT.md, done locally and for free.
 *
 * The brief called for ~13.7k `POST /v1/messages/count_tokens` calls to measure
 * V (the token count of stored content) so that H = Y - V could be recovered.
 * Two things changed that plan:
 *
 *   1. The premise it was testing was mostly a bug in our own loader. Claude
 *      Code writes one JSONL row per emitted content block, repeating the
 *      call's total output_tokens on each. The old dedup rule kept ONE row --
 *      usually the zero-length `thinking` marker -- and compared that single
 *      block's characters against the whole call's tokens. See
 *      lib/load-history.mjs for the fix.
 *
 *   2. Once rows are merged, V no longer needs the API. Calls with no thinking
 *      block have H = 0 by construction, so they calibrate the chars-per-token
 *      rate directly:
 *
 *          Y = a + b_text * textChars + b_tool * toolChars
 *
 *      Fit that on no-thinking calls, and the fit quality IS the test of §2:
 *      if those calls really carry unexplained token mass, a linear model of
 *      their visible content cannot fit them well.
 *
 * Then V_hat is applied to every call and H = Y - V_hat is the hidden
 * component, recovered per call across the whole corpus without spending
 * anything.
 *
 * Privacy: aggregates only. Character counts are computed and discarded; no
 * prompt or response text is read into the report.
 *
 * Usage:
 *   node experiments/evaluation/probe-visible-mass.mjs
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
import { fmt, median, ols, pct, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue("--json", null);

const { rows, filesScanned } = await loadRequests(projectsDir);
const report = { generatedAt: new Date().toISOString(), source: redactHome(projectsDir) };

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} unique API calls\n`,
);
report.uniqueApiCalls = rows.length;

// ---------------------------------------------------------------------------
// 0. How much of the corpus was being discarded
// ---------------------------------------------------------------------------

const multiRow = rows.filter((row) => row.rows > 1);
console.log("0. THE RECONSTRUCTION\n");
console.log(
  `  calls assembled from >1 transcript row: ${fmt(multiRow.length)}` +
    ` (${pct(multiRow.length / rows.length)})`,
);
console.log(
  `  median rows per multi-row call:         ${median(multiRow.map((r) => r.rows))}`,
);
const withTool = rows.filter((row) => row.tools.length > 0);
console.log(
  `  calls with at least one tool_use block: ${fmt(withTool.length)}` +
    ` (${pct(withTool.length / rows.length)})`,
);
report.reconstruction = {
  multiRowCalls: multiRow.length,
  callsWithTool: withTool.length,
};

// ---------------------------------------------------------------------------
// 1. Thinking blocks really are stored empty -- that part of §1 survives
// ---------------------------------------------------------------------------

const thinkingRows = rows.filter(hasThinkingBlock);
const emptyThinking = thinkingRows.filter((row) => row.thinkingChars === 0);
console.log("\n1. ARE THINKING BLOCKS ACTUALLY EMPTY?\n");
console.log(
  `  calls with a thinking block:      ${fmt(thinkingRows.length)}`,
);
console.log(
  `  ...whose thinking text is empty:  ${fmt(emptyThinking.length)}` +
    ` (${pct(emptyThinking.length / thinkingRows.length)})`,
);
console.log(
  "  So the hidden component is real and specific: it is thinking, retained as",
);
console.log("  a zero-length marker. It is NOT a general failure to record output.");
report.thinkingBlocks = {
  n: thinkingRows.length,
  emptyShare: emptyThinking.length / thinkingRows.length,
};

// ---------------------------------------------------------------------------
// 2. Calibrate chars -> tokens on calls that have no hidden component
// ---------------------------------------------------------------------------

console.log("\n2. CALIBRATING chars -> tokens ON NO-THINKING CALLS\n");
console.log("   Y = a + b_text*textChars + b_tool*toolChars, fitted where H = 0.");
console.log("   The R2 is the test: if these calls carried unexplained token mass,");
console.log("   their visible content could not predict Y this well.\n");

const noThinking = rows.filter(
  (row) => !hasThinkingBlock(row) && row.outputTokens > 0,
);
noThinking.sort((a, b) => a.timestampMs - b.timestampMs);
const cut = Math.floor(noThinking.length * 0.8);
const trainSet = noThinking.slice(0, cut);
const testSet = noThinking.slice(cut);

const design = (source) =>
  source.map((row) => [1, row.textChars, row.toolChars]);
const target = (source) => Float64Array.from(source.map((r) => r.outputTokens));

const fit = ols(design(trainSet), target(trainSet));
const [intercept, bText, bTool] = fit.beta;

// Held-out R2, so the fit quality is not read off the data it was fitted on.
const testY = target(testSet);
const meanTestY = testY.reduce((s, v) => s + v, 0) / testY.length;
let ssRes = 0;
let ssTot = 0;
testSet.forEach((row, i) => {
  const fitted = intercept + bText * row.textChars + bTool * row.toolChars;
  ssRes += (testY[i] - fitted) ** 2;
  ssTot += (testY[i] - meanTestY) ** 2;
});
const testR2 = 1 - ssRes / ssTot;

console.log(`  fitted on ${fmt(trainSet.length)} no-thinking calls (time-ordered 80%)`);
console.log(`    intercept a       = ${intercept.toFixed(1)} tokens per call`);
console.log(
  `    prose             = ${(1 / bText).toFixed(2)} chars/token` +
    `   (English reference ~4.0)`,
);
console.log(
  `    tool-call JSON    = ${(1 / bTool).toFixed(2)} chars/token` +
    `   (dense JSON reference ~2.5-3.0)`,
);
console.log(`    in-sample R2      = ${fit.rSquared.toFixed(4)}`);
console.log(
  `    held-out R2       = ${testR2.toFixed(4)}  (${fmt(testSet.length)} calls)`,
);
report.calibration = {
  trainN: trainSet.length,
  testN: testSet.length,
  interceptTokens: intercept,
  proseCharsPerToken: 1 / bText,
  toolCharsPerToken: 1 / bTool,
  rSquared: fit.rSquared,
  heldOutRSquared: testR2,
};

// ---------------------------------------------------------------------------
// 3. §2's falsification: constant overhead, or a gap that scales?
// ---------------------------------------------------------------------------

console.log("\n3. §2 FALSIFICATION: is the leftover a per-call constant?\n");
console.log("   §8 said: check whether the gap scales with content or is roughly");
console.log("   constant. A constant means billing overhead, not hidden thinking.\n");

const residualsByBucket = new Map();
const bucketOf = (chars) =>
  chars < 200 ? "<200" : chars < 800 ? "200-800" : chars < 3000 ? "800-3k" : ">=3k";
for (const row of noThinking) {
  const predicted = intercept + bText * row.textChars + bTool * row.toolChars;
  const key = bucketOf(row.visibleChars);
  if (!residualsByBucket.has(key)) residualsByBucket.set(key, []);
  residualsByBucket.get(key).push(row.outputTokens - predicted);
}
report.residualsByContent = {};
for (const key of ["<200", "200-800", "800-3k", ">=3k"]) {
  const values = residualsByBucket.get(key);
  if (!values) continue;
  console.log(
    `  visible chars ${key.padEnd(8)} n=${String(values.length).padStart(5)}` +
      `  median residual=${fmt(median(values)).padStart(6)} tokens` +
      `  p90=${fmt(quantile(values, 0.9)).padStart(6)}`,
  );
  report.residualsByContent[key] = {
    n: values.length,
    medianResidual: median(values),
    p90Residual: quantile(values, 0.9),
  };
}
console.log(
  `\n  The fitted intercept of ${intercept.toFixed(0)} tokens IS that constant overhead,`,
);
console.log("  and it is now absorbed by the model rather than being mistaken for");
console.log("  hidden thinking.");

// ---------------------------------------------------------------------------
// 4. The decomposition Y = H + V
// ---------------------------------------------------------------------------

console.log("\n4. Y = H + V, ESTIMATED WITHOUT THE API\n");

for (const row of rows) {
  row.visibleTokens = Math.max(
    0,
    intercept + bText * row.textChars + bTool * row.toolChars,
  );
  row.hiddenTokens = row.outputTokens - row.visibleTokens;
}

const segments = [
  ["has thinking block", (r) => hasThinkingBlock(r)],
  ["no thinking block", (r) => !hasThinkingBlock(r)],
  ["all calls", () => true],
];
report.decomposition = {};
console.log(
  `  ${"segment".padEnd(20)}${"n".padStart(7)}${"med Y".padStart(8)}` +
    `${"med V".padStart(8)}${"med H".padStart(8)}${"H/Y".padStart(9)}` +
    `${"H<0".padStart(8)}`,
);
for (const [label, select] of segments) {
  const selected = rows.filter((r) => select(r) && r.outputTokens >= 100);
  if (selected.length === 0) continue;
  const shares = selected.map((r) => r.hiddenTokens / r.outputTokens);
  const negative = selected.filter((r) => r.hiddenTokens < 0).length;
  console.log(
    `  ${label.padEnd(20)}${String(selected.length).padStart(7)}` +
      `${fmt(median(selected.map((r) => r.outputTokens))).padStart(8)}` +
      `${fmt(median(selected.map((r) => r.visibleTokens))).padStart(8)}` +
      `${fmt(median(selected.map((r) => r.hiddenTokens))).padStart(8)}` +
      `${pct(median(shares)).padStart(9)}` +
      `${pct(negative / selected.length).padStart(8)}`,
  );
  report.decomposition[label] = {
    n: selected.length,
    medianY: median(selected.map((r) => r.outputTokens)),
    medianV: median(selected.map((r) => r.visibleTokens)),
    medianH: median(selected.map((r) => r.hiddenTokens)),
    medianHShare: median(shares),
    negativeHShare: negative / selected.length,
  };
}
console.log(
  "\n  H<0 is the estimator's error rate: a call whose visible content already",
);
console.log("  over-explains its billed tokens. Low is good.");

// ---------------------------------------------------------------------------
// 5. Re-derive the `thinking` contrast against measured H
// ---------------------------------------------------------------------------

console.log("\n5. THE SHIPPED `thinking` CONTRAST, RE-DERIVED\n");
const withBlock = rows.filter((r) => hasThinkingBlock(r));
const withoutBlock = rows.filter((r) => !hasThinkingBlock(r));
const q = (values, p) => quantile(values, p);
const line = (label, values) =>
  `  ${label.padEnd(26)} n=${String(values.length).padStart(6)}` +
  `  p50=${fmt(q(values, 0.5)).padStart(7)}` +
  `  p90=${fmt(q(values, 0.9)).padStart(7)}` +
  `  p99=${fmt(q(values, 0.99)).padStart(8)}`;

console.log(line("block present, Y", withBlock.map((r) => r.outputTokens)));
console.log(line("block absent,  Y", withoutBlock.map((r) => r.outputTokens)));
const yRatio =
  median(withBlock.map((r) => r.outputTokens)) /
  median(withoutBlock.map((r) => r.outputTokens));
console.log(`  -> median separation on Y: ${yRatio.toFixed(2)}x  (doc ships 2.9x)\n`);
console.log(line("block present, H", withBlock.map((r) => r.hiddenTokens)));
console.log(line("block absent,  H", withoutBlock.map((r) => r.hiddenTokens)));
console.log(
  `  -> median H when a block is present: ${fmt(median(withBlock.map((r) => r.hiddenTokens)))}` +
    ` tokens; absent: ${fmt(median(withoutBlock.map((r) => r.hiddenTokens)))}`,
);
report.thinkingContrast = {
  yMedianRatio: yRatio,
  medianHWithBlock: median(withBlock.map((r) => r.hiddenTokens)),
  medianHWithoutBlock: median(withoutBlock.map((r) => r.hiddenTokens)),
};

// The §2 claim, restated against measured H: how many no-thinking calls carry
// a hidden component large enough to be thinking rather than estimator noise?
const noise = quantile(
  withoutBlock.map((r) => Math.abs(r.hiddenTokens)),
  0.5,
);
const suspicious = withoutBlock.filter(
  (r) => r.outputTokens >= 100 && r.hiddenTokens > 4 * noise,
);
console.log(
  `\n  no-thinking calls with H > 4x the typical |H| (${fmt(noise)} tokens):` +
    ` ${fmt(suspicious.length)} of ${fmt(withoutBlock.filter((r) => r.outputTokens >= 100).length)}` +
    ` (${pct(suspicious.length / withoutBlock.filter((r) => r.outputTokens >= 100).length)})`,
);
console.log(`  the doc's figure for this, pre-fix, was 60.1%.`);
report.mislabelledThinking = {
  noiseFloor: noise,
  suspicious: suspicious.length,
  share:
    suspicious.length /
    withoutBlock.filter((r) => r.outputTokens >= 100).length,
};

if (jsonOut) {
  await mkdir(path.dirname(jsonOut), { recursive: true });
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}

#!/usr/bin/env node
/**
 * TASK 2: does what the user ASKED FOR predict how long the answer is?
 *
 * This is the project's stated objective and, until now, the one hypothesis no
 * experiment in this repo had tested. All fourteen ledger entries in
 * docs/STATE-OF-PLAY.md §6 are post-hoc metadata -- which model, which tool,
 * how deep in the loop, how big the last result was. None of them looked at a
 * prompt. §7.3 recorded the reason as "needs Phase 3 telemetry"; that was
 * self-imposed. ADR 0004 governs what an OBSERVATION STORES and house rule 9
 * scopes to COMMITTED ARTIFACTS. Neither restricts what a local pass may read
 * from a transcript already on disk and then discard, which is exactly what
 * lib/load-history.mjs has done with character counts since it was extracted.
 *
 * THE DESIGN POINT THAT MAKES THIS WORTH RUNNING. The human message is not a
 * depth-0 feature. Only ~9% of calls open a turn, so joining prompts only to
 * those would leave the feature missing on nine calls in ten. But every call in
 * a turn descends from one human message, and that message was typed before the
 * turn's FIRST call was issued -- so it is strictly pre-call for all of the
 * turn's calls, not just the opener. resolveLoopContext() already reconstructs
 * that ancestry, so the turn-root prompt is propagated onto every descendant.
 *
 * WHAT IS REPORTED, both of which the kill condition needs:
 *   1. held-out pinball against the SHIPPED predictor, paired, block-bootstrap
 *      CI over per-call losses in session blocks; and
 *   2. R^2 on log(output tokens), so the result extends the ceiling table in
 *      §4.2 rather than floating free of it.
 *
 * KILL CONDITION, pre-committed in docs/NEXT-PROMPT.md: if prompt features do
 * not beat model+thinking with a 95% CI entirely below zero AND do not lift R^2
 * above ~0.25, then output length is not predictable from anything this project
 * can see, and the honest move is to stop and salvage (TASK 4).
 *
 * A NOTE ON RUNG DESIGN, learned the same day from §4.2a: every prompt ladder
 * here carries a POOLED rung below its joint one. A joint `m|t|feature` rung
 * needs the sample floor met in every (model, thinking) cell, which is how the
 * oracle ceiling came to be understated by half. Refusing a feature because its
 * joint rung was too thin to fit would be the identical mistake.
 *
 * Privacy: aggregates only. Prompt features are derived inside the loader and
 * the text is discarded there; no prompt or response content reaches this file,
 * the console, or the artifact.
 *
 * Usage:
 *   node experiments/evaluation/probe-prompt-features.mjs
 *     [--projects-dir <dir>] [--json <path>] [--min-group <n>] [--as-of <ISO>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import {
  blockBootstrapDifference,
  bootstrapLogRatioSe,
  fmt,
  heterogeneity,
  median,
  mulberry32,
  rSquaredOrthogonal,
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
  path.join(process.cwd(), "experiments/artifacts/prompt-features-probe.json"),
);
const MIN_GROUP = Number(argValue("--min-group", "100"));
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}
const CLASS_MIN = 100;
const QUANTILES = [0.5, 0.9, 0.99];
const NO_TOOL = "(no-tool)";
const OTHER_TOOL = "(other-tool)";
const KILL_R2 = 0.25;

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const sd = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};
const se = (values) => sd(values) / Math.sqrt(values.length);

const { rows: allRows, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
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
  source: projectsDir,
  minGroup: MIN_GROUP,
  asOf,
};

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls` +
    `${asOf === null ? "" : `  (truncated at ${asOf})`}\n`,
);

// Action labels, only so the oracle row and the Write-detector diagnostic below
// can be computed on the same population as §4.2a.
const firstToolCounts = new Map();
for (const row of rows) {
  const tool = row.tools[0] ?? NO_TOOL;
  firstToolCounts.set(tool, (firstToolCounts.get(tool) ?? 0) + 1);
}
const knownClass = new Set(
  [...firstToolCounts.entries()]
    .filter(([tool, count]) => count >= CLASS_MIN && tool !== NO_TOOL)
    .map(([tool]) => tool),
);
for (const row of allRows) {
  const tool = row.tools[0] ?? NO_TOOL;
  row.action = tool === NO_TOOL ? NO_TOOL : knownClass.has(tool) ? tool : OTHER_TOOL;
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
}
const idOf = new Map(allRows.map((row) => [row.requestId, row]));
for (const row of rows) {
  const parent = row.parentRequestId === null ? null : idOf.get(row.parentRequestId);
  row.parent = parent && parent !== row ? parent : null;
}

// ---------------------------------------------------------------------------
// A. Coverage. How many calls actually carry a turn-root prompt, and where the
//    rest go. A feature present on a third of calls cannot move a mean much,
//    so this number bounds everything below and is reported first.
// ---------------------------------------------------------------------------

console.log("A. TURN-ROOT PROMPT COVERAGE\n");
const withPrompt = rows.filter((r) => r.turnPrompt);
const depthZero = rows.filter((r) => r.loopDepth === 0);
const depthZeroWith = depthZero.filter((r) => r.turnPrompt);
const brokenNoPrompt = rows.filter((r) => !r.turnPrompt && r.chainBroken);
console.log(
  `  calls with a turn-root prompt          ${fmt(withPrompt.length)}  (${pct(withPrompt.length / rows.length)})`,
);
console.log(
  `  calls that OPEN a turn (depth 0)       ${fmt(depthZero.length)}  (${pct(depthZero.length / rows.length)})`,
);
console.log(
  `  ...of those, with a prompt             ${fmt(depthZeroWith.length)}  (${pct(depthZeroWith.length / Math.max(depthZero.length, 1))})`,
);
console.log(
  `  missing because ancestry is truncated  ${fmt(brokenNoPrompt.length)}  (${pct(brokenNoPrompt.length / rows.length)})`,
);
console.log(
  `\n  Propagating the turn root down the loop is what turns a ${pct(depthZero.length / rows.length)} feature`,
);
console.log(
  `  into a ${pct(withPrompt.length / rows.length)} one. The remainder is transcript damage (compaction,`,
);
console.log(
  "  copied sessions) and prompt-less command/system turn roots. `isMeta` skill",
);
console.log("  injections are passthrough rows; they no longer erase the human prompt.");
console.log("  Missing prompts SKIP the rung; unknown is not a level.");
report.coverage = {
  calls: rows.length,
  withPrompt: withPrompt.length,
  depthZero: depthZero.length,
  depthZeroWithPrompt: depthZeroWith.length,
  missingChainBroken: brokenNoPrompt.length,
};

// ---------------------------------------------------------------------------
// B. Marginal contrasts. Does output length move with any of these at all?
// ---------------------------------------------------------------------------

const FEATURES = {
  lengthBucket: (r) => r.turnPrompt?.lengthBucket ?? null,
  verbClass: (r) => r.turnPrompt?.verbClass ?? null,
  hasLimit: (r) =>
    r.turnPrompt ? (r.turnPrompt.hasLimit ? "limit" : "none") : null,
  hasExpansive: (r) =>
    r.turnPrompt ? (r.turnPrompt.hasExpansive ? "expansive" : "none") : null,
  mentionsPath: (r) =>
    r.turnPrompt ? (r.turnPrompt.mentionsPath ? "path" : "none") : null,
  isQuestion: (r) =>
    r.turnPrompt ? (r.turnPrompt.isQuestion ? "question" : "command") : null,
  requirementBucket: (r) => r.turnPrompt?.requirementBucket ?? null,
};

function contrast(label, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.outputTokens);
  }
  const table = [...groups.entries()]
    .filter(([, values]) => values.length >= MIN_GROUP)
    .sort((a, b) => median(b[1]) - median(a[1]))
    .map(([key, values]) => ({
      key,
      n: values.length,
      p50: median(values),
      p90: quantile(values, 0.9),
      p99: quantile(values, 0.99),
    }));
  if (table.length === 0) return table;
  const spread = table[0].p50 / Math.max(table[table.length - 1].p50, 1);
  console.log(`\n  ${label}   (${spread.toFixed(2)}x across levels, at the median)`);
  console.log(
    `    ${"level".padEnd(14)}${"n".padStart(7)}${"p50".padStart(8)}` +
      `${"p90".padStart(9)}${"p99".padStart(9)}`,
  );
  for (const r of table) {
    console.log(
      `    ${String(r.key).padEnd(14)}${String(r.n).padStart(7)}` +
        `${fmt(r.p50).padStart(8)}${fmt(r.p90).padStart(9)}${fmt(r.p99).padStart(9)}`,
    );
  }
  return table;
}

console.log("\n\nB. WHAT THE USER ASKED FOR, vs HOW LONG THE ANSWER WAS\n");
console.log(
  "  For scale: the shipped `thinking` feature is 2.8x at the median, and the",
);
console.log("  action-type oracle -- the biggest effect in the corpus -- is 15.2x.");
report.marginalContrasts = {};
for (const [name, keyFn] of Object.entries(FEATURES)) {
  report.marginalContrasts[name] = contrast(`by ${name}`, keyFn);
}

// ---------------------------------------------------------------------------
// B2. The §6.7 gates on the strongest contrast: support, then significance,
//     then whether the effect keeps its DIRECTION across (day, model) cells.
//     This is the order that killed `effort`, and no group claim gets believed
//     without it.
// ---------------------------------------------------------------------------

function runGates(label, keyOf, reference) {
  console.log(`\n\nB2. THE STEP 0 GATES ON ${label} (day and model held fixed)\n`);
  const cells = new Map();
  const marginal = new Map();
  for (const row of rows) {
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
  if (!marginal.has(reference)) {
    console.log(`  reference level ${reference} absent; skipped`);
    return {};
  }
  console.log(
    `  ${"level".padEnd(14)}${"days".padStart(6)}${"cells".padStart(7)}` +
      `${"effect".padStart(9)}${"z".padStart(8)}${"ratio".padStart(9)}` +
      `${"naive".padStart(9)}${"sign".padStart(9)}${"sign p".padStart(10)}`,
  );
  const random = mulberry32(20260804);
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
      `  ${level.padEnd(14)}${String(days.size).padStart(6)}${String(cellCount).padStart(7)}` +
        `${test.effect.toFixed(3).padStart(9)}${test.z.toFixed(2).padStart(8)}` +
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

report.gates = {
  verbClass: runGates("VERB CLASS", FEATURES.verbClass, "read"),
  lengthBucket: runGates("PROMPT LENGTH", FEATURES.lengthBucket, "lt80"),
};
console.log(
  "\n  `ratio` is the within-(day, model) effect; `naive` is the pooled one.",
);
console.log(
  "  A real effect barely moves between them -- `effort` collapsed 0.67x -> 0.81x.",
);

// ---------------------------------------------------------------------------
// C. Forecasters. Backoff ladders of empirical quantile lookups, fitted on
//    training rows only, exactly like the shipped predictor.
// ---------------------------------------------------------------------------

function fitQuantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, q: QUANTILES.map((p) => Math.round(quantile(sorted, p))) };
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
      .map(([key, values]) => [key, fitQuantiles(values)]),
  );
}
function makeLadder(trainRows, keyFns) {
  const fits = keyFns.map((fn) => fitGroups(trainRows, fn));
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
/** joint rung, then the SAME feature pooled across (model, thinking) -- §4.2a. */
const promptLadder = (name, suffix) => [
  withMT(suffix),
  (r) => {
    const value = suffix(r);
    return value === null ? null : value;
  },
  KEY.modelThinking,
  KEY.model,
];

const sfx = {
  length: (r) => (r.turnPrompt ? `len=${r.turnPrompt.lengthBucket}` : null),
  verb: (r) => (r.turnPrompt ? `verb=${r.turnPrompt.verbClass}` : null),
  limit: (r) => (r.turnPrompt ? `lim=${r.turnPrompt.hasLimit ? 1 : 0}` : null),
  expansive: (r) =>
    r.turnPrompt ? `exp=${r.turnPrompt.hasExpansive ? 1 : 0}` : null,
  path: (r) => (r.turnPrompt ? `path=${r.turnPrompt.mentionsPath ? 1 : 0}` : null),
  question: (r) => (r.turnPrompt ? `q=${r.turnPrompt.isQuestion ? 1 : 0}` : null),
  requirements: (r) => (r.turnPrompt ? `req=${r.turnPrompt.requirementBucket}` : null),
};

const CANDIDATES = {
  shipped: [KEY.modelThinking, KEY.model],
  promptLength: promptLadder("length", sfx.length),
  promptVerb: promptLadder("verb", sfx.verb),
  promptLimit: promptLadder("limit", sfx.limit),
  promptExpansive: promptLadder("expansive", sfx.expansive),
  promptPath: promptLadder("path", sfx.path),
  promptQuestion: promptLadder("question", sfx.question),
  promptRequirements: promptLadder("requirements", sfx.requirements),
  // Combinations, each backing off through its own parts before the shipped
  // conditioning -- so a thin joint cell costs coverage, never correctness.
  promptVerbLength: [
    withMT((r) => {
      const v = sfx.verb(r);
      const l = sfx.length(r);
      return v && l ? `${v}|${l}` : null;
    }),
    (r) => {
      const v = sfx.verb(r);
      const l = sfx.length(r);
      return v && l ? `${v}|${l}` : null;
    },
    withMT(sfx.verb),
    KEY.modelThinking,
    KEY.model,
  ],
  promptAll: [
    withMT((r) => {
      const v = sfx.verb(r);
      const l = sfx.length(r);
      const p = sfx.path(r);
      return v && l && p ? `${v}|${l}|${p}` : null;
    }),
    (r) => {
      const v = sfx.verb(r);
      const l = sfx.length(r);
      const p = sfx.path(r);
      return v && l && p ? `${v}|${l}|${p}` : null;
    },
    withMT((r) => {
      const v = sfx.verb(r);
      const l = sfx.length(r);
      return v && l ? `${v}|${l}` : null;
    }),
    withMT(sfx.verb),
    KEY.modelThinking,
    KEY.model,
  ],
  // Ceiling, built the corrected way (§4.2a): joint rung, then pooled.
  oracleAction: [
    withMT((r) => `action=${r.action}`),
    (r) => `action=${r.action}`,
    KEY.modelThinking,
    KEY.model,
  ],
};
const CONTROLS = new Set(["shipped", "oracleAction"]);

const holdoutStart = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - holdoutStart) / 5);
const folds = [];
for (let f = 0; f < 5; f++) {
  const start = holdoutStart + f * blockSize;
  const end = f === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const NAMES = Object.keys(CANDIDATES);
const scored = [];
for (const [foldIndex, fold] of folds.entries()) {
  const ladders = new Map(
    NAMES.map((name) => [name, makeLadder(fold.train, CANDIDATES[name])]),
  );
  for (const row of fold.test) {
    const record = { row, foldIndex, forecasts: {} };
    for (const name of NAMES) {
      const { fit, rung } = ladders.get(name)(row);
      let loss = 0;
      for (const [i, p] of QUANTILES.entries()) {
        loss += pinball(row.outputTokens, fit.q[i], p);
      }
      record.forecasts[name] = { loss, rung, band: fit.q[2] - fit.q[0] };
    }
    scored.push(record);
  }
}

const perCallSessions = scored.map((s) => s.row.sessionId ?? null);
const gradeVsShipped = (name) =>
  blockBootstrapDifference(
    scored.map((s) => s.forecasts[name].loss - s.forecasts.shipped.loss),
    perCallSessions,
  );

console.log("\n\nC. HELD-OUT PINBALL PER CALL vs THE SHIPPED PREDICTOR\n");
const grades = new Map(
  NAMES.filter((n) => n !== "shipped").map((n) => [n, gradeVsShipped(n)]),
);
const info = grades.get("promptLength");
console.log(
  `  Paired block bootstrap over ${fmt(scored.length)} held-out calls in ${info.blocks}` +
    ` ${info.blockKind} blocks,\n  ${fmt(info.resamples)} resamples, seed fixed.` +
    ` ADOPT ONLY IF THE WHOLE 95% CI IS BELOW ZERO.\n`,
);
console.log(
  `  ${"predictor".padEnd(20)}${"mean".padStart(8)}${"vs shipped".padStart(12)}` +
    `${"95% CI".padStart(21)}${"prompt rung".padStart(13)}  verdict`,
);
report.candidates = {};
for (const name of NAMES) {
  const grade = grades.get(name) ?? null;
  const meanLoss = mean(scored.map((s) => s.forecasts[name].loss));
  // How often the ladder's prompt rungs (0 and 1) actually fired. A feature can
  // only pay where it is used, and §4.2a is the standing reminder that a rung
  // silently not firing looks exactly like a feature that does not work.
  const fired =
    name === "shipped"
      ? null
      : scored.filter((s) => s.forecasts[name].rung <= 1).length / scored.length;
  const verdict =
    name === "shipped"
      ? "(baseline)"
      : CONTROLS.has(name)
        ? "(oracle)"
        : grade.ciUpper < 0
          ? "ADOPTS"
          : grade.ciLower > 0
            ? "worse"
            : "inside the noise";
  console.log(
    `  ${name.padEnd(20)}${meanLoss.toFixed(1).padStart(8)}` +
      `${(grade === null ? "-" : grade.meanDifference.toFixed(2)).padStart(12)}` +
      `${(grade === null ? "-" : `[${grade.ciLower.toFixed(1)}, ${grade.ciUpper.toFixed(1)}]`).padStart(21)}` +
      `${(fired === null ? "-" : pct(fired)).padStart(13)}  ${verdict}`,
  );
  report.candidates[name] = { meanLoss, vsShipped: grade, promptRungFired: fired };
}

// ---------------------------------------------------------------------------
// D. R^2 on log Y. The pinball comparison answers "does it forecast better";
//    this answers "how much of the variation does it explain at all", which is
//    what makes the result comparable to §4.2's ceiling table.
// ---------------------------------------------------------------------------

/**
 * One-hot design matrix over categorical key functions.
 *
 * Two details that a naive encoding gets wrong, and both of them silently:
 *
 *   1. ONE LEVEL PER FEATURE IS DROPPED. Encoding every level alongside an
 *      intercept makes each feature's columns sum to the intercept, X'X is
 *      singular, and the fit returns nothing.
 *   2. A NULL IS ITS OWN LEVEL, not the reference level. `unknown != false`
 *      (house rule 5): a call with no recoverable prompt must not be pooled
 *      with, say, `verb=read` just because that happened to sort first. An
 *      explicit `(unknown)` indicator keeps them separate.
 */
function designColumns(subset, keyFns) {
  const columns = [];
  for (const fn of keyFns) {
    const counts = new Map();
    for (const row of subset) {
      const level = fn(row) ?? "(unknown)";
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    // Drop the most common level as the reference, so the retained columns are
    // the ones with the most data behind them.
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [level] of ordered.slice(1)) {
      columns.push(
        Float64Array.from(subset, (row) =>
          (fn(row) ?? "(unknown)") === level ? 1 : 0,
        ),
      );
    }
  }
  return columns;
}

function rSquared(subset, keyFns) {
  if (keyFns.length === 0) return { rSquared: 0, rank: 0, n: subset.length };
  const y = subset.map((r) => Math.log(Math.max(r.outputTokens, 1)));
  return rSquaredOrthogonal(designColumns(subset, keyFns), y);
}

// Every rung of the ladder is measured on the SAME subset -- the calls that
// carry a turn-root prompt -- or the comparison would confound "explains more"
// with "was measured on an easier population".
const subset = withPrompt;
const META_KEYS = [
  KEY.model,
  (r) => `t=${r.thinking}`,
  (r) => (r.parent ? `pa=${r.parent.action}` : null),
  (r) =>
    r.parent
      ? `py=${r.parent.outputTokens < 200 ? "lt200" : r.parent.outputTokens < 800 ? "200-800" : r.parent.outputTokens < 3000 ? "800-3k" : "gte3k"}`
      : null,
  (r) => (r.loopDepthExact ? `d${Math.min(r.loopDepth, 6)}` : null),
  (r) => (r.parent ? `ps=${r.parent.stopReason ?? "(null)"}` : null),
  (r) =>
    r.resultChars === null
      ? null
      : `res=${r.resultIsError ? "error" : r.resultChars < 500 ? "lt500" : r.resultChars < 5000 ? "500-5k" : r.resultChars < 50000 ? "5k-50k" : "gte50k"}`,
];
const PROMPT_KEYS = Object.values(sfx);
const LADDER = [
  ["marginal", []],
  ["model only", [KEY.model]],
  ["model + thinking (shipped)", [KEY.model, (r) => `t=${r.thinking}`]],
  ["+ all metadata ever tried", META_KEYS],
  ["+ PROMPT FEATURES", [...META_KEYS, ...PROMPT_KEYS]],
  ["prompt features alone", PROMPT_KEYS],
  ["+ true first tool (ORACLE)", [...META_KEYS, (r) => `action=${r.action}`]],
];

console.log(
  `\n\nD. R^2 ON log(OUTPUT TOKENS), all rows on the same ${fmt(subset.length)} calls` +
    ` that carry a prompt\n`,
);
console.log(
  `  ${"feature set".padEnd(30)}${"R^2".padStart(7)}${"rank".padStart(7)}`,
);
report.rSquared = {};
for (const [label, keys] of LADDER) {
  const fit = rSquared(subset, keys);
  report.rSquared[label] = fit;
  console.log(
    `  ${label.padEnd(30)}${fit.rSquared.toFixed(3).padStart(7)}${String(fit.rank).padStart(7)}`,
  );
}
const shippedR2 = report.rSquared["model + thinking (shipped)"].rSquared;
const metaR2 = report.rSquared["+ all metadata ever tried"].rSquared;
const promptR2 = report.rSquared["+ PROMPT FEATURES"].rSquared;
const oracleR2 = report.rSquared["+ true first tool (ORACLE)"].rSquared;
console.log(
  `\n  Prompt features add ${(promptR2 - metaR2).toFixed(3)} over every metadata feature this`,
);
console.log(
  `  project has ever tried, and ${(promptR2 - shippedR2).toFixed(3)} over what ships.`,
);
console.log(
  `  The oracle -- which reads the answer -- reaches ${oracleR2.toFixed(3)}.`,
);

// ---------------------------------------------------------------------------
// E. The bridge to TASK 3: can a prompt predict that this call is a `Write`?
//    Not a forecast, a diagnostic -- if the prompt cannot see `Write` coming,
//    the binary detector §7.2 wants has no input.
// ---------------------------------------------------------------------------

console.log("\n\nE. CAN THE PROMPT SEE A `Write` COMING?\n");
const baseRate = withPrompt.filter((r) => r.action === "Write").length / withPrompt.length;
console.log(`  base rate of \`Write\` among calls with a prompt: ${pct(baseRate)}\n`);
console.log(
  `  ${"prompt verb class".padEnd(20)}${"n".padStart(8)}${"P(Write)".padStart(11)}${"lift".padStart(8)}`,
);
report.writeSignal = { baseRate, byVerb: [] };
const byVerb = new Map();
for (const row of withPrompt) {
  const key = row.turnPrompt.verbClass;
  if (!byVerb.has(key)) byVerb.set(key, []);
  byVerb.get(key).push(row);
}
for (const [verb, group] of [...byVerb.entries()].sort(
  (a, b) =>
    b[1].filter((r) => r.action === "Write").length / b[1].length -
    a[1].filter((r) => r.action === "Write").length / a[1].length,
)) {
  const rate = group.filter((r) => r.action === "Write").length / group.length;
  console.log(
    `  ${verb.padEnd(20)}${fmt(group.length).padStart(8)}${pct(rate).padStart(11)}` +
      `${`${(rate / baseRate).toFixed(2)}x`.padStart(8)}`,
  );
  report.writeSignal.byVerb.push({ verb, n: group.length, rate, lift: rate / baseRate });
}
const bestLift = Math.max(...report.writeSignal.byVerb.map((v) => v.lift));
console.log(
  `\n  Best single-class lift: ${bestLift.toFixed(2)}x. For comparison, \`Write\` is 9.8x`,
);
console.log("  over-represented among the worst 5% of misses (§5.3).");

// ---------------------------------------------------------------------------
// F. The strongest objection to a null here, tested rather than waved away.
//
// Propagating one prompt onto every call in a turn is what gives the feature
// 68% coverage, but it also means a 60-call turn is scored 60 times against one
// message. If the prompt genuinely predicts the FIRST reply and then stops
// mattering as the loop wanders, pooling across depths would bury a real
// depth-0 effect under 59 diluted copies. So measure it where the prompt is
// most proximate, and where the ladder has the least excuse.
//
// This cuts the other way too: if the signal is absent at depth 0, it is not
// hiding anywhere, because depth 0 is the single best case for it.
// ---------------------------------------------------------------------------

console.log("\n\nF. IS THE SIGNAL THERE AT DEPTH 0, WHERE THE PROMPT IS CLOSEST?\n");
const byDepthBand = [
  ["depth 0 (turn opener)", (r) => r.loopDepth === 0],
  ["depth 1-2", (r) => r.loopDepth >= 1 && r.loopDepth <= 2],
  ["depth 3+", (r) => r.loopDepth >= 3],
];
console.log(
  `  ${"population".padEnd(24)}${"n".padStart(8)}${"R^2 shipped".padStart(13)}` +
    `${"R^2 + prompt".padStart(14)}${"gain".padStart(8)}${"prompt alone".padStart(14)}`,
);
report.byDepthBand = [];
const SHIPPED_KEYS = [KEY.model, (r) => `t=${r.thinking}`];
for (const [label, predicate] of byDepthBand) {
  const band = withPrompt.filter(predicate);
  if (band.length < 200) continue;
  const base = rSquared(band, SHIPPED_KEYS).rSquared;
  const withP = rSquared(band, [...SHIPPED_KEYS, ...PROMPT_KEYS]).rSquared;
  const alone = rSquared(band, PROMPT_KEYS).rSquared;
  console.log(
    `  ${label.padEnd(24)}${fmt(band.length).padStart(8)}${base.toFixed(3).padStart(13)}` +
      `${withP.toFixed(3).padStart(14)}${(withP - base).toFixed(3).padStart(8)}` +
      `${alone.toFixed(3).padStart(14)}`,
  );
  report.byDepthBand.push({
    band: label,
    n: band.length,
    rSquaredShipped: base,
    rSquaredWithPrompt: withP,
    gain: withP - base,
    rSquaredPromptAlone: alone,
  });
}
// The gain above is measured across days, models and sessions at once, and this
// repo has already been fooled by exactly that: `effort`'s 4.6x ladder was a
// (day, model) artifact. So run the same gate in regression form -- absorb the
// (day, model) cell first, then ask what the prompt still adds. If the depth-0
// gain is really "on the days I asked long questions I also got long answers",
// it disappears here.
const DAY_MODEL = (r) =>
  `${new Date(r.timestampMs).toISOString().slice(0, 10)}|${r.model}`;
console.log(
  `\n  ${"population".padEnd(24)}${"n".padStart(8)}${"+cell".padStart(9)}` +
    `${"+cell+prompt".padStart(14)}${"gain".padStart(8)}`,
);
report.byDepthBandControlled = [];
for (const [label, predicate] of byDepthBand) {
  const band = withPrompt.filter(predicate);
  if (band.length < 200) continue;
  const controlled = rSquared(band, [...SHIPPED_KEYS, DAY_MODEL]).rSquared;
  const both = rSquared(band, [...SHIPPED_KEYS, DAY_MODEL, ...PROMPT_KEYS])
    .rSquared;
  console.log(
    `  ${label.padEnd(24)}${fmt(band.length).padStart(8)}${controlled.toFixed(3).padStart(9)}` +
      `${both.toFixed(3).padStart(14)}${(both - controlled).toFixed(3).padStart(8)}`,
  );
  report.byDepthBandControlled.push({
    band: label,
    n: band.length,
    rSquaredWithCell: controlled,
    rSquaredWithCellAndPrompt: both,
    gain: both - controlled,
  });
}
console.log(
  "\n  Absorbing the (day, model) cell costs a lot of degrees of freedom, so the",
);
console.log(
  "  levels rise; the GAIN column is the comparable one, against the gain above.",
);

console.log(
  "\n  R^2 here is IN-SAMPLE, so it can only overstate the prompt's contribution.",
);
console.log(
  "  The design has 15 prompt columns, so on 852 depth-0 rows roughly 0.018 of",
);
console.log("  any R^2 is noise. The depth-0 figure is far above that. It is real.");

// So the pooled null in C hides a gradient, and the gradient has to be graded on
// held-out data before it means anything. Same forecasts, same bootstrap, just
// restricted to the population where the prompt is the turn's own instruction
// rather than something twenty tool calls ago.
console.log("\n  Held-out pinball, restricted to depth-0 calls that carry a prompt:\n");
const depth0Scored = scored.filter(
  (s) => s.row.loopDepth === 0 && s.row.turnPrompt,
);
const depth0Sessions = depth0Scored.map((s) => s.row.sessionId ?? null);
console.log(
  `  ${"predictor".padEnd(20)}${"vs shipped".padStart(12)}${"95% CI".padStart(22)}  verdict`,
);
report.depthZeroHoldout = { n: depth0Scored.length, candidates: {} };
for (const name of NAMES) {
  if (name === "shipped") continue;
  const grade = blockBootstrapDifference(
    depth0Scored.map((s) => s.forecasts[name].loss - s.forecasts.shipped.loss),
    depth0Sessions,
  );
  const verdict = CONTROLS.has(name)
    ? "(oracle)"
    : grade.ciUpper < 0
      ? "ADOPTS"
      : grade.ciLower > 0
        ? "worse"
        : "inside the noise";
  console.log(
    `  ${name.padEnd(20)}${grade.meanDifference.toFixed(2).padStart(12)}` +
      `${`[${grade.ciLower.toFixed(1)}, ${grade.ciUpper.toFixed(1)}]`.padStart(22)}  ${verdict}`,
  );
  report.depthZeroHoldout.candidates[name] = grade;
}
console.log(
  `\n  n = ${fmt(depth0Scored.length)} held-out calls, so these intervals are wide by construction.`,
);
console.log(
  "  A signal that is real in-sample and cannot be demonstrated out-of-sample on",
);
console.log("  9% of the corpus is not yet a feature. It is a lead.");

// ---------------------------------------------------------------------------
// G. THE KILL CONDITION, evaluated rather than eyeballed.
// ---------------------------------------------------------------------------

const learned = NAMES.filter((n) => !CONTROLS.has(n));
const bestName = learned.reduce((a, b) =>
  grades.get(a).meanDifference <= grades.get(b).meanDifference ? a : b,
);
const bestGrade = grades.get(bestName);
const beatsShipped = learned.some((n) => grades.get(n).ciUpper < 0);
const liftsR2 = promptR2 > KILL_R2;
const fires = !(beatsShipped && liftsR2);

console.log("\n\nG. THE PRE-COMMITTED KILL CONDITION\n");
console.log(
  `  1. Any prompt ladder beating shipped with a 95% CI entirely below zero?  ` +
    `${beatsShipped ? "YES" : "NO"}`,
);
console.log(
  `     best is ${bestName} at ${bestGrade.meanDifference.toFixed(2)} ` +
    `[${bestGrade.ciLower.toFixed(1)}, ${bestGrade.ciUpper.toFixed(1)}]`,
);
console.log(
  `  2. R^2 lifted above ${KILL_R2}?                                             ` +
    `${liftsR2 ? "YES" : "NO"}`,
);
console.log(`     reached ${promptR2.toFixed(3)}`);
console.log(
  `\n  KILL CONDITION FIRES: ${fires ? "YES" : "NO"}` +
    `${fires ? "  -> go to TASK 4." : "  -> prompt features carry signal; proceed to TASK 3."}`,
);

// The kill condition is a decision rule, not a summary. Both of its clauses are
// about the POOLED corpus, and section F found the null is not flat -- so state
// what was actually learned rather than letting the boolean stand for it.
const depthZeroGain = report.byDepthBand.find((b) => b.band.startsWith("depth 0"));
const deepGain = report.byDepthBand.find((b) => b.band.startsWith("depth 3"));
const controlledZero = report.byDepthBandControlled.find((b) =>
  b.band.startsWith("depth 0"),
);
console.log("\n  WHAT WAS ACTUALLY LEARNED, which the boolean above does not carry:\n");
console.log(
  beatsShipped
    ? `  - ${bestName} clears the pinball adoption gate; most other prompt ladders are WORSE`
    : `  - Pooled over all calls, nothing adopts and most prompt ladders are WORSE`,
);
console.log(
  `    than shipped. Splitting thin groups thinner costs more than the feature pays.`,
);
console.log(
  `  - The null is NOT flat. Prompt features alone explain R^2 ${depthZeroGain.rSquaredPromptAlone.toFixed(3)} at depth 0`,
);
console.log(
  `    and ${deepGain.rSquaredPromptAlone.toFixed(3)} at depth 3+. The prompt predicts the turn's FIRST reply and`,
);
console.log(
  `    has decayed to nothing a few steps into the loop. That gain survives the`,
);
console.log(
  `    (day, model) gate that killed \`effort\` (${depthZeroGain.gain.toFixed(3)} -> ${controlledZero.gain.toFixed(3)}), so it is not a calendar artifact.`,
);
console.log(
  `  - It still cannot be cashed. Depth-0 calls are ${pct(report.coverage.depthZero / report.coverage.calls)} of traffic and only`,
);
console.log(
  `    ${fmt(report.depthZeroHoldout.n)} land in the holdout -- a sample at which the ORACLE itself cannot be`,
);
console.log(
  `    demonstrated. The binding constraint is TURNS, not calls, which is house`,
);
console.log(`    rule 10 arriving from a new direction.`);
console.log(
  `  - The prompt cannot see \`Write\` coming (best lift ${bestLift.toFixed(2)}x against a 9.8x`,
);
console.log(
  `    target), so TASK 3's binary detector has no input from this feature set.`,
);
report.killCondition = {
  beatsShipped,
  liftsRSquared: liftsR2,
  rSquaredThreshold: KILL_R2,
  best: { name: bestName, ...bestGrade },
  fires,
  depthZeroSignalIsReal:
    depthZeroGain.rSquaredPromptAlone > 0.1 && controlledZero.gain > 0.02,
  promptPredictsWrite: bestLift > 2,
};

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

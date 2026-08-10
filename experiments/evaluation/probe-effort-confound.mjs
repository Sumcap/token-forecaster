#!/usr/bin/env node
/**
 * STEP 0 of docs/NEXT-PROMPT.md: is the `effort` signal real, or is it date?
 *
 * docs/GENERATIVE-MODEL.md §3 reports a monotone 4.6x median separation from
 * effort=low to effort=max and proposes promoting `effort` to a shipped
 * dimension. §8 names the confound that would kill it: `effort` is only
 * recorded on newer transcript rows, so the levels may be tracking date, model
 * and workload drift rather than the request setting.
 *
 * This script is the falsification test, and it is deliberately harsher than
 * "restrict to the date window". Restricting to the window is not enough,
 * because within the window the levels are still not spread evenly over days or
 * models. The question that actually matters is:
 *
 *     Is there ANY (day, model) cell in which two effort levels are both
 *     observed? If not, the contrast between them is not identified at all,
 *     and no amount of statistics recovers it.
 *
 * Sections:
 *   1. Identifiability -- the (day, model) support of each effort level.
 *   2. Naive contrast, reproduced, then restricted to the observation window.
 *   3. Within-cell contrast -- stratified rank test holding day and model fixed.
 *   4. Regression -- log Y ~ effort + day FE + model FE, session-clustered SEs.
 *   5. Placebo -- how large a median ratio do two random cells produce under a
 *      null in which effort does nothing? Calibrates the headline 4.6x.
 *
 * Privacy: aggregates only. No prompt or response text is read or written.
 *
 * Usage:
 *   node experiments/evaluation/probe-effort-confound.mjs
 *     [--projects-dir <dir>]
 *     [--json <path>]
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

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const REFERENCE = "high";

// ---------------------------------------------------------------------------
// helpers -- the statistics live in lib/stats.mjs so later probes apply the
// same gates this one applied to `effort`
// ---------------------------------------------------------------------------

const day = (row) => new Date(row.timestampMs).toISOString().slice(0, 10);
const cellKey = (row) => `${day(row)}|${row.model}`;

// ---------------------------------------------------------------------------
// OLS with cluster-robust standard errors
// ---------------------------------------------------------------------------

function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null; // rank-deficient
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

function olsClustered(X, y, clusters) {
  const n = X.length;
  const p = X[0].length;
  const xtx = Array.from({ length: p }, () => new Float64Array(p));
  const xty = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      if (X[i][a] === 0) continue;
      xty[a] += X[i][a] * y[i];
      for (let b = a; b < p; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];

  const inverse = invert(xtx.map((row) => [...row]));
  if (!inverse) return null;
  const beta = new Float64Array(p);
  for (let a = 0; a < p; a++) {
    let sum = 0;
    for (let b = 0; b < p; b++) sum += inverse[a][b] * xty[b];
    beta[a] = sum;
  }

  // meat = sum over clusters of (X_g' e_g)(X_g' e_g)'
  const scores = new Map();
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let a = 0; a < p; a++) fitted += X[i][a] * beta[a];
    const residual = y[i] - fitted;
    const key = clusters[i];
    if (!scores.has(key)) scores.set(key, new Float64Array(p));
    const s = scores.get(key);
    for (let a = 0; a < p; a++) s[a] += X[i][a] * residual;
  }
  const meat = Array.from({ length: p }, () => new Float64Array(p));
  for (const s of scores.values()) {
    for (let a = 0; a < p; a++) {
      if (s[a] === 0) continue;
      for (let b = 0; b < p; b++) meat[a][b] += s[a] * s[b];
    }
  }
  const g = scores.size;
  const scale = (g / Math.max(g - 1, 1)) * ((n - 1) / Math.max(n - p, 1));
  const se = new Float64Array(p);
  for (let a = 0; a < p; a++) {
    let variance = 0;
    for (let b = 0; b < p; b++) {
      for (let c = 0; c < p; c++) {
        variance += inverse[a][b] * meat[b][c] * inverse[c][a];
      }
    }
    se[a] = Math.sqrt(Math.max(variance * scale, 0));
  }
  return { beta, se, n, clusters: g };
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

const { rows: allRows, filesScanned } = await loadRequests(projectsDir);
const rows = allRows.filter((row) => Number.isFinite(row.timestampMs));
const report = { generatedAt: new Date().toISOString(), source: projectsDir };

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(allRows.length)} unique API calls` +
    ` (${fmt(rows.length)} with usable timestamps)\n`,
);

const withEffort = rows.filter((row) => LEVELS.includes(row.effort));
const days = [...new Set(rows.map(day))].sort();
const effortDays = [...new Set(withEffort.map(day))].sort();
const firstEffortDay = effortDays[0];
const inWindow = rows.filter((row) => day(row) >= firstEffortDay);
const nullInWindow = inWindow.filter((row) => !LEVELS.includes(row.effort));

report.window = {
  corpusSpan: [days[0], days.at(-1)],
  firstEffortDay,
  rowsInWindow: inWindow.length,
  nullRowsInWindow: nullInWindow.length,
};

console.log("0. THE OBSERVATION WINDOW\n");
console.log(`  corpus spans            ${days[0]} .. ${days.at(-1)}  (${days.length} days)`);
console.log(`  effort first recorded   ${firstEffortDay}`);
console.log(
  `  rows in window          ${fmt(inWindow.length)} of ${fmt(rows.length)}` +
    `  (${pct(inWindow.length / rows.length)} of corpus)`,
);
console.log(
  `  effort=null in window   ${fmt(nullInWindow.length)}` +
    `  (${pct(nullInWindow.length / inWindow.length)} of window rows)`,
);
console.log(
  `  effort=null outside     ${fmt(rows.length - inWindow.length)}` +
    `  -- so null is ~entirely a date split, as §3 assumed.`,
);

// ---------------------------------------------------------------------------
// 1. Identifiability
// ---------------------------------------------------------------------------

console.log("\n1. IDENTIFIABILITY: the (day, model) support of each level\n");
console.log(
  "   A level whose cells contain no reference-level rows cannot be compared",
  "\n   to the reference at all once day and model are held fixed.\n",
);

const cells = new Map();
for (const row of withEffort) {
  const key = cellKey(row);
  if (!cells.has(key)) cells.set(key, new Map());
  const byLevel = cells.get(key);
  if (!byLevel.has(row.effort)) byLevel.set(row.effort, []);
  byLevel.get(row.effort).push(row.outputTokens);
}

report.identifiability = {};
console.log(
  `  ${"level".padEnd(8)}${"n".padStart(6)}${"days".padStart(6)}` +
    `${"models".padStart(8)}${"cells".padStart(7)}` +
    `${"shared w/ high".padStart(16)}${"n in shared".padStart(13)}`,
);
for (const level of LEVELS) {
  const group = withEffort.filter((row) => row.effort === level);
  if (group.length === 0) continue;
  const levelDays = new Set(group.map(day));
  const models = new Set(group.map((row) => row.model));
  const levelCells = new Set(group.map(cellKey));
  let sharedCells = 0;
  let nShared = 0;
  for (const key of levelCells) {
    const byLevel = cells.get(key);
    if (level !== REFERENCE && byLevel.has(REFERENCE)) {
      sharedCells++;
      nShared += byLevel.get(level).length;
    }
  }
  const identified = level === REFERENCE || sharedCells > 0;
  console.log(
    `  ${level.padEnd(8)}${String(group.length).padStart(6)}` +
      `${String(levelDays.size).padStart(6)}${String(models.size).padStart(8)}` +
      `${String(levelCells.size).padStart(7)}` +
      `${(level === REFERENCE ? "--" : String(sharedCells)).padStart(16)}` +
      `${(level === REFERENCE ? "--" : String(nShared)).padStart(13)}` +
      `${identified ? "" : "   <- NOT IDENTIFIED"}`,
  );
  report.identifiability[level] = {
    n: group.length,
    days: levelDays.size,
    models: [...models],
    cells: levelCells.size,
    cellsSharedWithReference: level === REFERENCE ? null : sharedCells,
    nInSharedCells: level === REFERENCE ? null : nShared,
  };
}

console.log("\n  model mix within each level (a level pinned to one model is");
console.log("  confounded with that model's own output-length distribution):");
for (const level of LEVELS) {
  const group = withEffort.filter((row) => row.effort === level);
  if (group.length === 0) continue;
  const counts = new Map();
  for (const row of group) counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
  const mix = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => `${model} ${pct(count / group.length)}`)
    .join(", ");
  console.log(`    ${level.padEnd(8)} ${mix}`);
}

// ---------------------------------------------------------------------------
// 2. Naive contrast, then window-restricted
// ---------------------------------------------------------------------------

console.log("\n2. THE NAIVE CONTRAST, AND WHAT RESTRICTING THE WINDOW DOES\n");

function levelQuantiles(source, label) {
  console.log(`  ${label}`);
  const out = {};
  for (const level of LEVELS) {
    const values = source
      .filter((row) => row.effort === level)
      .map((row) => row.outputTokens);
    if (values.length === 0) continue;
    out[level] = {
      n: values.length,
      p50: median(values),
      p90: quantile(values, 0.9),
      p99: quantile(values, 0.99),
    };
    console.log(
      `    effort=${level.padEnd(7)} n=${String(values.length).padStart(5)}` +
        `  p50=${fmt(out[level].p50).padStart(6)}` +
        `  p90=${fmt(out[level].p90).padStart(6)}` +
        `  p99=${fmt(out[level].p99).padStart(7)}`,
    );
  }
  const ratio = out.low && out.max ? out.max.p50 / out.low.p50 : null;
  if (ratio) console.log(`    low -> max median ratio: ${ratio.toFixed(2)}x`);
  return { levels: out, lowToMaxRatio: ratio };
}

report.naive = levelQuantiles(withEffort, "all effort-labelled rows (reproduces §3):");
console.log();
report.windowRestricted = levelQuantiles(
  withEffort.filter((row) => day(row) >= firstEffortDay),
  `restricted to days >= ${firstEffortDay}:`,
);
console.log(
  "\n  Restricting the window changes nothing, because every effort-labelled",
);
console.log(
  "  row is already inside it. The window test in §8 is necessary but far",
);
console.log("  too weak -- the real confound is WITHIN the window (section 1).");

// ---------------------------------------------------------------------------
// 3. Within-cell stratified contrast
// ---------------------------------------------------------------------------

console.log(`\n3. WITHIN-CELL CONTRAST vs effort=${REFERENCE} (day and model held fixed)\n`);
console.log(
  "   Stratified rank test. effect = P(Y_level > Y_high) within a shared cell;",
);
console.log("   0.50 means no difference. |z| > 2 is the usual significance bar.\n");

report.withinCell = {};
for (const level of LEVELS) {
  if (level === REFERENCE) continue;
  const strata = [];
  const logRatios = [];
  for (const byLevel of cells.values()) {
    const treated = byLevel.get(level);
    const control = byLevel.get(REFERENCE);
    if (!treated || !control) continue;
    strata.push({ treated, control });
    if (treated.length >= 10 && control.length >= 10) {
      logRatios.push({
        weight: Math.min(treated.length, control.length),
        value: Math.log(median(treated) / median(control)),
      });
    }
  }
  const test = stratifiedRankTest(strata);
  if (!test) {
    console.log(
      `  ${level.padEnd(8)} NOT COMPARABLE -- no (day, model) cell contains both` +
        ` ${level} and ${REFERENCE}.`,
    );
    report.withinCell[level] = { comparable: false };
    continue;
  }
  const totalWeight = logRatios.reduce((sum, r) => sum + r.weight, 0);
  const weightedLogRatio = totalWeight
    ? logRatios.reduce((sum, r) => sum + r.weight * r.value, 0) / totalWeight
    : null;
  const naive =
    report.naive.levels[level] && report.naive.levels[REFERENCE]
      ? report.naive.levels[level].p50 / report.naive.levels[REFERENCE].p50
      : null;
  console.log(
    `  ${level.padEnd(8)} cells=${String(test.strataUsed).padStart(2)}` +
      `  n=${String(strata.reduce((s, x) => s + x.treated.length, 0)).padStart(5)}` +
      `  effect=${test.effect.toFixed(3)}  z=${test.z.toFixed(2).padStart(6)}` +
      `  within-cell median ratio=${
        weightedLogRatio === null ? "  n/a" : `${Math.exp(weightedLogRatio).toFixed(2)}x`
      }` +
      `  (naive ${naive ? `${naive.toFixed(2)}x` : "n/a"})`,
  );
  report.withinCell[level] = {
    comparable: true,
    cells: test.strataUsed,
    effect: test.effect,
    z: test.z,
    withinCellMedianRatio: weightedLogRatio === null ? null : Math.exp(weightedLogRatio),
    naiveMedianRatio: naive,
  };
}

// ---------------------------------------------------------------------------
// 3b. Per-cell detail for the sparse levels.
//
// A level identified off a single cell is one observation of the effect, not
// n observations of it. Printing each cell separately shows whether an effect
// REPLICATES across cells or rests entirely on one day's workload.
// ---------------------------------------------------------------------------

console.log("\n3b. PER-CELL DETAIL for levels with few cells (does the effect replicate?)\n");
report.perCell = {};
for (const level of LEVELS) {
  if (level === REFERENCE) continue;
  const entries = [];
  for (const [key, byLevel] of cells) {
    const treated = byLevel.get(level);
    const control = byLevel.get(REFERENCE);
    if (!treated || !control) continue;
    entries.push({ key, treated, control });
  }
  if (entries.length === 0 || entries.length > 4) continue;
  console.log(`  effort=${level}`);
  report.perCell[level] = [];
  for (const { key, treated, control } of entries) {
    const [d, model] = key.split("|");
    const ratio = median(treated) / median(control);
    const test = stratifiedRankTest([{ treated, control }]);
    console.log(
      `    ${d}  ${model.padEnd(18)}` +
        ` n=${String(treated.length).padStart(4)} p50=${fmt(median(treated)).padStart(6)}` +
        `  vs high n=${String(control.length).padStart(4)} p50=${fmt(median(control)).padStart(6)}` +
        `  ratio=${ratio.toFixed(2)}x  z=${test.z.toFixed(2)}`,
    );
    report.perCell[level].push({
      day: d,
      model,
      n: treated.length,
      p50: median(treated),
      referenceN: control.length,
      referenceP50: median(control),
      ratio,
      z: test.z,
    });
  }
}

// ---------------------------------------------------------------------------
// 3e. Heterogeneity: is pooling across cells even legitimate?
//
// A pooled z is only meaningful if the per-cell effects agree. Cochran's Q
// tests exactly that. A significant Q means the level's effect is not a single
// number being measured repeatedly -- it is a different number on every day,
// which is what "confounded with date" looks like when the level does have
// more than one cell.
// ---------------------------------------------------------------------------

console.log("\n3e. HETEROGENEITY ACROSS CELLS (Cochran's Q on the log median ratio)\n");
console.log("   H0: the level has ONE effect that every cell is estimating.");
console.log("   Small p => the effect differs by cell, so the pooled figure is a");
console.log("   weighted average of unlike things and will not transfer forward.\n");

const bootstrapRandom = mulberry32(987654321);
report.heterogeneity = {};
for (const level of LEVELS) {
  if (level === REFERENCE) continue;
  const estimates = [];
  for (const byLevel of cells.values()) {
    const treated = byLevel.get(level);
    const control = byLevel.get(REFERENCE);
    if (!treated || !control) continue;
    if (treated.length < 8 || control.length < 8) continue;
    const mt = median(treated);
    const mc = median(control);
    if (!(mt > 0 && mc > 0)) continue;
    const se = bootstrapLogRatioSe(treated, control, bootstrapRandom);
    if (!se || se <= 0) continue;
    estimates.push({ theta: Math.log(mt / mc), se });
  }
  const result = heterogeneity(estimates);
  if (!result.testable) {
    console.log(
      `  ${level.padEnd(8)} only ${result.cells} usable cell(s)` +
        ` -- heterogeneity is untestable, which is itself the finding.`,
    );
    report.heterogeneity[level] = result;
    continue;
  }
  console.log(
    `  ${level.padEnd(8)} cells=${String(result.cells).padStart(2)}` +
      `  pooled=${result.pooledRatio.toFixed(2)}x` +
      `  Q=${result.q.toFixed(1).padStart(7)}  df=${String(result.df).padStart(2)}` +
      `  p=${result.p < 1e-4 ? "<0.0001" : result.p.toFixed(4)}` +
      `  I2=${pct(result.iSquared)}` +
      `${result.p < 0.05 ? "  <- effect differs by cell" : ""}`,
  );
  report.heterogeneity[level] = result;
}

// ---------------------------------------------------------------------------
// 3c. Session-stratified contrast -- the tightest available control.
//
// Two calls in the same session share the task, the repo and the conversation.
// If effort varies within a session, that contrast holds constant everything a
// (day, model) cell still leaves free.
// ---------------------------------------------------------------------------

console.log("\n3c. WITHIN-SESSION CONTRAST (same conversation, effort changed mid-session)\n");
const sessions = new Map();
for (const row of withEffort) {
  if (!row.sessionId) continue;
  if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, new Map());
  const byLevel = sessions.get(row.sessionId);
  if (!byLevel.has(row.effort)) byLevel.set(row.effort, []);
  byLevel.get(row.effort).push(row.outputTokens);
}
const mixedSessions = [...sessions.values()].filter((byLevel) => byLevel.size > 1);
console.log(
  `  sessions with effort labels: ${fmt(sessions.size)};` +
    ` sessions where effort changed: ${fmt(mixedSessions.length)}`,
);
report.withinSession = { sessions: sessions.size, mixed: mixedSessions.length, levels: {} };
for (const level of LEVELS) {
  if (level === REFERENCE) continue;
  const strata = [];
  for (const byLevel of sessions.values()) {
    const treated = byLevel.get(level);
    const control = byLevel.get(REFERENCE);
    if (!treated || !control) continue;
    strata.push({ treated, control });
  }
  const test = stratifiedRankTest(strata);
  if (!test) {
    console.log(`  ${level.padEnd(8)} no session contains both ${level} and ${REFERENCE}`);
    report.withinSession.levels[level] = { comparable: false };
    continue;
  }
  console.log(
    `  ${level.padEnd(8)} sessions=${String(test.strataUsed).padStart(3)}` +
      `  n=${String(strata.reduce((s, x) => s + x.treated.length, 0)).padStart(5)}` +
      `  effect=${test.effect.toFixed(3)}  z=${test.z.toFixed(2).padStart(6)}`,
  );
  report.withinSession.levels[level] = {
    comparable: true,
    sessions: test.strataUsed,
    effect: test.effect,
    z: test.z,
  };
}

// ---------------------------------------------------------------------------
// 3d. Collapsed contrast: is the usable dimension just "elevated or not"?
//
// §3 caveat 2 says medium and high are indistinguishable. If low/medium/high
// are one blob and xhigh/max are another, the shippable feature is a binary,
// not a 5-level ordinal.
// ---------------------------------------------------------------------------

console.log("\n3d. COLLAPSED: {xhigh, max} vs {low, medium, high}, within (day, model) cells\n");
const ELEVATED = new Set(["xhigh", "max"]);
const collapsedStrata = [];
for (const byLevel of cells.values()) {
  const treated = [];
  const control = [];
  for (const [level, values] of byLevel) {
    if (ELEVATED.has(level)) treated.push(...values);
    else control.push(...values);
  }
  if (treated.length && control.length) collapsedStrata.push({ treated, control });
}
const collapsed = stratifiedRankTest(collapsedStrata);
if (collapsed) {
  const treatedTotal = collapsedStrata.reduce((s, x) => s + x.treated.length, 0);
  const logRatios = collapsedStrata
    .filter((s) => s.treated.length >= 10 && s.control.length >= 10)
    .map((s) => ({
      weight: Math.min(s.treated.length, s.control.length),
      value: Math.log(median(s.treated) / median(s.control)),
    }));
  const totalWeight = logRatios.reduce((sum, r) => sum + r.weight, 0);
  const ratio = totalWeight
    ? Math.exp(logRatios.reduce((sum, r) => sum + r.weight * r.value, 0) / totalWeight)
    : null;
  console.log(
    `  cells=${collapsed.strataUsed}  n_elevated=${treatedTotal}` +
      `  effect=${collapsed.effect.toFixed(3)}  z=${collapsed.z.toFixed(2)}` +
      `  median ratio=${ratio ? `${ratio.toFixed(2)}x` : "n/a"}`,
  );
  report.collapsed = {
    cells: collapsed.strataUsed,
    nElevated: treatedTotal,
    effect: collapsed.effect,
    z: collapsed.z,
    medianRatio: ratio,
  };
}

// ---------------------------------------------------------------------------
// 4. Regression
// ---------------------------------------------------------------------------

console.log("\n4. REGRESSION: log(output tokens) ~ effort [+ day FE] [+ model FE]\n");
console.log("   exp(coef) is the multiplier on the geometric mean vs effort=high.");
console.log("   SEs clustered by session. Coefficients drop out when a level is");
console.log("   absorbed by the fixed effects -- that is the confound, made visible.\n");

const regressionRows = withEffort.filter((row) => row.outputTokens > 0);
const contrastLevels = LEVELS.filter(
  (level) => level !== REFERENCE && regressionRows.some((row) => row.effort === level),
);
const dayValues = [...new Set(regressionRows.map(day))].sort().slice(1);
const modelValues = [...new Set(regressionRows.map((row) => row.model))].sort().slice(1);

const specifications = [
  { label: "effort only", dayFE: false, modelFE: false, cluster: "session" },
  { label: "+ model FE", dayFE: false, modelFE: true, cluster: "session" },
  { label: "+ day FE", dayFE: true, modelFE: false, cluster: "session" },
  { label: "+ day FE + model FE", dayFE: true, modelFE: true, cluster: "session" },
  // Session clustering assumes sessions are the independent unit. For a level
  // observed on one day, they are not: the whole coefficient rests on one day's
  // workload shock, and day-clustered SEs price that in.
  { label: "  same, day-clustered", dayFE: true, modelFE: true, cluster: "day" },
];

report.regression = {};
const header = `  ${"specification".padEnd(22)}${contrastLevels
  .map((level) => `${level} vs high`.padStart(20))
  .join("")}`;
console.log(header);
for (const spec of specifications) {
  const X = [];
  const y = new Float64Array(regressionRows.length);
  const clusters = [];
  regressionRows.forEach((row, index) => {
    const features = [1];
    for (const level of contrastLevels) features.push(row.effort === level ? 1 : 0);
    if (spec.dayFE) for (const d of dayValues) features.push(day(row) === d ? 1 : 0);
    if (spec.modelFE) for (const m of modelValues) features.push(row.model === m ? 1 : 0);
    X.push(features);
    y[index] = Math.log(row.outputTokens);
    clusters.push(
      spec.cluster === "day" ? day(row) : (row.sessionId ?? `row-${index}`),
    );
  });
  const fit = olsClustered(X, y, clusters);
  if (!fit) {
    console.log(`  ${spec.label.padEnd(22)}${"rank-deficient".padStart(20)}`);
    report.regression[spec.label] = { rankDeficient: true };
    continue;
  }
  const cells = [];
  const record = {};
  contrastLevels.forEach((level, index) => {
    const beta = fit.beta[index + 1];
    const se = fit.se[index + 1];
    const t = se > 0 ? beta / se : 0;
    record[level] = { multiplier: Math.exp(beta), se, t };
    cells.push(`${Math.exp(beta).toFixed(2)}x (t=${t.toFixed(1)})`.padStart(20));
  });
  console.log(`  ${spec.label.padEnd(22)}${cells.join("")}`);
  report.regression[spec.label] = { ...record, n: fit.n, clusters: fit.clusters };
}

// ---------------------------------------------------------------------------
// 5. Placebo
// ---------------------------------------------------------------------------

console.log("\n5. PLACEBO: how big is a median ratio between two arbitrary cells?\n");
console.log("   §3's headline compares effort=low (one day, one model) to effort=max");
console.log("   (a different day, a different model). Under a null in which effort");
console.log("   does nothing, how often do two random (day, model) cells differ by");
console.log("   as much? This calibrates the 4.6x against day-and-model noise alone.\n");

const allCells = new Map();
for (const row of rows) {
  const key = cellKey(row);
  if (!allCells.has(key)) allCells.set(key, []);
  allCells.get(key).push(row.outputTokens);
}
const nLow = report.naive.levels.low?.n ?? 96;
const nMax = report.naive.levels.max?.n ?? 33;
const poolA = [...allCells.values()].filter((values) => values.length >= nMax);
const poolB = [...allCells.values()].filter((values) => values.length >= nLow);
const headlineRatio = report.naive.lowToMaxRatio;

if (poolA.length >= 2 && poolB.length >= 2 && headlineRatio) {
  const random = mulberry32(20260803);
  const draws = 20000;
  let atLeast = 0;
  const ratios = [];
  for (let i = 0; i < draws; i++) {
    const a = poolA[Math.floor(random() * poolA.length)];
    let b = poolB[Math.floor(random() * poolB.length)];
    if (a === b) b = poolB[Math.floor(random() * poolB.length)];
    const ratio = median(a) / median(b);
    ratios.push(Math.abs(Math.log(ratio)));
    if (Math.abs(Math.log(ratio)) >= Math.abs(Math.log(headlineRatio))) atLeast++;
  }
  ratios.sort((a, b) => a - b);
  const p = atLeast / draws;
  console.log(
    `  eligible cells: ${poolA.length} with n>=${nMax}, ${poolB.length} with n>=${nLow}`,
  );
  console.log(`  observed low->max median ratio           ${headlineRatio.toFixed(2)}x`);
  console.log(
    `  median |ratio| between two random cells  ${Math.exp(quantile(ratios, 0.5)).toFixed(2)}x`,
  );
  console.log(
    `  p90 |ratio| between two random cells     ${Math.exp(quantile(ratios, 0.9)).toFixed(2)}x`,
  );
  console.log(
    `  P(random pair >= observed)               ${p.toFixed(3)}` +
      `${p > 0.05 ? "   <- NOT SIGNIFICANT" : ""}`,
  );
  report.placebo = {
    draws,
    headlineRatio,
    medianRandomRatio: Math.exp(quantile(ratios, 0.5)),
    p90RandomRatio: Math.exp(quantile(ratios, 0.9)),
    pValue: p,
  };
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

// A level is only usable as a shipped dimension if it clears three gates:
//   (a) it is comparable to the reference within a (day, model) cell at all,
//   (b) the pooled within-cell contrast is significant, and
//   (c) that contrast REPLICATES -- more than one cell, and no significant
//       heterogeneity between them. Gate (c) is the one the doc never applied.
console.log("\n6. VERDICT\n");
report.verdict = { levels: {} };
const passing = [];
for (const level of LEVELS) {
  if (level === REFERENCE) continue;
  const within = report.withinCell[level];
  const het = report.heterogeneity[level];
  if (!within?.comparable) {
    console.log(`  ${level.padEnd(8)} REJECTED  -- not comparable within any cell.`);
    report.verdict.levels[level] = { pass: false, reason: "not comparable" };
    continue;
  }
  if (Math.abs(within.z) <= 2) {
    console.log(
      `  ${level.padEnd(8)} REJECTED  -- within-cell contrast not significant` +
        ` (z=${within.z.toFixed(2)}, ${within.cells} cell(s)).`,
    );
    report.verdict.levels[level] = { pass: false, reason: "not significant", z: within.z };
    continue;
  }
  if (!het?.testable) {
    console.log(
      `  ${level.padEnd(8)} REJECTED  -- significant (z=${within.z.toFixed(2)}) but rests` +
        ` on a single cell, so it cannot be shown to replicate.`,
    );
    report.verdict.levels[level] = { pass: false, reason: "single cell", z: within.z };
    continue;
  }
  if (het.p < 0.05) {
    console.log(
      `  ${level.padEnd(8)} REJECTED  -- significant pooled (z=${within.z.toFixed(2)}) but` +
        ` fails to replicate across cells (Q p=${het.p.toFixed(4)}, I2=${pct(het.iSquared)}).`,
    );
    report.verdict.levels[level] = {
      pass: false,
      reason: "heterogeneous",
      z: within.z,
      heterogeneityP: het.p,
    };
    continue;
  }
  console.log(
    `  ${level.padEnd(8)} PASSES   -- z=${within.z.toFixed(2)},` +
      ` ${het.cells} cells, homogeneous (p=${het.p.toFixed(3)}),` +
      ` ratio=${het.pooledRatio.toFixed(2)}x`,
  );
  passing.push(level);
  report.verdict.levels[level] = { pass: true, z: within.z, ratio: het.pooledRatio };
}
report.verdict.passing = passing;
console.log(
  passing.length
    ? `\n  Shippable levels: ${passing.join(", ")}.`
    : "\n  No effort level clears all three gates. The dimension is not shippable" +
        "\n  on this corpus -- see docs/GENERATIVE-MODEL.md §3.",
);

if (jsonOut) {
  await mkdir(path.dirname(jsonOut), { recursive: true });
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}

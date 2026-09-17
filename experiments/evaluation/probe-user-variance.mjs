#!/usr/bin/env node
/**
 * probe-user-variance.mjs - how much of the spread is the WORKLOAD?
 *
 * probe-workload-transfer.mjs asks whether a fit survives a move. This asks the
 * complementary question: inside a cell the predictor already conditions on
 * (model, thinking), how much of what is left is between-project, how much is
 * between-session-within-project, and how much is a single session's own noise.
 * If the project term is small next to the model and thinking effects, the
 * SHAPE travels and only a scale may need personalizing. If projects sit 2x to
 * 3x apart at the median, the P50 itself is personal.
 *
 * Same caveat as the transfer probe: the project is a pseudo-user with the
 * PERSON HELD FIXED. Between-user variation is not plausibly smaller than this.
 *
 * Method. Three-level unbalanced nested random effects on log output tokens,
 *   y = mean + project + session(project) + call,
 * estimated by method of moments (Searle's unbalanced two-fold nested design).
 * Method of moments is enough here and it is transparent; a REML fit would move
 * the third decimal and hide the arithmetic. Negative variance estimates are
 * REPORTED AS NEGATIVE as well as clamped, because a negative component means
 * "indistinguishable from zero at this sample size", not "zero".
 *
 * Cells are run twice: (model, thinking), and (model, thinking, fortnight) to
 * control the drift probe-calibration.mjs already measured (corpus P50 510 ->
 * 429 -> 345 by fortnight, STATE-OF-PLAY 6.19).
 *
 * ELIGIBILITY, FIXED BEFORE THE FIRST RUN: a cell is reported when it holds at
 * least 3 projects with 30 or more calls each and 200 or more calls in total.
 * Projects under 30 calls are dropped from the cell, not merged into a bucket.
 *
 * READING GUIDE, also fixed before the run (docs/MULTI-USER-PLAN.md section 1):
 *   per-project medians inside 0.8x to 1.3x  -> the shape travels
 *   projects 2x to 3x apart at the median    -> the P50 is personal
 * The comparison the ratio is read against is the band itself, which spans
 * roughly 4x to 15x from p50 to p99.
 *
 * Artifact: experiments/artifacts/user-variance.json - aggregates only, salted
 * workload hashes, no prompt or response text.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { BOOTSTRAP_SEED, mulberry32, quantile } from "./lib/stats.mjs";

const MIN_PROJECT_CALLS = 30;
const MIN_PROJECTS = 3;
const MIN_CELL_CALLS = 200;
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1_000;
const SHAPE_TRAVELS = [0.8, 1.3];
const P50_IS_PERSONAL = [2, 3];

const projectsDir = defaultProjectsDir();
const { rows: loaded, filesScanned } = await loadRequests(projectsDir);
const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens > 0,
);
rows.sort((left, right) => left.timestampMs - right.timestampMs);
const startMs = rows.length === 0 ? 0 : rows[0].timestampMs;
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  // log, not log1p: zero-token rows are filtered out above, and log keeps the
  // variance components in a unit that reads as a multiplicative ratio.
  row.logTokens = Math.log(row.outputTokens);
  row.fortnight = Math.floor((row.timestampMs - startMs) / FORTNIGHT_MS);
}

/**
 * Searle's method-of-moments estimator for the unbalanced two-fold nested
 * design: project > session > call. Returns variance components in log units.
 */
function nestedVarianceComponents(records) {
  const projects = new Map();
  for (const record of records) {
    let project = projects.get(record.projectId);
    if (!project) {
      project = { sessions: new Map(), sum: 0, n: 0 };
      projects.set(record.projectId, project);
    }
    let session = project.sessions.get(record.sessionId);
    if (!session) {
      session = { sum: 0, n: 0 };
      project.sessions.set(record.sessionId, session);
    }
    session.sum += record.value;
    session.n++;
    project.sum += record.value;
    project.n++;
  }
  const N = records.length;
  const a = projects.size;
  let sessionCount = 0;
  for (const project of projects.values()) sessionCount += project.sessions.size;
  const grand = records.reduce((sum, record) => sum + record.value, 0) / N;

  let sse = 0;
  let ssb = 0;
  let ssa = 0;
  for (const record of records) {
    const project = projects.get(record.projectId);
    const session = project.sessions.get(record.sessionId);
    const sessionMean = session.sum / session.n;
    sse += (record.value - sessionMean) ** 2;
  }
  let sumInnerRatio = 0; // Sigma_i ( Sigma_j n_ij^2 / n_i. )
  let sumSquaresAll = 0; // Sigma_ij n_ij^2
  let sumProjectSquares = 0; // Sigma_i n_i.^2
  for (const project of projects.values()) {
    const projectMean = project.sum / project.n;
    ssa += project.n * (projectMean - grand) ** 2;
    let inner = 0;
    for (const session of project.sessions.values()) {
      const sessionMean = session.sum / session.n;
      ssb += session.n * (sessionMean - projectMean) ** 2;
      inner += session.n ** 2;
      sumSquaresAll += session.n ** 2;
    }
    sumInnerRatio += inner / project.n;
    sumProjectSquares += project.n ** 2;
  }
  const dfE = N - sessionCount;
  const dfB = sessionCount - a;
  const dfA = a - 1;
  if (dfE <= 0 || dfB <= 0 || dfA <= 0) return null;
  const mse = sse / dfE;
  const msb = ssb / dfB;
  const msa = ssa / dfA;
  const k1 = (N - sumInnerRatio) / dfB;
  const k2 = (sumInnerRatio - sumSquaresAll / N) / dfA;
  const k3 = (N - sumProjectSquares / N) / dfA;
  const call = mse;
  const session = (msb - mse) / k1;
  const project = (msa - mse - k2 * session) / k3;
  const clamp = (value) => Math.max(0, value);
  const totalRaw = call + session + project;
  const totalClamped = call + clamp(session) + clamp(project);
  return {
    projects: a,
    sessions: sessionCount,
    calls: N,
    raw: { project, session, call },
    clamped: { project: clamp(project), session: clamp(session), call },
    // Intraclass correlations off the clamped components: the share of the
    // remaining spread that a project label, or a session label, explains.
    iccProject: totalClamped === 0 ? null : clamp(project) / totalClamped,
    iccSession: totalClamped === 0 ? null : clamp(session) / totalClamped,
    totalRaw,
    // sd in log units reads directly as a multiplicative factor: exp(sd).
    projectSdRatio: Math.exp(Math.sqrt(clamp(project))),
    sessionSdRatio: Math.exp(Math.sqrt(clamp(session))),
    callSdRatio: Math.exp(Math.sqrt(call)),
  };
}

function cellReport(label, cellRows) {
  const byProject = new Map();
  for (const row of cellRows) {
    if (!byProject.has(row.workloadId)) byProject.set(row.workloadId, []);
    byProject.get(row.workloadId).push(row);
  }
  const kept = [...byProject.entries()].filter(
    ([, list]) => list.length >= MIN_PROJECT_CALLS,
  );
  const droppedProjects = byProject.size - kept.length;
  const droppedCalls = [...byProject.values()]
    .filter((list) => list.length < MIN_PROJECT_CALLS)
    .reduce((sum, list) => sum + list.length, 0);
  const usable = kept.flatMap(([, list]) => list);
  if (kept.length < MIN_PROJECTS || usable.length < MIN_CELL_CALLS) {
    return {
      label,
      eligible: false,
      reason: `${kept.length} projects with ${MIN_PROJECT_CALLS}+ calls, ${usable.length} usable calls`,
      // Recorded so a reader can see what was NOT graded rather than infer it.
      droppedProjects,
      droppedCalls,
    };
  }
  const components = nestedVarianceComponents(
    usable.map((row) => ({
      projectId: row.workloadId,
      sessionId: row.sessionId ?? `unknown:${row.requestId}`,
      value: row.logTokens,
    })),
  );
  const perProject = kept
    .map(([workloadId, list]) => {
      const tokens = list.map((row) => row.outputTokens).sort((l, r) => l - r);
      return {
        workloadId,
        calls: list.length,
        sessions: new Set(list.map((row) => row.sessionId)).size,
        p50: Math.round(quantile(tokens, 0.5)),
        p90: Math.round(quantile(tokens, 0.9)),
        p99: Math.round(quantile(tokens, 0.99)),
      };
    })
    .sort((left, right) => left.p50 - right.p50);
  const medians = perProject.map((entry) => entry.p50);
  const pooledTokens = usable.map((row) => row.outputTokens).sort((l, r) => l - r);
  const pooled = {
    calls: usable.length,
    p50: Math.round(quantile(pooledTokens, 0.5)),
    p90: Math.round(quantile(pooledTokens, 0.9)),
    p99: Math.round(quantile(pooledTokens, 0.99)),
  };
  const medianSpread = {
    min: medians[0],
    max: medians[medians.length - 1],
    maxOverMin: medians[medians.length - 1] / medians[0],
    // Each project's median as a ratio to the pooled median: this is exactly
    // the per-user scale s_u the plan proposes to estimate.
    perProjectOverPooled: perProject.map((entry) => ({
      workloadId: entry.workloadId,
      ratio: entry.p50 / pooled.p50,
    })),
  };
  const bandSpan = { p90OverP50: pooled.p90 / pooled.p50, p99OverP50: pooled.p99 / pooled.p50 };
  const verdict =
    medianSpread.maxOverMin >= P50_IS_PERSONAL[0]
      ? "p50-is-personal"
      : medianSpread.maxOverMin <= SHAPE_TRAVELS[1]
        ? "shape-travels"
        : "between";
  return {
    label,
    eligible: true,
    droppedProjects,
    droppedCalls,
    pooled,
    bandSpan,
    components,
    perProject,
    medianSpread,
    verdict,
  };
}

// --- cells -----------------------------------------------------------------
const modelThinking = new Map();
const modelThinkingFortnight = new Map();
for (const row of rows) {
  const cell = `model=${row.model}|thinking=${row.thinking}`;
  if (!modelThinking.has(cell)) modelThinking.set(cell, []);
  modelThinking.get(cell).push(row);
  const timed = `${cell}|fortnight=${row.fortnight}`;
  if (!modelThinkingFortnight.has(timed)) modelThinkingFortnight.set(timed, []);
  modelThinkingFortnight.get(timed).push(row);
}
const byModelThinking = [...modelThinking.entries()]
  .map(([label, cellRows]) => cellReport(label, cellRows))
  .sort((left, right) => (right.pooled?.calls ?? 0) - (left.pooled?.calls ?? 0));
const byModelThinkingFortnight = [...modelThinkingFortnight.entries()]
  .map(([label, cellRows]) => cellReport(label, cellRows))
  .sort((left, right) => (right.pooled?.calls ?? 0) - (left.pooled?.calls ?? 0));

/**
 * The comparison the plan asks for: is the project term small NEXT TO the model
 * and thinking effects? Both are reported as a share of the total variance of
 * log output tokens over the whole corpus, so they are on one scale.
 */
function conditioningShare(keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.logTokens);
  }
  const all = rows.map((row) => row.logTokens);
  const grand = all.reduce((sum, value) => sum + value, 0) / all.length;
  const totalSs = all.reduce((sum, value) => sum + (value - grand) ** 2, 0);
  let betweenSs = 0;
  for (const values of groups.values()) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    betweenSs += values.length * (mean - grand) ** 2;
  }
  return { groups: groups.size, etaSquared: betweenSs / totalSs };
}
const share = {
  model: conditioningShare((row) => row.model),
  thinking: conditioningShare((row) => row.thinking),
  modelThinking: conditioningShare((row) => `${row.model}|${row.thinking}`),
  project: conditioningShare((row) => row.workloadId),
  // Marginal: what a project label adds ON TOP of what the predictor already
  // conditions on. This is the number that decides whether a per-user term is
  // worth having at all.
  modelThinkingProject: conditioningShare(
    (row) => `${row.model}|${row.thinking}|${row.workloadId}`,
  ),
};
share.projectMarginal = share.modelThinkingProject.etaSquared - share.modelThinking.etaSquared;

/**
 * Project-block bootstrap on the pooled project ICC. Reported with a loud
 * caveat: resampling 4 to 8 projects with replacement gives an interval that is
 * barely informative, and it is printed so nobody mistakes a point estimate for
 * a measured one.
 */
function iccInterval(cellRows) {
  const byProject = new Map();
  for (const row of cellRows) {
    if (!byProject.has(row.workloadId)) byProject.set(row.workloadId, []);
    byProject.get(row.workloadId).push(row);
  }
  const lists = [...byProject.values()].filter((list) => list.length >= MIN_PROJECT_CALLS);
  if (lists.length < MIN_PROJECTS) return null;
  const random = mulberry32(BOOTSTRAP_SEED);
  const draws = [];
  for (let replicate = 0; replicate < 500; replicate++) {
    const records = [];
    for (let index = 0; index < lists.length; index++) {
      const list = lists[Math.floor(random() * lists.length)];
      // A resampled project must not collide with its own other copy, or the
      // between-project term is silently deflated.
      const tag = `${replicate}:${index}`;
      for (const row of list) {
        records.push({
          projectId: tag,
          sessionId: `${tag}:${row.sessionId ?? row.requestId}`,
          value: row.logTokens,
        });
      }
    }
    const components = nestedVarianceComponents(records);
    if (components?.iccProject != null) draws.push(components.iccProject);
  }
  if (draws.length < 50) return null;
  draws.sort((left, right) => left - right);
  return [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]];
}

console.log(
  `corpus ${rows.length} calls / ${new Set(rows.map((r) => r.sessionId)).size} sessions / ${new Set(rows.map((r) => r.workloadId)).size} projects / ${filesScanned} files`,
);
console.log("\n=== variance of log output tokens explained, whole corpus");
for (const [name, value] of Object.entries(share)) {
  if (name === "projectMarginal") continue;
  console.log(`  ${name.padEnd(22)} ${value.groups.toString().padStart(3)} groups  eta^2 ${(value.etaSquared * 100).toFixed(1)}%`);
}
console.log(
  `  project ON TOP of model+thinking: +${(share.projectMarginal * 100).toFixed(1)} points`,
);

console.log("\n=== (model, thinking) cells");
const intervals = {};
for (const cell of byModelThinking) {
  if (!cell.eligible) {
    console.log(`  ${cell.label.padEnd(46)} not eligible: ${cell.reason}`);
    continue;
  }
  const interval = iccInterval(modelThinking.get(cell.label));
  intervals[cell.label] = interval;
  const c = cell.components;
  console.log(
    `  ${cell.label.padEnd(46)} ${c.calls} calls in ${c.sessions} sessions across ${c.projects} projects`,
  );
  console.log(
    `    ICC project ${(c.iccProject * 100).toFixed(1)}%${interval ? ` [${(interval[0] * 100).toFixed(1)}%, ${(interval[1] * 100).toFixed(1)}%]` : ""}` +
      `  ICC session ${(c.iccSession * 100).toFixed(1)}%` +
      `  project sd x${c.projectSdRatio.toFixed(2)}  session sd x${c.sessionSdRatio.toFixed(2)}  call sd x${c.callSdRatio.toFixed(2)}`,
  );
  console.log(
    `    per-project p50 ${cell.perProject.map((p) => p.p50).join("/")}` +
      `  spread x${cell.medianSpread.maxOverMin.toFixed(2)}  (pooled p50 ${cell.pooled.p50}, band p50->p99 x${cell.bandSpan.p99OverP50.toFixed(1)})  -> ${cell.verdict}`,
  );
}

console.log("\n=== (model, thinking, fortnight) cells, drift controlled");
for (const cell of byModelThinkingFortnight) {
  if (!cell.eligible) continue;
  const c = cell.components;
  console.log(
    `  ${cell.label.padEnd(46)} ${c.calls} calls / ${c.projects} projects  ICC project ${(c.iccProject * 100).toFixed(1)}%  ICC session ${(c.iccSession * 100).toFixed(1)}%  median spread x${cell.medianSpread.maxOverMin.toFixed(2)}  -> ${cell.verdict}`,
  );
}
const eligibleTimed = byModelThinkingFortnight.filter((cell) => cell.eligible);
console.log(
  `  (${eligibleTimed.length} eligible of ${byModelThinkingFortnight.length} time cells; the rest hold fewer than ${MIN_PROJECTS} projects with ${MIN_PROJECT_CALLS}+ calls)`,
);

const eligibleCells = byModelThinking.filter((cell) => cell.eligible);
const spreads = eligibleCells.map((cell) => cell.medianSpread.maxOverMin).sort((l, r) => l - r);
const iccs = eligibleCells.map((cell) => cell.components.iccProject).sort((l, r) => l - r);
console.log(
  `\n=== summary over ${eligibleCells.length} eligible (model, thinking) cells:` +
    ` per-project median spread x${spreads[0].toFixed(2)} to x${spreads[spreads.length - 1].toFixed(2)},` +
    ` project ICC ${(iccs[0] * 100).toFixed(1)}% to ${(iccs[iccs.length - 1] * 100).toFixed(1)}%`,
);

const out = path.join(process.cwd(), "experiments/artifacts/user-variance.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      probe: "probe-user-variance.mjs",
      readThisFirst:
        "The project is a pseudo-user with the PERSON HELD FIXED: one prompting style, one toolchain, one machine, one era, one account. Between-user variation is not plausibly SMALLER than what is measured here, so every project term below is a lower bound on the between-user term, never a clearance.",
      privacy:
        "Aggregates and salted workload hashes only. No prompt text, no response text, no file paths.",
      corpus: {
        source: projectsDir,
        filesScanned,
        calls: rows.length,
        sessions: new Set(rows.map((row) => row.sessionId)).size,
        projects: new Set(rows.map((row) => row.workloadId)).size,
      },
      method: {
        model: "log(outputTokens) = mean + project + session(project) + call",
        estimator: "method of moments, Searle unbalanced two-fold nested design",
        negativeComponents:
          "reported raw as well as clamped; a negative component means indistinguishable from zero at this sample size, not zero",
        iccInterval:
          "project-block bootstrap, 500 draws. WEAK BY CONSTRUCTION: resampling 3 to 8 projects with replacement cannot give a tight interval, and it is published only so the point estimate is not read as precise.",
      },
      eligibility: {
        declaredBeforeRunning: true,
        minProjectCalls: MIN_PROJECT_CALLS,
        minProjects: MIN_PROJECTS,
        minCellCalls: MIN_CELL_CALLS,
      },
      readingGuide: {
        shapeTravels: SHAPE_TRAVELS,
        p50IsPersonal: P50_IS_PERSONAL,
        comparison: "the band itself spans roughly 4x to 15x from p50 to p99",
      },
      varianceExplained: share,
      byModelThinking,
      iccIntervals: intervals,
      byModelThinkingFortnight,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${out}`);

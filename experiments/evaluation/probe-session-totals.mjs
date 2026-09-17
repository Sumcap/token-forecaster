/**
 * probe-session-totals.mjs
 *
 * The whole-SESSION question (raised after §6.25): given a session so
 * far — k turns finished, their totals observed — forecast the TOTAL
 * remaining output tokens, with the number of remaining turns itself random.
 * This is the number a context-budget UI wants.
 *
 * Unit of analysis: SESSIONS (house rule 14). The corpus holds ~300 of them,
 * ~60 in holdout — expect wide CIs; the artifact reports them honestly.
 *
 * Prediction points: one per (session, k) for k = 0..N-1 completed turns;
 * target is the remaining total Σ turns k+1..N. Per-session loss is the mean
 * over that session's points, so the bootstrap blocks are sessions.
 *
 * Candidates are the DUMB forecasts first (house rule: the cheap move
 * captures almost everything):
 *   uncondTotal    — unconditional session-total quantiles minus spent,
 *                    clamped at 0. This is what shipping "unconditional
 *                    quantiles only" behaves like in a UI, and the baseline
 *                    every conditional must beat (the pre-committed kill
 *                    condition).
 *   uncondRemaining— quantiles of remaining pooled over all k. Ignores k.
 *   turnsTimesTurnQ— (median turns/session − k, floored at 1) × per-turn
 *                    total quantiles. "Turns-so-far × median turn total".
 *   kBucket        — remaining-total quantiles fitted per k bucket.
 *   spentBucket    — remaining-total quantiles fitted per spent-so-far
 *                    bucket (what a UI actually observes).
 *
 * Gate: paired session-block bootstrap on per-point pinball vs uncondTotal,
 * adopt only if the 95% CI upper bound < 0 (house rule 1) AND the verdict
 * holds at ≥3 --as-of endpoints (the §6.23/§6.25 lesson).
 *
 *   node experiments/evaluation/probe-session-totals.mjs [--as-of <instant>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultProjectsDir, loadRequests } from "./lib/load-history.mjs";
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
  path.join(process.cwd(), "experiments/artifacts/session-totals-probe.json"),
);
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}

const QUANTILES = [0.5, 0.9, 0.99];
// Sessions are ~4x scarcer than turns; per-k-bucket fits see multiple points
// per session, so the floor is on POINTS but read against session counts.
const MIN_GROUP = 40;

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withLoopContext: true,
});
const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0 &&
    (asOfMs === null || row.timestampMs < asOfMs),
);

// ---------------------------------------------------------------------------
// Build the session dataset: one record per session — turn count, total,
// per-turn series in order (reusing probe-turn-totals.mjs's construction).
// ---------------------------------------------------------------------------
const turns = new Map();
let orphanCalls = 0;
const orphanSessions = new Set();
for (const row of rows) {
  if (row.turnRootId === null) {
    orphanCalls++;
    if (row.sessionId != null) orphanSessions.add(row.sessionId);
    continue;
  }
  let turn = turns.get(row.turnRootId);
  if (!turn) {
    turn = {
      sessionId: row.sessionId ?? null,
      total: 0,
      exact: true,
      firstMs: Infinity,
    };
    turns.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  if (!row.loopDepthExact) turn.exact = false;
  if (row.timestampMs < turn.firstMs) turn.firstMs = row.timestampMs;
}

const bySession = new Map();
let sessionlessTurns = 0;
for (const turn of turns.values()) {
  if (turn.sessionId === null) {
    sessionlessTurns++;
    continue;
  }
  if (!bySession.has(turn.sessionId)) bySession.set(turn.sessionId, []);
  bySession.get(turn.sessionId).push(turn);
}

// A session total is only honest when every turn in it has exact ancestry and
// no calls fell outside any turn — one broken turn poisons the sum.
const sessions = [];
let droppedInexact = 0;
let droppedOrphan = 0;
for (const [sessionId, list] of bySession) {
  if (list.some((turn) => !turn.exact)) {
    droppedInexact++;
    continue;
  }
  if (orphanSessions.has(sessionId)) {
    droppedOrphan++;
    continue;
  }
  list.sort((a, b) => a.firstMs - b.firstMs);
  const series = list.map((turn) => turn.total);
  sessions.push({
    sessionId,
    firstMs: list[0].firstMs,
    turnCount: series.length,
    total: series.reduce((sum, value) => sum + value, 0),
    series,
  });
}
sessions.sort((a, b) => a.firstMs - b.firstMs);

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} calls, ` +
    `${fmt(turns.size)} turns, ${fmt(bySession.size)} sessions ` +
    `(${fmt(sessions.length)} usable; dropped ${droppedInexact} with inexact turns, ` +
    `${droppedOrphan} with orphan calls; ${fmt(orphanCalls)} orphan calls, ` +
    `${fmt(sessionlessTurns)} sessionless turns)`,
);
const totalsSorted = sessions.map((s) => s.total).sort((a, b) => a - b);
const turnCounts = sessions.map((s) => s.turnCount).sort((a, b) => a - b);
const q = (values, p) => Math.round(quantile(values, p));
console.log(
  `Session totals: P50=${fmt(q(totalsSorted, 0.5))} P90=${fmt(q(totalsSorted, 0.9))} ` +
    `P99=${fmt(q(totalsSorted, 0.99))}  turns/session P50=${q(turnCounts, 0.5)} ` +
    `P90=${q(turnCounts, 0.9)}\n`,
);

// ---------------------------------------------------------------------------
// Candidates, fitted on train sessions, graded on holdout prediction points.
// ---------------------------------------------------------------------------
const kBucketOf = (k) =>
  k === 0 ? "0" : k === 1 ? "1" : k <= 4 ? "2-4" : k <= 9 ? "5-9" : "10+";
const spentBucketOf = (spent) =>
  spent === 0
    ? "0"
    : spent < 5_000
      ? "<5k"
      : spent < 20_000
        ? "5-20k"
        : spent < 60_000
          ? "20-60k"
          : "60k+";

const pointsOf = (session) => {
  const points = [];
  let spent = 0;
  for (let k = 0; k < session.turnCount; k++) {
    points.push({ k, spent, remaining: session.total - spent });
    spent += session.series[k];
  }
  return points;
};

const fit = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return QUANTILES.map((p) => Math.round(quantile(sorted, p)));
};

function buildCandidates(train) {
  const trainPoints = train.flatMap(pointsOf);
  const totalQ = fit(train.map((s) => s.total));
  const remainingQ = fit(trainPoints.map((p) => p.remaining));
  const turnTotalsQ = fit(train.flatMap((s) => s.series));
  const medianTurns = quantile(
    train.map((s) => s.turnCount).sort((a, b) => a - b),
    0.5,
  );
  const groupFit = (keyFn) => {
    const grouped = new Map();
    for (const point of trainPoints) {
      const key = keyFn(point);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(point.remaining);
    }
    return new Map(
      [...grouped]
        .filter(([, values]) => values.length >= MIN_GROUP)
        .map(([key, values]) => [key, fit(values)]),
    );
  };
  const byK = groupFit((point) => kBucketOf(point.k));
  const bySpent = groupFit((point) => spentBucketOf(point.spent));
  return {
    uncondTotal: (point) => totalQ.map((v) => Math.max(0, v - point.spent)),
    uncondRemaining: () => remainingQ,
    turnsTimesTurnQ: (point) => {
      const remTurns = Math.max(medianTurns - point.k, 1);
      return turnTotalsQ.map((v) => Math.round(v * remTurns));
    },
    kBucket: (point) => byK.get(kBucketOf(point.k)) ?? remainingQ,
    spentBucket: (point) => bySpent.get(spentBucketOf(point.spent)) ?? remainingQ,
  };
}

const pointLoss = (point, forecast) =>
  QUANTILES.reduce((sum, p, i) => sum + pinball(point.remaining, forecast[i], p), 0);

// Rolling-origin folds over chronologically ordered sessions: last 20% in 5.
const split = Math.floor(sessions.length * 0.8);
const holdoutCount = sessions.length - split;
const blockSize = Math.floor(holdoutCount / 5) || 1;
const CANDIDATE_NAMES = [
  "uncondTotal",
  "uncondRemaining",
  "turnsTimesTurnQ",
  "kBucket",
  "spentBucket",
];
const records = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? sessions.length : Math.min(start + blockSize, sessions.length);
  if (start >= sessions.length) break;
  const candidates = buildCandidates(sessions.slice(0, start));
  for (const session of sessions.slice(start, end)) {
    for (const point of pointsOf(session)) {
      const record = { sessionId: session.sessionId, point };
      for (const name of CANDIDATE_NAMES) {
        record[name] = pointLoss(point, candidates[name](point));
      }
      records.push(record);
    }
  }
}

const sessionIds = records.map((record) => record.sessionId);
const holdoutSessionCount = new Set(sessionIds).size;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
console.log(
  `Holdout: ${fmt(records.length)} prediction points in ${holdoutSessionCount} sessions ` +
    `(sessions split 80/20 chronologically). Effective sample is SESSIONS — ` +
    `expect wide CIs at n=${holdoutSessionCount}.\n`,
);

const gateAgainst = (losses, baseline) =>
  blockBootstrapDifference(
    losses.map((value, index) => value - baseline[index]),
    sessionIds,
  );

const artifact = {
  generatedAt: new Date().toISOString(),
  asOf,
  sessions: sessions.length,
  holdoutSessions: holdoutSessionCount,
  holdoutPoints: records.length,
  sessionTotalQuantiles: {
    p50: q(totalsSorted, 0.5),
    p90: q(totalsSorted, 0.9),
    p99: q(totalsSorted, 0.99),
  },
  turnsPerSession: { p50: q(turnCounts, 0.5), p90: q(turnCounts, 0.9) },
  candidates: {},
};
const baseLosses = records.map((record) => record.uncondTotal);
const remainingLosses = records.map((record) => record.uncondRemaining);
for (const name of CANDIDATE_NAMES) {
  const losses = records.map((record) => record[name]);
  const line = `${name.padEnd(16)} ${mean(losses).toFixed(0)}/point`;
  if (name === "uncondTotal") {
    console.log(`${line}  (unconditional session distribution — the baseline)`);
    artifact.candidates[name] = { meanLoss: mean(losses) };
    continue;
  }
  const gate = gateAgainst(losses, baseLosses);
  const verdict = gate.ciUpper < 0 ? "ADOPTABLE" : "";
  artifact.candidates[name] = {
    meanLoss: mean(losses),
    diff: gate.meanDifference,
    ci95: [gate.ciLower, gate.ciUpper],
    verdict: verdict || "not adopted",
  };
  // The second, harder gate: does CONDITIONING beat the best unconditional
  // forecast (the pooled remaining distribution)? If not, nothing conditional
  // deserves to ship even when it beats total-minus-spent.
  let vsRemaining = "";
  if (name !== "uncondRemaining") {
    const gate2 = gateAgainst(losses, remainingLosses);
    vsRemaining =
      `  | vs uncondRemaining ${gate2.meanDifference.toFixed(1)} ` +
      `[${gate2.ciLower.toFixed(1)}, ${gate2.ciUpper.toFixed(1)}]` +
      (gate2.ciUpper < 0 ? " ADOPTABLE" : "");
    artifact.candidates[name].vsUncondRemaining = {
      diff: gate2.meanDifference,
      ci95: [gate2.ciLower, gate2.ciUpper],
      verdict: gate2.ciUpper < 0 ? "ADOPTABLE" : "not adopted",
    };
  }
  console.log(
    `${line}  vs uncondTotal ${gate.meanDifference.toFixed(1)} ` +
      `[${gate.ciLower.toFixed(1)}, ${gate.ciUpper.toFixed(1)}] ${verdict}${vsRemaining}`,
  );
}

// Coverage of the unconditional session-total quantiles at k=0 — the promise
// the shipped numbers would make to a session that has not started.
const startPoints = records.filter((record) => record.point.k === 0);
const startForecastFit = fit(sessions.slice(0, split).map((s) => s.total));
const covered = QUANTILES.map(
  (p, i) =>
    startPoints.filter((record) => record.point.remaining <= startForecastFit[i]).length,
);
console.log(
  `\nuncondTotal coverage at session start: ${covered
    .map((count) => pct(count / startPoints.length))
    .join(" / ")} (targets 50/90/99, n=${startPoints.length} sessions)`,
);
artifact.uncondStartCoverage = covered.map((count) => count / startPoints.length);

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${jsonOut}`);

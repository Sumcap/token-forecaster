/**
 * probe-missing-signals.mjs
 *
 * Tests candidate pre-call signals the ledger has NEVER graded, each as one
 * extra dimension on the shipped model|thinking rung (with the joint rung
 * above and nothing else changed), on rolling-origin holdout with the paired
 * block bootstrap from lib/stats.mjs. Adopt only if the 95% CI upper bound is
 * strictly below zero (house rule 1).
 *
 * Candidates and why they are new:
 *  - command      Which slash command opened the turn. Command wrappers are
 *                 stripped before prompt featurising, so command turns have
 *                 carried zero prompt signal until now (/code-review, /goal,
 *                 ... plausibly have characteristic output regimes).
 *  - image        Turn-root prompt carries an image attachment. Never tested.
 *  - artifact     turnPrompt.artifactIntent as a LADDER RUNG. It exists only
 *                 as a boosted-tree feature today; a rung is a different bet.
 *  - deliverable  turnPrompt.deliverableType as a rung (same reasoning).
 *  - expansive    turnPrompt.hasExpansive as a rung.
 *  - streak       Length of the consecutive same-first-tool run ending at the
 *                 previous call (section 7.2 lists it as untried; distinct
 *                 from "previous action", which was rejected).
 *  - turnCum      Cumulative output tokens already produced in this turn
 *                 (the 8-call MEAN was rejected; the within-turn SUM was not
 *                 tested).
 *
 * Unknown always skips the rung (house rule 5). Aggregates only in the
 * artifact (house rule 9).
 *
 *   node experiments/evaluation/probe-missing-signals.mjs [--as-of <instant>]
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
  path.join(process.cwd(), "experiments/artifacts/missing-signals-probe.json"),
);
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}

const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
});
const rows = loaded
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      Number.isFinite(row.outputTokens) &&
      row.outputTokens >= 0 &&
      (asOfMs === null || row.timestampMs < asOfMs),
  )
  .sort((left, right) => left.timestampMs - right.timestampMs);

const byRequestId = new Map(rows.map((row) => [row.requestId, row]));
const firstTool = (row) => row.tools?.[0] ?? "(none)";

for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";

  // streak: consecutive identical first-tool run ending at the PREVIOUS call.
  // No previous call -> unknown -> skip (a turn opener has no run to read).
  const parent =
    row.parentRequestId === null ? null : (byRequestId.get(row.parentRequestId) ?? null);
  if (parent === null) {
    row.sigStreak = null;
  } else {
    let streak = 1;
    let cursor = parent;
    for (let hops = 0; hops < 200; hops++) {
      const above =
        cursor.parentRequestId === null
          ? null
          : (byRequestId.get(cursor.parentRequestId) ?? null);
      if (above === null || firstTool(above) !== firstTool(parent)) break;
      streak++;
      cursor = above;
    }
    row.sigStreak = streak >= 3 ? "3+" : String(streak);
  }

  // turnCum: output already produced in this turn. A resolved turn root with
  // zero predecessors is a MEASURED zero; an unresolved root is unknown.
  if (row.turnRootId === null) {
    row.sigTurnCum = null;
  } else {
    let sum = 0;
    let cursor = row;
    let broken = false;
    for (let hops = 0; hops < 200; hops++) {
      const above =
        cursor.parentRequestId === null
          ? null
          : (byRequestId.get(cursor.parentRequestId) ?? null);
      if (above === null) break;
      sum += above.outputTokens;
      cursor = above;
      if (hops === 199) broken = true;
    }
    row.sigTurnCum = broken
      ? null
      : sum === 0
        ? "0"
        : sum < 3_000
          ? "lt3k"
          : sum < 10_000
            ? "3k-10k"
            : "gte10k";
  }

  row.sigCommand = row.turnCommand ?? null;
  row.sigImage =
    row.turnHasImage === null ? null : row.turnHasImage ? "yes" : "no";
  row.sigArtifact =
    row.turnPrompt === null ? null : row.turnPrompt.artifactIntent ? "yes" : "no";
  row.sigDeliverable = row.turnPrompt === null ? null : row.turnPrompt.deliverableType;
  row.sigExpansive =
    row.turnPrompt === null ? null : row.turnPrompt.hasExpansive ? "yes" : "no";
}

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls\n`,
);

const CANDIDATES = [
  ["command", "sigCommand"],
  ["image", "sigImage"],
  ["artifact", "sigArtifact"],
  ["deliverable", "sigDeliverable"],
  ["expansive", "sigExpansive"],
  ["streak", "sigStreak"],
  ["turnCum", "sigTurnCum"],
];

// ---------------------------------------------------------------------------
// Fitting machinery (mirrors probe-cold-start.mjs)
// ---------------------------------------------------------------------------

function fit(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    q: QUANTILES.map((probability) => Math.round(quantile(sorted, probability))),
  };
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
      .map(([key, values]) => [key, fit(values)]),
  );
}

const keyMt = (row) => `model=${row.model}|thinking=${row.thinking}`;
const keyModel = (row) => `model=${row.model}`;
const keyJoint = (field) => (row) =>
  row[field] === null ? null : `${keyMt(row)}|x=${row[field]}`;

function buildLadders(trainRows) {
  const mt = fitGroups(trainRows, keyMt);
  const model = fitGroups(trainRows, keyModel);
  const overall = fit(trainRows.map((row) => row.outputTokens));
  const walkBase = (row) => {
    const foundMt = mt.get(keyMt(row));
    if (foundMt) return { q: foundMt.q, rung: "mt" };
    const foundModel = model.get(keyModel(row));
    if (foundModel) return { q: foundModel.q, rung: "model" };
    return { q: overall.q, rung: "overall" };
  };
  const candidates = {};
  for (const [name, field] of CANDIDATES) {
    const joint = fitGroups(trainRows, keyJoint(field));
    candidates[name] = (row) => {
      const key = keyJoint(field)(row);
      if (key !== null) {
        const found = joint.get(key);
        if (found) return { q: found.q, rung: "joint" };
      }
      return walkBase(row);
    };
  }
  return { base: walkBase, candidates };
}

const totalLoss = (y, q) =>
  QUANTILES.reduce((sum, probability, index) => sum + pinball(y, q[index], probability), 0);

// ---------------------------------------------------------------------------
// Rolling-origin folds, identical construction to the eval
// ---------------------------------------------------------------------------

const split = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - split) / 5);
const folds = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const records = [];
for (const fold of folds) {
  const ladders = buildLadders(fold.train);
  for (const row of fold.test) {
    const record = { row, base: ladders.base(row), candidate: {} };
    for (const [name] of CANDIDATES) {
      record.candidate[name] = ladders.candidates[name](row);
    }
    records.push(record);
  }
}

const sessionIds = records.map((record) => record.row.sessionId ?? null);
const baseLosses = records.map((record) =>
  totalLoss(record.row.outputTokens, record.base.q),
);
const baseMean = baseLosses.reduce((sum, value) => sum + value, 0) / records.length;

console.log(
  `Holdout: ${fmt(records.length)} calls, ${new Set(sessionIds).size} session blocks. ` +
    `Base model|thinking ladder: ${baseMean.toFixed(1)}/call.\n`,
);
console.log(
  "Candidate rung vs model|thinking base (negative = candidate wins; adopt only if CI upper < 0):\n",
);

const artifact = {
  generatedAt: new Date().toISOString(),
  corpus: { calls: rows.length, holdout: records.length, sessions: new Set(sessionIds).size },
  baseMeanLoss: baseMean,
  candidates: {},
};

for (const [name, field] of CANDIDATES) {
  const available = records.filter((record) => record.row[field] !== null).length;
  const fired = records.filter((record) => record.candidate[name].rung === "joint");
  const differences = records.map(
    (record, index) =>
      totalLoss(record.row.outputTokens, record.candidate[name].q) - baseLosses[index],
  );
  const gate = blockBootstrapDifference(differences, sessionIds);
  const firedDiff =
    fired.length === 0
      ? null
      : fired.reduce(
          (sum, record) =>
            sum +
            totalLoss(record.row.outputTokens, record.candidate[name].q) -
            totalLoss(record.row.outputTokens, record.base.q),
          0,
        ) / fired.length;

  // Train-time level census (final fold's training slice) for the report.
  const levels = new Map();
  for (const row of folds[4].train) {
    const value = row[field];
    if (value === null) continue;
    levels.set(value, (levels.get(value) ?? 0) + 1);
  }
  const levelSummary = [...levels.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([value, count]) => `${value}:${fmt(count)}`)
    .join("  ");

  const verdict = gate.ciUpper < 0 ? "ADOPTABLE" : "not adopted";
  console.log(
    `  ${name.padEnd(12)} diff ${gate.meanDifference.toFixed(2)}/call, 95% CI [${gate.ciLower.toFixed(2)}, ${gate.ciUpper.toFixed(2)}]  ${verdict}`,
  );
  console.log(
    `  ${" ".repeat(12)} available ${pct(available / records.length)}, joint rung fired on ${pct(fired.length / records.length)}${firedDiff === null ? "" : `, diff where fired ${firedDiff.toFixed(2)}/call`}`,
  );
  console.log(`  ${" ".repeat(12)} levels (train, final fold): ${levelSummary}\n`);

  artifact.candidates[name] = {
    field,
    diffPerCall: gate.meanDifference,
    ci95: [gate.ciLower, gate.ciUpper],
    availableShare: available / records.length,
    jointRungFiredShare: fired.length / records.length,
    diffWhereFired: firedDiff,
    trainLevelCounts: Object.fromEntries(levels),
    verdict,
  };
}

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${jsonOut}`);

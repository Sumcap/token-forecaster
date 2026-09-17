/**
 * probe-turn-totals.mjs
 *
 * The per-session/turn total question (STATE-OF-PLAY §7.5): given what is
 * known when a human message arrives, forecast the TOTAL output tokens the
 * whole turn will produce — Σ Y_i over the agent loop, N itself random.
 *
 * Unit of analysis: turns (house rule 14). Holdout split and bootstrap blocks
 * are SESSIONS, so turns inside one session never straddle the split.
 *
 * Candidate ladders are the strictly-turn-start features: model+thinking of
 * the opening call, promptPath, promptImage, prompt length bucket,
 * artifactIntent, session position. Gate: paired session-block bootstrap on
 * per-turn total pinball, adopt if CI upper < 0 (house rule 1).
 *
 *   node experiments/evaluation/probe-turn-totals.mjs [--as-of <instant>]
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
  path.join(process.cwd(), "experiments/artifacts/turn-totals-probe.json"),
);
const asOf = argValue("--as-of", null);
const asOfMs = asOf === null ? null : Date.parse(asOf);
if (asOf !== null && !Number.isFinite(asOfMs)) {
  throw new Error(`--as-of is not a parsable instant: ${asOf}`);
}

const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 60; // turns are ~10x scarcer than calls; floor scaled down.

const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
});
const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0 &&
    (asOfMs === null || row.timestampMs < asOfMs),
);

// ---------------------------------------------------------------------------
// Build the turn dataset.
// ---------------------------------------------------------------------------
const turns = new Map();
let orphanCalls = 0;
for (const row of rows) {
  if (row.turnRootId === null) {
    orphanCalls++;
    continue;
  }
  let turn = turns.get(row.turnRootId);
  if (!turn) {
    turn = {
      turnRootId: row.turnRootId,
      sessionId: row.sessionId ?? null,
      total: 0,
      calls: 0,
      exact: true,
      firstMs: Infinity,
      opener: null,
    };
    turns.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  turn.calls++;
  if (!row.loopDepthExact) turn.exact = false;
  if (row.timestampMs < turn.firstMs) {
    turn.firstMs = row.timestampMs;
    turn.opener = row;
  }
}

const allTurns = [...turns.values()].sort((a, b) => a.firstMs - b.firstMs);
for (const turn of allTurns) {
  const opener = turn.opener;
  turn.model = opener.model;
  turn.thinking = hasThinkingBlock(opener) ? "yes" : "no";
  turn.promptPath =
    opener.turnPrompt === null ? null : opener.turnPrompt.mentionsPath ? "yes" : "no";
  turn.promptImage =
    opener.turnHasImage === null ? null : opener.turnHasImage ? "yes" : "no";
  turn.lengthBucket = opener.turnPrompt?.lengthBucket ?? null;
  turn.artifact =
    opener.turnPrompt === null ? null : opener.turnPrompt.artifactIntent ? "yes" : "no";
}
// Session position of the turn (0-based) — knowable at turn start.
const bySession = new Map();
for (const turn of allTurns) {
  const key = turn.sessionId ?? `unknown:${turn.turnRootId}`;
  if (!bySession.has(key)) bySession.set(key, []);
  bySession.get(key).push(turn);
}
for (const list of bySession.values()) {
  list.sort((a, b) => a.firstMs - b.firstMs);
  list.forEach((turn, index) => {
    turn.sessionTurn = index === 0 ? "first" : index < 5 ? "early" : "late";
  });
}

const exactTurns = allTurns.filter((turn) => turn.exact);
console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} calls, ` +
    `${fmt(allTurns.length)} turns (${fmt(exactTurns.length)} with exact ancestry), ` +
    `${fmt(orphanCalls)} orphan calls excluded`,
);
const totals = exactTurns.map((turn) => turn.total).sort((a, b) => a - b);
const q = (p) => Math.round(quantile(totals, p));
console.log(
  `Turn totals (exact turns): P50=${fmt(q(0.5))} P90=${fmt(q(0.9))} P99=${fmt(q(0.99))} ` +
    `mean calls/turn=${(exactTurns.reduce((s, t) => s + t.calls, 0) / exactTurns.length).toFixed(1)}\n`,
);

// ---------------------------------------------------------------------------
// Ladders on rolling-origin folds split by SESSION.
// ---------------------------------------------------------------------------
const data = exactTurns;
const fit = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return QUANTILES.map((p) => Math.round(quantile(sorted, p)));
};
const fitGroups = (train, keyFn) => {
  const grouped = new Map();
  for (const turn of train) {
    const key = keyFn(turn);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(turn.total);
  }
  return new Map(
    [...grouped]
      .filter(([, values]) => values.length >= MIN_GROUP)
      .map(([key, values]) => [key, fit(values)]),
  );
};
const keyFns = {
  mt: (turn) => `m=${turn.model}|t=${turn.thinking}`,
  model: (turn) => `m=${turn.model}`,
  thinking: (turn) => `t=${turn.thinking}`,
  image: (turn) => (turn.promptImage === null ? null : `i=${turn.promptImage}`),
  mtImage: (turn) =>
    turn.promptImage === null
      ? null
      : `m=${turn.model}|t=${turn.thinking}|i=${turn.promptImage}`,
  path: (turn) => (turn.promptPath === null ? null : `p=${turn.promptPath}`),
  mtPath: (turn) =>
    turn.promptPath === null
      ? null
      : `m=${turn.model}|t=${turn.thinking}|p=${turn.promptPath}`,
  length: (turn) => (turn.lengthBucket === null ? null : `l=${turn.lengthBucket}`),
  artifact: (turn) => (turn.artifact === null ? null : `a=${turn.artifact}`),
  sessionTurn: (turn) => `s=${turn.sessionTurn}`,
  mtSessionTurn: (turn) => `m=${turn.model}|t=${turn.thinking}|s=${turn.sessionTurn}`,
};
function ladder(train, rungs) {
  const fits = rungs.map((rung) => fitGroups(train, keyFns[rung]));
  const overall = fit(train.map((turn) => turn.total));
  return (turn) => {
    for (let index = 0; index < rungs.length; index++) {
      const key = keyFns[rungs[index]](turn);
      if (key === null) continue;
      const found = fits[index].get(key);
      if (found) return found;
    }
    return overall;
  };
}
const totalLoss = (turn, forecast) =>
  QUANTILES.reduce((sum, p, i) => sum + pinball(turn.total, forecast[i], p), 0);

// Session-ordered rolling folds: split sessions chronologically 80/20 into 5.
const sessionList = [...bySession.values()].sort(
  (a, b) => a[0].firstMs - b[0].firstMs,
);
const split = Math.floor(sessionList.length * 0.8);
const holdoutSessions = sessionList.slice(split);
const blockSize = Math.floor(holdoutSessions.length / 5) || 1;
const CANDIDATES = {
  overall: [],
  thinkingOnly: ["thinking"],
  modelThinking: ["mt", "model"],
  mtImage: ["mtImage", "image", "mt", "model"],
  mtPath: ["mtPath", "path", "mt", "model"],
  mtLength: ["length", "mt", "model"],
  mtArtifact: ["artifact", "mt", "model"],
  mtSessionTurn: ["mtSessionTurn", "sessionTurn", "mt", "model"],
};
const records = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? sessionList.length : Math.min(start + blockSize, sessionList.length);
  if (start >= sessionList.length) break;
  const trainTurns = sessionList.slice(0, start).flat();
  const testTurns = sessionList.slice(start, end).flat();
  const ladders = Object.fromEntries(
    Object.entries(CANDIDATES).map(([name, rungs]) => [name, ladder(trainTurns, rungs)]),
  );
  for (const turn of testTurns) {
    const record = { turn };
    for (const name of Object.keys(CANDIDATES)) record[name] = ladders[name](turn);
    records.push(record);
  }
}
const sessionIds = records.map((record) => record.turn.sessionId ?? null);
const lossOf = (name) => records.map((record) => totalLoss(record.turn, record[name]));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const baseLosses = lossOf("modelThinking");
console.log(
  `Holdout: ${fmt(records.length)} turns in ${new Set(sessionIds).size} sessions ` +
    `(sessions split 80/20 chronologically).\n`,
);
const artifact = {
  generatedAt: new Date().toISOString(),
  turns: data.length,
  holdoutTurns: records.length,
  turnTotalQuantiles: { p50: q(0.5), p90: q(0.9), p99: q(0.99) },
  candidates: {},
};
for (const name of Object.keys(CANDIDATES)) {
  const losses = lossOf(name);
  const line = `${name.padEnd(14)} ${mean(losses).toFixed(0)}/turn`;
  if (name === "modelThinking") {
    console.log(`${line}  (baseline for gates below)`);
    artifact.candidates[name] = { meanLoss: mean(losses) };
    continue;
  }
  const gate = blockBootstrapDifference(
    losses.map((value, index) => value - baseLosses[index]),
    sessionIds,
  );
  const verdict = gate.ciUpper < 0 ? "ADOPTABLE" : "";
  console.log(
    `${line}  vs model+thinking ${gate.meanDifference.toFixed(1)} ` +
      `[${gate.ciLower.toFixed(1)}, ${gate.ciUpper.toFixed(1)}] ${verdict}`,
  );
  artifact.candidates[name] = {
    meanLoss: mean(losses),
    diff: gate.meanDifference,
    ci95: [gate.ciLower, gate.ciUpper],
    verdict: verdict || "not adopted",
  };
}
// Coverage of the model+thinking ladder, the shipping candidate.
const covered = [0, 0, 0];
for (const record of records) {
  QUANTILES.forEach((p, i) => {
    if (record.turn.total <= record.modelThinking[i]) covered[i]++;
  });
}
console.log(
  `\nmodel+thinking coverage: ${covered
    .map((count) => pct(count / records.length))
    .join(" / ")} (targets 50/90/99)`,
);
artifact.modelThinkingCoverage = covered.map((count) => count / records.length);

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${jsonOut}`);

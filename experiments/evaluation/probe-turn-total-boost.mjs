#!/usr/bin/env node
/**
 * Prompt-conditioned TURN TOTAL forecast (BACKLOG turn-root issue, demo path).
 *
 * The per-call number at a turn root is genuinely flat in prompt wording: the
 * probe-turn-root-regime sweep shows every turn-root-only per-call correction
 * losing to the shipped v2 on the turn-root holdout, and the corpus median for
 * a turn-opening call barely moves with intent. The quantity that DOES scale
 * with typed intent is the whole turn: an artifact-plus-review prompt spawns a
 * longer agent loop, not a longer first call.
 *
 * This probe grades, on session-block holdout turns:
 *   mt        -- model+thinking turn-total ladder (shipped shape)
 *   rungs     -- mtImage -> mtPath -> mt -> thinking -> overall ladder
 *                (mtImage and mtPath graded ADOPTABLE in probe-turn-totals)
 *   boost     -- rungs + portable quantile boost on turn-opener features,
 *                trained on turn totals (loop features are zero at turn start,
 *                so prompt columns are the only live ones besides position)
 * and prints the phrase-by-phrase typing trajectory of each.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  derivePromptFeatures,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { trainPortableQuantileBoost } from "./lib/quantile-boost.mjs";
import { blockBootstrapDifference, fmt, pinball, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/turn-total-boost.json"),
);
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 60;

const { rows: loaded } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
});
const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0,
);

const turns = new Map();
for (const row of rows) {
  if (row.turnRootId === null) continue;
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
const allTurns = [...turns.values()]
  .filter((turn) => turn.exact)
  .sort((a, b) => a.firstMs - b.firstMs);
const bySession = new Map();
for (const turn of allTurns) {
  const key = turn.sessionId ?? `unknown:${turn.turnRootId}`;
  if (!bySession.has(key)) bySession.set(key, []);
  bySession.get(key).push(turn);
}
for (const list of bySession.values()) {
  list.sort((a, b) => a.firstMs - b.firstMs);
}
for (const turn of allTurns) {
  const opener = turn.opener;
  turn.model = opener.model;
  turn.thinking = hasThinkingBlock(opener) ? "yes" : "no";
  turn.turnPrompt = opener.turnPrompt;
  turn.promptPath =
    opener.turnPrompt === null ? null : opener.turnPrompt.mentionsPath ? "yes" : "no";
  turn.promptImage =
    opener.turnHasImage === null ? null : opener.turnHasImage ? "yes" : "no";
  // Feature-vector fields at turn start: the loop has not begun.
  turn.sessionPosition = opener.sessionPosition ?? 0;
  turn.loopDepth = 0;
  turn.priorCalls = 0;
  turn.priorMaxOutput = null;
  turn.priorArtifactCount = null;
  turn.priorWrite = null;
  turn.priorArtifact = null;
  // The boost trainer reads outputTokens as the target.
  turn.outputTokens = turn.total;
}
// Opener session position needs assigning; loadRequests does not set it.
{
  const calls = new Map();
  for (const row of rows) {
    const key = row.sessionId ?? `unknown:${row.requestId}`;
    if (!calls.has(key)) calls.set(key, []);
    calls.get(key).push(row);
  }
  for (const list of calls.values()) {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    list.forEach((row, index) => {
      row.sessionPosition = index;
    });
  }
  for (const turn of allTurns) turn.sessionPosition = turn.opener.sessionPosition;
}

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
  mtImage: (turn) =>
    turn.promptImage === null
      ? null
      : `m=${turn.model}|t=${turn.thinking}|i=${turn.promptImage}`,
  mtPath: (turn) =>
    turn.promptPath === null
      ? null
      : `m=${turn.model}|t=${turn.thinking}|p=${turn.promptPath}`,
  mt: (turn) => `m=${turn.model}|t=${turn.thinking}`,
  tImage: (turn) =>
    turn.promptImage === null ? null : `t=${turn.thinking}|i=${turn.promptImage}`,
  tPath: (turn) =>
    turn.promptPath === null ? null : `t=${turn.thinking}|p=${turn.promptPath}`,
  thinking: (turn) => `t=${turn.thinking}`,
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

// Session-chronological 80/20 split.
const sessionList = [...bySession.values()].sort((a, b) => a[0].firstMs - b[0].firstMs);
const split = Math.floor(sessionList.length * 0.8);
const trainTurns = sessionList.slice(0, split).flat();
const holdout = sessionList.slice(split).flat();

const mtLadder = ladder(trainTurns, ["thinking"]);
const rungLadder = ladder(trainTurns, ["tPath", "tImage", "thinking"]);

const SWEEP = [
  { minimumLeaf: 60, iterations: 24, maxDepth: 2 },
  { minimumLeaf: 60, iterations: 24, maxDepth: 2, learningRate: 0.05 },
  { minimumLeaf: 60, iterations: 32, maxDepth: 3 },
  { minimumLeaf: 60, iterations: 32, maxDepth: 3, learningRate: 0.05 },
  { minimumLeaf: 90, iterations: 32, maxDepth: 3 },
  { minimumLeaf: 120, iterations: 24, maxDepth: 2 },
];
const candidates = SWEEP.map((config) => ({
  config,
  trained: trainPortableQuantileBoost(trainTurns, (turn) => rungLadder(turn), {
    featureSchema: "portable-precall-v2",
    ...config,
  }),
}));

const records = holdout.map((turn) => {
  const record = { turn, mt: mtLadder(turn), rungs: rungLadder(turn) };
  candidates.forEach((candidate, index) => {
    record[`c${index}`] = candidate.trained.predict(turn);
  });
  return record;
});
function metrics(field) {
  const result = { loss: 0, coverage: [0, 0, 0] };
  for (const record of records) {
    result.loss += totalLoss(record.turn, record[field]);
    QUANTILES.forEach((p, index) => {
      result.coverage[index] += record.turn.total <= record[field][index] ? 1 : 0;
    });
  }
  result.loss /= records.length;
  result.coverage = result.coverage.map((value) => value / records.length);
  return result;
}
const comparePair = (treatment, control) =>
  blockBootstrapDifference(
    records.map(
      (record) =>
        totalLoss(record.turn, record[treatment]) - totalLoss(record.turn, record[control]),
    ),
    records.map((record) => record.turn.sessionId ?? null),
  );

// Typing simulation on the demo prompt.
const modelCounts = new Map();
for (const turn of trainTurns) {
  modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
}
const demoModel =
  [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
const PHRASES = [
  "can you write",
  "can you write a small report",
  "can you write a small report into a file",
  "can you write a small report into a file lets say ./here.txt",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr in the internet",
];
const demoTurn = (text) => {
  const prompt = derivePromptFeatures(text);
  return {
    model: demoModel,
    thinking: "yes",
    turnPrompt: prompt,
    promptPath: prompt.mentionsPath ? "yes" : "no",
    promptImage: "no",
    sessionPosition: 1,
    loopDepth: 0,
    priorCalls: 0,
    priorMaxOutput: null,
    priorArtifactCount: null,
    priorWrite: null,
    priorArtifact: null,
  };
};
const trajectory = (predict) => {
  const p50s = PHRASES.map((text) => predict(demoTurn(text))[0]);
  let drops = 0;
  for (let index = 1; index < p50s.length; index++) {
    if (p50s[index] < p50s[index - 1]) drops++;
  }
  return { p50s, growth: p50s[p50s.length - 1] - p50s[0], drops };
};

const summaries = candidates.map((candidate, index) => ({
  ...candidate.config,
  holdout: metrics(`c${index}`),
  vsRungs: comparePair(`c${index}`, "rungs"),
  typing: trajectory((turn) => candidate.trained.predict(turn)),
}));
const report = {
  generatedAt: new Date().toISOString(),
  dataset: {
    turns: allTurns.length,
    trainTurns: trainTurns.length,
    holdoutTurns: holdout.length,
    holdoutSessions: sessionList.length - split,
    demoModel,
  },
  mt: { holdout: metrics("mt"), typing: trajectory(mtLadder) },
  rungs: {
    holdout: metrics("rungs"),
    vsMt: comparePair("rungs", "mt"),
    typing: trajectory(rungLadder),
  },
  candidates: summaries,
};
await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const show = (evaluation) =>
  `loss=${fmt(Math.round(evaluation.loss))} cov=${evaluation.coverage
    .map((value) => `${(value * 100).toFixed(0)}%`)
    .join("/")}`;
console.log(
  `${allTurns.length} exact turns (train ${trainTurns.length}, holdout ${holdout.length} ` +
    `in ${sessionList.length - split} sessions), demo model ${demoModel}`,
);
console.log(`mt    ${show(report.mt.holdout)} typing=${report.mt.typing.p50s.join(",")}`);
console.log(
  `rungs ${show(report.rungs.holdout)} vsMt=${report.rungs.vsMt.meanDifference.toFixed(0)} ` +
    `[${report.rungs.vsMt.ciLower.toFixed(0)}, ${report.rungs.vsMt.ciUpper.toFixed(0)}] ` +
    `typing=${report.rungs.typing.p50s.join(",")}`,
);
for (const summary of summaries) {
  console.log(
    `leaf=${summary.minimumLeaf} it=${summary.iterations} d=${summary.maxDepth}: ` +
      `${show(summary.holdout)} vsRungs=${summary.vsRungs.meanDifference.toFixed(0)} ` +
      `[${summary.vsRungs.ciLower.toFixed(0)}, ${summary.vsRungs.ciUpper.toFixed(0)}] ` +
      `typing=${summary.typing.p50s.join(",")} drops=${summary.typing.drops} ` +
      `growth=${summary.typing.growth}`,
  );
}
console.log(`Wrote ${jsonOut}`);

// Deployment preview: the shipped correction is retrained on ALL turns, so a
// config that is monotone on the train split can pick up a dip in the final
// model. Print the final-model trajectory for the statistically-tied configs.
const FINAL_CONFIGS = [
  { minimumLeaf: 120, iterations: 24, maxDepth: 2, learningRate: 0.08 },
  { minimumLeaf: 60, iterations: 24, maxDepth: 2, learningRate: 0.05 },
  { minimumLeaf: 60, iterations: 24, maxDepth: 2, learningRate: 0.08 },
  { minimumLeaf: 90, iterations: 24, maxDepth: 2, learningRate: 0.08 },
];
const finalLadder = ladder(allTurns, ["tPath", "tImage", "thinking"]);
for (const config of FINAL_CONFIGS) {
  const finalModel = trainPortableQuantileBoost(allTurns, finalLadder, {
    featureSchema: "portable-precall-v2",
    ...config,
  });
  const track = trajectory((turn) => finalModel.predict(turn));
  console.log(
    `final leaf=${config.minimumLeaf} it=${config.iterations} d=${config.maxDepth} ` +
      `lr=${config.learningRate}: typing=${track.p50s.join(",")} drops=${track.drops} ` +
      `growth=${track.growth}`,
  );
}

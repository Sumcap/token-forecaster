#!/usr/bin/env node
/**
 * Final evaluator/generator for the adopted portable quantile correction.
 * Candidate selection belongs in probe-breakthroughs.mjs; this file freezes the
 * winner and provides the reproducible single-split, rolling-origin, segment,
 * and deployment-profile path.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  derivePromptFeatures,
  hasThinkingBlock,
  loadRequests,
  redactHome,
} from "./lib/load-history.mjs";
import {
  PORTABLE_BOOST_FEATURE_COUNT_BY_SCHEMA as BOOST_FEATURE_COUNT_BY_SCHEMA,
  trainPortableQuantileBoost,
} from "./lib/quantile-boost.mjs";
import { blockBootstrapDifference, pinball, quantile } from "./lib/stats.mjs";
// The shipped base text head, read out of the built predictor so the trainer
// and the runtime evaluate the SAME asset. `pnpm build` must have run; the
// package is not a dependency of this directory, so the path is explicit. The
// head lives behind the `./text-head` subpath, off the main entry's import
// graph, so bundles that never run it do not carry its 1.2 MB asset.
import {
  BASE_TEXT_HEAD_VERSION,
  baseTextHead,
} from "../../packages/predictor/dist/text-head/index.js";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/winning-boost-eval.json"),
);
const baseProfileFile = argValue("--base-profile");
const profileOut = argValue("--profile-out");
const bundledOut = argValue("--bundled-profile-out");
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;

// `withPromptText` is the opt-in local-probe path: it keeps the cleaned
// turn-root text on the record so the base text head can be evaluated here.
// The text is reduced to three numbers per turn root a few lines below and
// then DELETED from every row, before any model trains, any metric is
// computed or anything is written -- see the drop loop marked "house rule 9".
const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withPromptText: true,
});
const rows = loaded
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      Number.isFinite(row.outputTokens) &&
      row.outputTokens >= 0,
  )
  .sort((left, right) => left.timestampMs - right.timestampMs);
const byId = new Map(rows.map((row) => [row.requestId, row]));
const sessions = new Map();
for (const row of rows) {
  const session = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(session)) sessions.set(session, []);
  sessions.get(session).push(row);
}
for (const session of sessions.values()) {
  session.sort((left, right) => left.timestampMs - right.timestampMs);
  for (let index = 0; index < session.length; index++) session[index].sessionPosition = index;
}
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
  row.promptImage =
    row.turnHasImage === null ? null : row.turnHasImage ? "yes" : "no";
  let parent = row.parentRequestId === null ? null : byId.get(row.parentRequestId) ?? null;
  let priorCalls = 0;
  let priorMaxOutput = 0;
  let priorArtifacts = 0;
  let priorWrites = 0;
  const seen = new Set();
  while (parent && priorCalls < 200 && !seen.has(parent.requestId)) {
    seen.add(parent.requestId);
    priorCalls++;
    const action = parent.tools[0] ?? "(no-tool)";
    const artifact = action === "Write" || (action === "Edit" && parent.toolChars >= 4_000);
    if (action === "Write") priorWrites++;
    if (artifact) priorArtifacts++;
    priorMaxOutput = Math.max(priorMaxOutput, parent.outputTokens);
    parent =
      parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
  row.isWrite = (row.tools[0] ?? "(no-tool)") === "Write";
}

// ---------------------------------------------------------------------------
// Base text head, then house rule 9: the text does not survive this block.
//
// One head per distinct turn root (every call in a turn shares the opener's
// prompt, so the head would be identical for all of them), memoised into
// `textHeadByTurn`. Immediately afterwards `turnPromptText` is deleted from
// every row, which makes it structurally impossible for text to reach a
// model, a metric or the report JSON.
// ---------------------------------------------------------------------------
const textHeadByTurn = new Map();
let turnsWithText = 0;
for (const row of rows) {
  if (row.turnRootId == null) continue;
  if (textHeadByTurn.has(row.turnRootId)) continue;
  const text = row.turnPromptText ?? null;
  if (text === null) {
    textHeadByTurn.set(row.turnRootId, null);
    continue;
  }
  textHeadByTurn.set(row.turnRootId, baseTextHead(text));
  turnsWithText++;
}
for (const row of rows) delete row.turnPromptText;

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
const key = {
  mtp: (row) =>
    row.promptPath === null
      ? null
      : `model=${row.model}|thinking=${row.thinking}|promptPath=${row.promptPath}`,
  path: (row) => (row.promptPath === null ? null : `promptPath=${row.promptPath}`),
  mt: (row) => `model=${row.model}|thinking=${row.thinking}`,
  model: (row) => `model=${row.model}`,
};
function makeBase(trainRows) {
  const keys = [key.mtp, key.path, key.mt, key.model];
  const fits = keys.map((keyFn) => fitGroups(trainRows, keyFn));
  const overall = fit(trainRows.map((row) => row.outputTokens));
  return (row) => {
    for (let index = 0; index < keys.length; index++) {
      const group = keys[index](row);
      if (group === null) continue;
      const found = fits[index].get(group);
      if (found) return found;
    }
    return overall;
  };
}
function loss(row, forecast) {
  return QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, forecast[index], probability),
    0,
  );
}
function metrics(records, field) {
  const result = { n: records.length, loss: 0, coverage: [0, 0, 0], width: [0, 0] };
  for (const record of records) {
    const forecast = record[field];
    result.loss += loss(record.row, forecast);
    for (let index = 0; index < QUANTILES.length; index++) {
      result.coverage[index] += record.row.outputTokens <= forecast[index] ? 1 : 0;
    }
    result.width[0] += forecast[1] - forecast[0];
    result.width[1] += forecast[2] - forecast[0];
  }
  result.loss /= records.length;
  result.coverage = result.coverage.map((value) => value / records.length);
  result.width = result.width.map((value) => value / records.length);
  return result;
}
function comparePair(records, treatment, control) {
  const differences = records.map(
    (record) => loss(record.row, record[treatment]) - loss(record.row, record[control]),
  );
  return blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
}
const compare = (records) => comparePair(records, "boosted", "baseline");
/** v3 minus v2 on identical folds: positive means the new feature costs loss. */
const compareSchemas = (records) => comparePair(records, "candidate", "boosted");
// Schema v3 (compression follow-up, feature 37) is graded against the shipped
// v2 on identical folds. Both are trained here so the comparison is paired: the
// only difference between the two models is the extra candidate column.
const SHIPPED_SCHEMA = "portable-precall-v2";
const CANDIDATE_SCHEMA = "portable-precall-v3";

function fitAndScore(train, test, fold = null) {
  const base = makeBase(train);
  const shipped = trainPortableQuantileBoost(train, (row) => base(row).q, {
    featureSchema: SHIPPED_SCHEMA,
  });
  const candidate = trainPortableQuantileBoost(train, (row) => base(row).q, {
    featureSchema: CANDIDATE_SCHEMA,
  });
  return {
    model: shipped.model,
    candidateModel: candidate.model,
    records: test.map((row) => ({
      row,
      fold,
      baseline: base(row).q,
      boosted: shipped.predict(row),
      candidate: candidate.predict(row),
    })),
  };
}

const split = Math.floor(rows.length * 0.8);
const single = fitAndScore(rows.slice(0, split), rows.slice(split));
const singleSplit = {
  trainCalls: split,
  holdoutCalls: rows.length - split,
  trainThrough: new Date(rows[split - 1].timestampMs).toISOString(),
  holdoutFrom: new Date(rows[split].timestampMs).toISOString(),
  baseline: metrics(single.records, "baseline"),
  boosted: metrics(single.records, "boosted"),
  candidate: metrics(single.records, "candidate"),
  comparison: compare(single.records),
  schemaComparison: compareSchemas(single.records),
};

const blockSize = Math.floor((rows.length - split) / 5);
const rollingRecords = [];
for (let fold = 0; fold < 5; fold++) {
  const start = split + fold * blockSize;
  const end = fold === 4 ? rows.length : start + blockSize;
  rollingRecords.push(
    ...fitAndScore(rows.slice(0, start), rows.slice(start, end), fold + 1).records,
  );
}
const rolling = {
  folds: Array.from({ length: 5 }, (_, index) => {
    const records = rollingRecords.filter((record) => record.fold === index + 1);
    return {
      fold: index + 1,
      n: records.length,
      baseline: metrics(records, "baseline"),
      boosted: metrics(records, "boosted"),
      candidate: metrics(records, "candidate"),
      comparison: compare(records),
      schemaComparison: compareSchemas(records),
    };
  }),
  baseline: metrics(rollingRecords, "baseline"),
  boosted: metrics(rollingRecords, "boosted"),
  candidate: metrics(rollingRecords, "candidate"),
  comparison: compare(rollingRecords),
  schemaComparison: compareSchemas(rollingRecords),
};

function segment(accessor, minimum = 100) {
  const groups = new Map();
  for (const record of rollingRecords) {
    const raw = accessor(record.row);
    const value = raw === null || raw === undefined ? "(unknown)" : String(raw);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(record);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .filter(([, records]) => records.length >= minimum)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([value, records]) => [
        value,
        {
          n: records.length,
          baseline: metrics(records, "baseline"),
          boosted: metrics(records, "boosted"),
          candidate: metrics(records, "candidate"),
          comparison: compare(records),
          schemaComparison: compareSchemas(records),
          writeRate: records.filter((record) => record.row.isWrite).length / records.length,
        },
      ]),
  );
}

/**
 * Adoption gate for feature schema v3, graded on the rolling-origin holdout.
 * The bundled profile only moves to v3 when the extra column costs nothing:
 * no provable pinball regression against the shipped v2 (paired session-block
 * bootstrap, lower bound of the v3−v2 CI at or below zero) and P90 coverage
 * still inside the band the shipped correction holds (91.9% at adoption of
 * §6.24; band 88–93%).
 */
const P90_COVERAGE_BAND = [0.88, 0.93];
// A support floor comes first, because without it the gate is vacuous: the
// trainer's minimum leaf is 150 rows, so a feature that fires on fewer than
// that can never be chosen as a split and v3 trains byte-identical trees to v2
// -- a zero difference that would read as "no regression" and adopt a schema
// whose new column is dead. Grade support before grading loss.
const BOOST_MINIMUM_LEAF = 150;
const candidateFeatureRows = rows.filter(
  (row) => row.turnPrompt?.followupCompression === true,
).length;
const candidateFeatureTurns = new Set(
  rows
    .filter((row) => row.turnPrompt?.followupCompression === true)
    .map((row) => row.turnPrompt.promptHash),
).size;
const schemaGate = {
  shippedSchema: SHIPPED_SCHEMA,
  candidateSchema: CANDIDATE_SCHEMA,
  rule:
    `adopt v3 iff the new feature fires on >= ${BOOST_MINIMUM_LEAF} training rows ` +
    "AND the paired rolling v3-v2 CI lower bound <= 0 (no provable pinball " +
    `regression) AND v3 P90 coverage in [${P90_COVERAGE_BAND.join(", ")}]`,
  candidateFeatureRows,
  candidateFeatureTurns,
  supported: candidateFeatureRows >= BOOST_MINIMUM_LEAF,
  meanDifference: rolling.schemaComparison.meanDifference,
  ciLower: rolling.schemaComparison.ciLower,
  ciUpper: rolling.schemaComparison.ciUpper,
  p90Coverage: rolling.candidate.coverage[1],
  noRegression: rolling.schemaComparison.ciLower <= 0,
  coverageInBand:
    rolling.candidate.coverage[1] >= P90_COVERAGE_BAND[0] &&
    rolling.candidate.coverage[1] <= P90_COVERAGE_BAND[1],
};
schemaGate.adopt =
  schemaGate.supported && schemaGate.noRegression && schemaGate.coverageInBand;
const deployedSchema = schemaGate.adopt ? CANDIDATE_SCHEMA : SHIPPED_SCHEMA;

// ---------------------------------------------------------------------------
// Turn totals: opener rungs + prompt-aware turn-total correction.
//
// The per-call correction is structurally flat in prompt wording at turn
// roots (regime collapse, docs/BACKLOG.md 11 Aug 2026): loop-shape features
// own its splits and they are all zero while a user types. The quantity that
// does scale with typed intent is the whole turn, so prompt conditioning is
// trained HERE, on per-turn totals, where parent-chain features are
// definitionally zero and prompt aggregates are the only live columns.
// Config from experiments/evaluation/probe-turn-total-boost.mjs (12 Aug 2026).
// ---------------------------------------------------------------------------
const MIN_TURN_GROUP = 60;
// Among the statistically-tied depth-2 configs (probe-turn-total-boost.mjs,
// holdout spread < 20/turn, every CI overlapping), this one is chosen for the
// smallest non-monotonicity of the final all-data model on a growing draft:
// the live chip is the product surface, and a config that dips 15% mid-typing
// reads as noise while this one moves smoothly. Recorded in the probe output.
const TURN_BOOST_CONFIG = {
  featureSchema: SHIPPED_SCHEMA,
  minimumLeaf: 60,
  iterations: 24,
  maxDepth: 2,
  learningRate: 0.05,
};
// Stage 1 part 2. The turn-total correction is the ONLY consumer of
// `portable-precall-v4`: indices 38-40 hold the public base text head's three
// log1p quantiles and 41 its presence bit. The per-call correction above keeps
// its own schema untouched.
//
// The head-isolating control is v3, not the schema the incumbent turn boost
// happens to ship (`SHIPPED_SCHEMA`): v4 = v3 + the four head columns, so
// grading v4 against v3 measures the head and nothing else. The incumbent is
// graded separately by the turn-total gate below, and it is what ships if the
// head does not earn its place.
const TURN_BOOST_HEAD_CONTROL_SCHEMA = "portable-precall-v3";
const TURN_BOOST_CANDIDATE_SCHEMA = "portable-precall-v4";
// The context-signals follow-up: v5 offers the trees the same 38 v3 columns
// plus the session-so-far pair (42-44). The trainer's column table keeps the
// refused text head out of v5, so v5 - v3 measures the session family alone.
const TURN_BOOST_SESSION_SCHEMA = "portable-precall-v5";
const turnConfigAt = (featureSchema) => ({ ...TURN_BOOST_CONFIG, featureSchema });
const turnAccumulator = new Map();
for (const row of rows) {
  if (row.turnRootId == null) continue;
  let turn = turnAccumulator.get(row.turnRootId);
  if (!turn) {
    turn = {
      turnRootId: row.turnRootId,
      sessionId: row.sessionId ?? null,
      total: 0,
      exact: true,
      firstMs: Infinity,
      lastMs: -Infinity,
      opener: null,
    };
    turnAccumulator.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  if (!row.loopDepthExact) turn.exact = false;
  if (row.timestampMs < turn.firstMs) {
    turn.firstMs = row.timestampMs;
    turn.opener = row;
  }
  if (row.timestampMs > turn.lastMs) turn.lastMs = row.timestampMs;
}

// ---------------------------------------------------------------------------
// Session-so-far context for the v5 candidate columns, computed from this same
// accumulator so the trainer and any future runtime caller agree on the
// definition (docs/CONTEXT-SIGNALS-PLAN.md, "Decision", 3 Sep 2026).
//
// Ordering uses EVERY turn root in the session, exact or not: a turn whose loop
// depth could not be resolved still happened, and the human who typed the next
// prompt had already seen it. `previousTurnOutputTokens` is absent -- not zero
// -- unless the immediately previous turn had finished before this one started,
// because an overlapping turn's total is not knowable at this turn's opener.
// ---------------------------------------------------------------------------
const turnsBySession = new Map();
for (const turn of turnAccumulator.values()) {
  const sessionKey = turn.sessionId ?? `unknown:${turn.turnRootId}`;
  if (!turnsBySession.has(sessionKey)) turnsBySession.set(sessionKey, []);
  turnsBySession.get(sessionKey).push(turn);
}
let turnsWithPreviousOutput = 0;
for (const turns of turnsBySession.values()) {
  turns.sort((left, right) => left.firstMs - right.firstMs);
  for (let index = 0; index < turns.length; index++) {
    const previous = index === 0 ? null : turns[index - 1];
    const completed = previous !== null && previous.lastMs < turns[index].firstMs;
    if (completed) turnsWithPreviousOutput++;
    turns[index].sessionContext = {
      turnsSoFar: index,
      ...(completed ? { previousTurnOutputTokens: previous.total } : {}),
    };
  }
}
const allTurns = [...turnAccumulator.values()]
  .filter((turn) => turn.exact)
  .sort((left, right) => left.firstMs - right.firstMs);
for (const turn of allTurns) {
  const opener = turn.opener;
  turn.model = opener.model;
  turn.thinking = opener.thinking;
  turn.turnPrompt = opener.turnPrompt;
  turn.promptPath = opener.promptPath;
  turn.promptImage = opener.promptImage;
  turn.sessionPosition = opener.sessionPosition;
  turn.loopDepth = 0;
  turn.priorCalls = 0;
  turn.priorMaxOutput = null;
  turn.priorArtifactCount = null;
  turn.priorWrite = null;
  turn.priorArtifact = null;
  // Three numbers from the base head, or null when the opener's text was not
  // recoverable. Null leaves the v4 columns at zero with the presence bit off,
  // which is exactly what a runtime caller without a draft sends.
  turn.textHead = textHeadByTurn.get(turn.turnRootId) ?? null;
  // The boost trainer reads outputTokens as its target.
  turn.outputTokens = turn.total;
}
const headTurns = allTurns.filter((turn) => turn.textHead !== null);
// Pooled across models on purpose: the model-conditioned turn ladder graded
// ~+500/turn WORSE than thinking-only here, matching probe-turn-totals'
// thinking-only mean advantage. promptPath outranks promptImage because it is
// the stronger lever (path turns run ~2x the pooled median) and the one that
// can flip while a user types.
const turnKey = {
  tPath: (turn) =>
    turn.promptPath === null
      ? null
      : `thinking=${turn.thinking}|promptPath=${turn.promptPath}`,
  tImage: (turn) =>
    turn.promptImage === null
      ? null
      : `thinking=${turn.thinking}|promptImage=${turn.promptImage}`,
  thinking: (turn) => `thinking=${turn.thinking}`,
};
const TURN_RUNGS = ["tPath", "tImage", "thinking"];
function fitTurnGroups(turns, keyFn) {
  const grouped = new Map();
  for (const turn of turns) {
    const key = keyFn(turn);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(turn.total);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length >= MIN_TURN_GROUP)
      .map(([key, values]) => [key, fit(values)]),
  );
}
function turnLadder(turns, rungs) {
  const fits = rungs.map((rung) => fitTurnGroups(turns, turnKey[rung]));
  const overall = fit(turns.map((turn) => turn.total));
  return (turn) => {
    for (let index = 0; index < rungs.length; index++) {
      const key = turnKey[rungs[index]](turn);
      if (key === null) continue;
      const found = fits[index].get(key);
      if (found) return found.q;
    }
    return overall.q;
  };
}
const turnLoss = (turn, forecast) =>
  QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(turn.total, forecast[index], probability),
    0,
  );
// Session-chronological 80/20 split so turns never straddle the boundary.
const turnSessions = new Map();
for (const turn of allTurns) {
  const key = turn.sessionId ?? `unknown:${turn.firstMs}`;
  if (!turnSessions.has(key)) turnSessions.set(key, []);
  turnSessions.get(key).push(turn);
}
const turnSessionList = [...turnSessions.values()].sort(
  (left, right) => left[0].firstMs - right[0].firstMs,
);
const turnSplit = Math.floor(turnSessionList.length * 0.8);
const turnTrain = turnSessionList.slice(0, turnSplit).flat();
const turnHoldout = turnSessionList.slice(turnSplit).flat();
const thinkingLadder = turnLadder(turnTrain, ["thinking"]);
const rungLadderFn = turnLadder(turnTrain, TURN_RUNGS);
const turnBoostEval = trainPortableQuantileBoost(turnTrain, rungLadderFn, TURN_BOOST_CONFIG);
// The v4 arm: the same turn boost, offered the base text head's four extra
// columns. Trained on the identical split off the identical rung ladder, so
// the only difference between the two models is the candidate columns.
const turnBoostV4Eval = trainPortableQuantileBoost(
  turnTrain,
  rungLadderFn,
  turnConfigAt(TURN_BOOST_CANDIDATE_SCHEMA),
);
// The v5 arm: same split, same ladder, offered the session-so-far columns.
const turnBoostV5Eval = trainPortableQuantileBoost(
  turnTrain,
  rungLadderFn,
  turnConfigAt(TURN_BOOST_SESSION_SCHEMA),
);
const turnRecords = turnHoldout.map((turn) => ({
  turn,
  thinkingOnly: thinkingLadder(turn),
  rungs: rungLadderFn(turn),
  boosted: turnBoostEval.predict(turn),
  boostedV4: turnBoostV4Eval.predict(turn),
  boostedV5: turnBoostV5Eval.predict(turn),
}));
const turnPair = (treatment, control) =>
  blockBootstrapDifference(
    turnRecords.map(
      (record) => turnLoss(record.turn, record[treatment]) - turnLoss(record.turn, record[control]),
    ),
    turnRecords.map((record) => record.turn.sessionId ?? null),
  );
const turnCoverage = (field) => {
  const coverage = [0, 0, 0];
  for (const record of turnRecords) {
    QUANTILES.forEach((probability, index) => {
      coverage[index] += record.turn.total <= record[field][index] ? 1 : 0;
    });
  }
  return coverage.map((value) => value / turnRecords.length);
};
const rungsVsThinking = turnPair("rungs", "thinkingOnly");
const boostVsRungs = turnPair("boosted", "rungs");
const combinedVsThinking = turnPair("boosted", "thinkingOnly");
const boostP90Coverage = turnCoverage("boosted")[1];
// The same gate, applied to the v4 arm, so whatever ships is what was graded.
const combinedV4VsThinking = turnPair("boostedV4", "thinkingOnly");
const boostV4P90Coverage = turnCoverage("boostedV4")[1];
const combinedV5VsThinking = turnPair("boostedV5", "thinkingOnly");
const boostV5P90Coverage = turnCoverage("boostedV5")[1];
// The shipping unit is rungs+boost TOGETHER, graded against the previously
// shipped thinking-only turn groups. At ~1,200 turns the session-block CI is
// roughly ±500/turn, so a provable-improvement bound (house rule 1) cannot
// close for effects of this size in either direction. The gate is therefore
// the schema-gate family rule: adopt unless the combined candidate PROVABLY
// regresses (CI lower > 0) or P90 coverage leaves [0.90, 1]. Prompt-responsive
// turn forecasts are the product requirement (the cold-start "reads your
// draft" chip); a statistically flat trade at equal mean loss buys that
// responsiveness. Recorded as a weaker-gate adoption on purpose.
const turnTotalGate = {
  turns: allTurns.length,
  trainTurns: turnTrain.length,
  holdoutTurns: turnHoldout.length,
  config: TURN_BOOST_CONFIG,
  rungsVsThinking: {
    meanDifference: rungsVsThinking.meanDifference,
    ciLower: rungsVsThinking.ciLower,
    ciUpper: rungsVsThinking.ciUpper,
  },
  boostVsRungs: {
    meanDifference: boostVsRungs.meanDifference,
    ciLower: boostVsRungs.ciLower,
    ciUpper: boostVsRungs.ciUpper,
  },
  combinedVsThinking: {
    meanDifference: combinedVsThinking.meanDifference,
    ciLower: combinedVsThinking.ciLower,
    ciUpper: combinedVsThinking.ciUpper,
  },
  p90Coverage: boostP90Coverage,
  adopt:
    combinedVsThinking.ciLower <= 0 &&
    boostP90Coverage >= 0.9 &&
    boostP90Coverage <= 1,
  candidateSchema: TURN_BOOST_CANDIDATE_SCHEMA,
  combinedV4VsThinking: {
    meanDifference: combinedV4VsThinking.meanDifference,
    ciLower: combinedV4VsThinking.ciLower,
    ciUpper: combinedV4VsThinking.ciUpper,
  },
  p90CoverageV4: boostV4P90Coverage,
  sessionSchema: TURN_BOOST_SESSION_SCHEMA,
  combinedV5VsThinking: {
    meanDifference: combinedV5VsThinking.meanDifference,
    ciLower: combinedV5VsThinking.ciLower,
    ciUpper: combinedV5VsThinking.ciUpper,
  },
  p90CoverageV5: boostV5P90Coverage,
};
// The v4 arm must clear the same bar the incumbent clears, on the same
// holdout: no PROVABLE regression against the previously shipped thinking-only
// turn groups, and P90 coverage still inside [0.90, 1].
turnTotalGate.adoptV4 =
  combinedV4VsThinking.ciLower <= 0 &&
  boostV4P90Coverage >= 0.9 &&
  boostV4P90Coverage <= 1;
// Same bar for the v5 arm.
turnTotalGate.adoptV5 =
  combinedV5VsThinking.ciLower <= 0 &&
  boostV5P90Coverage >= 0.9 &&
  boostV5P90Coverage <= 1;

// ---------------------------------------------------------------------------
// Stage 1 part 2 gate: does the base text head earn four columns in the
// turn-total correction?
//
// Protocol is the B.3 d1 one from probe_semantic_scale.py, moved onto the
// shipped trainer: five chronological session blocks over the exact turns
// whose opener text was recoverable, leave-one-block-out, both arms trained
// inside each fold off the same rung ladder, summed pinball at p50/p90/p99,
// and a 2,000-resample session-block bootstrap on the paired per-turn loss
// difference. v4 adopts only when the WHOLE 95% CI is below zero and no
// single fold is worse than +5%.
// ---------------------------------------------------------------------------
const TEXT_HEAD_FOLDS = 5;
const TEXT_HEAD_FOLD_TOLERANCE_PCT = 5;

/** np.array_split over sessions ordered by first activity: the B.3 fold shape. */
function sessionBlocks(turns, foldCount) {
  const bySession = new Map();
  for (const turn of turns) {
    const sessionKey = turn.sessionId ?? `unknown:${turn.turnRootId}`;
    if (!bySession.has(sessionKey)) bySession.set(sessionKey, []);
    bySession.get(sessionKey).push(turn);
  }
  const ordered = [...bySession.values()].sort(
    (left, right) => left[0].firstMs - right[0].firstMs,
  );
  const base = Math.floor(ordered.length / foldCount);
  const remainder = ordered.length % foldCount;
  const blocks = [];
  let cursor = 0;
  for (let index = 0; index < foldCount; index++) {
    const take = base + (index < remainder ? 1 : 0);
    blocks.push(ordered.slice(cursor, cursor + take).flat());
    cursor += take;
  }
  return blocks;
}

const meanTurnLoss = (turns, forecasts) =>
  turns.reduce((sum, turn, index) => sum + turnLoss(turn, forecasts[index]), 0) /
  Math.max(1, turns.length);

const headBlocks = sessionBlocks(headTurns, TEXT_HEAD_FOLDS);
const headFolds = [];
const headRecords = [];
for (let fold = 0; fold < TEXT_HEAD_FOLDS; fold++) {
  const test = headBlocks[fold];
  const train = headBlocks.filter((_, index) => index !== fold).flat();
  if (test.length === 0 || train.length === 0) continue;
  const ladder = turnLadder(train, TURN_RUNGS);
  const control = trainPortableQuantileBoost(
    train,
    ladder,
    turnConfigAt(TURN_BOOST_HEAD_CONTROL_SCHEMA),
  );
  const candidate = trainPortableQuantileBoost(
    train,
    ladder,
    turnConfigAt(TURN_BOOST_CANDIDATE_SCHEMA),
  );
  const controlForecasts = test.map((turn) => control.predict(turn));
  const candidateForecasts = test.map((turn) => candidate.predict(turn));
  const controlLoss = meanTurnLoss(test, controlForecasts);
  const candidateLoss = meanTurnLoss(test, candidateForecasts);
  headFolds.push({
    fold: fold + 1,
    turns: test.length,
    trainTurns: train.length,
    controlLoss,
    candidateLoss,
    percent: controlLoss === 0 ? 0 : 100 * (candidateLoss / controlLoss - 1),
  });
  for (let index = 0; index < test.length; index++) {
    headRecords.push({
      turn: test[index],
      control: controlForecasts[index],
      candidate: candidateForecasts[index],
    });
  }
}
const headComparison = blockBootstrapDifference(
  headRecords.map(
    (record) =>
      turnLoss(record.turn, record.candidate) - turnLoss(record.turn, record.control),
  ),
  headRecords.map((record) => record.turn.sessionId ?? null),
);
const headControlLoss = meanTurnLoss(
  headRecords.map((record) => record.turn),
  headRecords.map((record) => record.control),
);
const headCandidateLoss = meanTurnLoss(
  headRecords.map((record) => record.turn),
  headRecords.map((record) => record.candidate),
);
const asPercent = (value) =>
  headControlLoss === 0 ? 0 : (100 * value) / headControlLoss;
const worstFoldPercent = headFolds.reduce(
  (worst, fold) => Math.max(worst, fold.percent),
  Number.NEGATIVE_INFINITY,
);
const textHeadGate = {
  protocol:
    `B.3 d1: ${TEXT_HEAD_FOLDS} chronological session blocks over exact turns ` +
    "with recoverable opener text, leave-one-block-out, pinball at p50/p90/p99, " +
    "2,000-resample session-block bootstrap on the paired per-turn difference",
  rule:
    `adopt ${TURN_BOOST_CANDIDATE_SCHEMA} iff the whole 95% CI versus ` +
    `${TURN_BOOST_HEAD_CONTROL_SCHEMA} is below zero AND no fold is worse than ` +
    `+${TEXT_HEAD_FOLD_TOLERANCE_PCT}% AND both arms clear the turn-total gate`,
  controlSchema: TURN_BOOST_HEAD_CONTROL_SCHEMA,
  candidateSchema: TURN_BOOST_CANDIDATE_SCHEMA,
  baseTextHeadVersion: BASE_TEXT_HEAD_VERSION,
  exactTurns: allTurns.length,
  turnsWithText: headTurns.length,
  sessionsWithText: new Set(
    headTurns.map((turn) => turn.sessionId ?? `unknown:${turn.turnRootId}`),
  ).size,
  turnRootsWithText: turnsWithText,
  controlLoss: headControlLoss,
  candidateLoss: headCandidateLoss,
  percent: headControlLoss === 0 ? 0 : 100 * (headCandidateLoss / headControlLoss - 1),
  meanDifference: headComparison.meanDifference,
  ciLower: headComparison.ciLower,
  ciUpper: headComparison.ciUpper,
  percentCiLower: asPercent(headComparison.ciLower),
  percentCiUpper: asPercent(headComparison.ciUpper),
  worstFoldPercent,
  folds: headFolds,
  ciBelowZero: headComparison.ciUpper < 0,
  foldsWithinTolerance: worstFoldPercent <= TEXT_HEAD_FOLD_TOLERANCE_PCT,
  turnTotalGateAdopt: turnTotalGate.adopt,
  turnTotalGateAdoptV4: turnTotalGate.adoptV4,
};
textHeadGate.adopt =
  textHeadGate.ciBelowZero &&
  textHeadGate.foldsWithinTolerance &&
  turnTotalGate.adopt &&
  turnTotalGate.adoptV4;
const deployedTurnSchema = textHeadGate.adopt
  ? TURN_BOOST_CANDIDATE_SCHEMA
  : TURN_BOOST_CONFIG.featureSchema;

// ---------------------------------------------------------------------------
// The final, all-data turn models -- the ones that actually ship -- plus the
// typing simulation from probe-turn-total-boost.mjs. A config that is monotone
// on a train split can pick up a mid-typing dip once it is refitted on
// everything, and the live chip is the product surface, so the trajectory of
// the shipped model is recorded next to its gate.
// ---------------------------------------------------------------------------
const TYPING_PHRASES = [
  "can you write",
  "can you write a small report",
  "can you write a small report into a file",
  "can you write a small report into a file lets say ./here.txt",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr",
  "can you write a small report into a file lets say ./here.txt a report about predicting output tokens.\n\nthen review a random pr in the internet",
];
const turnModelCounts = new Map();
for (const turn of allTurns) {
  turnModelCounts.set(turn.model, (turnModelCounts.get(turn.model) ?? 0) + 1);
}
const demoModel =
  [...turnModelCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
  "unknown";
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
    // v4 only reads this; every older schema ignores it.
    textHead: baseTextHead(text),
  };
};
const typingTrajectory = (predict, makeTurn = demoTurn) => {
  const p50s = TYPING_PHRASES.map((text) => predict(makeTurn(text))[0]);
  let drops = 0;
  for (let index = 1; index < p50s.length; index++) {
    if (p50s[index] < p50s[index - 1]) drops++;
  }
  return { p50s, growth: p50s[p50s.length - 1] - p50s[0], drops };
};
const finalTurnLadder = turnLadder(allTurns, TURN_RUNGS);
const finalTurnBoosts = new Map(
  [TURN_BOOST_CONFIG.featureSchema, TURN_BOOST_CANDIDATE_SCHEMA].map((schema) => [
    schema,
    trainPortableQuantileBoost(allTurns, finalTurnLadder, turnConfigAt(schema)),
  ]),
);
textHeadGate.typing = {
  demoModel,
  phrases: TYPING_PHRASES.length,
  incumbent: {
    featureSchema: TURN_BOOST_CONFIG.featureSchema,
    ...typingTrajectory((turn) =>
      finalTurnBoosts.get(TURN_BOOST_CONFIG.featureSchema).predict(turn),
    ),
  },
  candidate: {
    featureSchema: TURN_BOOST_CANDIDATE_SCHEMA,
    ...typingTrajectory((turn) =>
      finalTurnBoosts.get(TURN_BOOST_CANDIDATE_SCHEMA).predict(turn),
    ),
  },
};
// Support, graded the way the per-call schema gate grades its own new column:
// a candidate whose extra columns are never chosen as a split trains trees
// identical to the control, and a zero difference would then read as "no
// regression" rather than as "dead feature".
const countSplitsAtOrAbove = (model, firstIndex) => {
  let splits = 0;
  const walk = (node) => {
    if (node.feature === undefined) return;
    if (node.feature >= firstIndex) splits++;
    walk(node.left);
    walk(node.right);
  };
  for (const trees of model.ensembles) for (const tree of trees) walk(tree);
  return splits;
};
const CONTROL_WIDTH = BOOST_FEATURE_COUNT_BY_SCHEMA[TURN_BOOST_HEAD_CONTROL_SCHEMA];
textHeadGate.candidateHeadSplits = countSplitsAtOrAbove(
  finalTurnBoosts.get(TURN_BOOST_CANDIDATE_SCHEMA).model,
  CONTROL_WIDTH,
);
textHeadGate.deployedTurnSchema = deployedTurnSchema;

// ---------------------------------------------------------------------------
// Context-signals follow-up (docs/CONTEXT-SIGNALS-PLAN.md, "Decision",
// 3 Sep 2026). The sklearn probe found that the whole win of the session-so-far
// family is two columns -- the turn index and the previous turn's size -- at
// -1.6% [-3.0%, -0.05%]. This is that pair through the REAL gate: schema v5
// against the v3 control, the identical protocol the v4 text head was graded
// with, so the two results are directly comparable.
//
// Nothing here touches what ships. `deployedTurnSchema` above is decided by the
// existing gates; this block only records whether v5 would earn a wiring task.
// ---------------------------------------------------------------------------
const SESSION_FOLDS = TEXT_HEAD_FOLDS;
const SESSION_FOLD_TOLERANCE_PCT = TEXT_HEAD_FOLD_TOLERANCE_PCT;
const sessionBlocksForGate = sessionBlocks(allTurns, SESSION_FOLDS);
const sessionFolds = [];
const sessionRecords = [];
for (let fold = 0; fold < SESSION_FOLDS; fold++) {
  const test = sessionBlocksForGate[fold];
  const train = sessionBlocksForGate.filter((_, index) => index !== fold).flat();
  if (test.length === 0 || train.length === 0) continue;
  const ladder = turnLadder(train, TURN_RUNGS);
  const control = trainPortableQuantileBoost(
    train,
    ladder,
    turnConfigAt(TURN_BOOST_HEAD_CONTROL_SCHEMA),
  );
  const candidate = trainPortableQuantileBoost(
    train,
    ladder,
    turnConfigAt(TURN_BOOST_SESSION_SCHEMA),
  );
  const controlForecasts = test.map((turn) => control.predict(turn));
  const candidateForecasts = test.map((turn) => candidate.predict(turn));
  const controlLoss = meanTurnLoss(test, controlForecasts);
  const candidateLoss = meanTurnLoss(test, candidateForecasts);
  sessionFolds.push({
    fold: fold + 1,
    turns: test.length,
    trainTurns: train.length,
    controlLoss,
    candidateLoss,
    percent: controlLoss === 0 ? 0 : 100 * (candidateLoss / controlLoss - 1),
  });
  for (let index = 0; index < test.length; index++) {
    sessionRecords.push({
      turn: test[index],
      control: controlForecasts[index],
      candidate: candidateForecasts[index],
    });
  }
}
const sessionComparison = blockBootstrapDifference(
  sessionRecords.map(
    (record) =>
      turnLoss(record.turn, record.candidate) - turnLoss(record.turn, record.control),
  ),
  sessionRecords.map((record) => record.turn.sessionId ?? null),
);
const sessionControlLoss = meanTurnLoss(
  sessionRecords.map((record) => record.turn),
  sessionRecords.map((record) => record.control),
);
const sessionCandidateLoss = meanTurnLoss(
  sessionRecords.map((record) => record.turn),
  sessionRecords.map((record) => record.candidate),
);
const asSessionPercent = (value) =>
  sessionControlLoss === 0 ? 0 : (100 * value) / sessionControlLoss;
const worstSessionFoldPercent = sessionFolds.reduce(
  (worst, fold) => Math.max(worst, fold.percent),
  Number.NEGATIVE_INFINITY,
);
// The final all-data v5 model, for the split count and the typing trajectories.
// Deliberately NOT in `finalTurnBoosts`: that map is what the deployment block
// picks the shipped trees from, and this task does not ship v5.
const finalSessionBoost = trainPortableQuantileBoost(
  allTurns,
  finalTurnLadder,
  turnConfigAt(TURN_BOOST_SESSION_SCHEMA),
);
const sessionDemoTurn = (turnsSoFar) => (text) => ({
  ...demoTurn(text),
  sessionContext: { turnsSoFar },
});
const sessionSignalGate = {
  protocol:
    `B.3 d1: ${SESSION_FOLDS} chronological session blocks over all exact turns, ` +
    "leave-one-block-out, both arms trained inside each fold off the same rung " +
    "ladder, pinball at p50/p90/p99, 2,000-resample session-block bootstrap on " +
    "the paired per-turn difference",
  rule:
    `adopt ${TURN_BOOST_SESSION_SCHEMA} iff the whole 95% CI versus ` +
    `${TURN_BOOST_HEAD_CONTROL_SCHEMA} is below zero AND no fold is worse than ` +
    `+${SESSION_FOLD_TOLERANCE_PCT}% AND both arms clear the turn-total gate`,
  columns: {
    42: "log1p(turnsSoFar) / 6",
    43: "log1p(previousTurnOutputTokens) / 10",
    44: "session-context presence bit",
  },
  controlSchema: TURN_BOOST_HEAD_CONTROL_SCHEMA,
  candidateSchema: TURN_BOOST_SESSION_SCHEMA,
  exactTurns: allTurns.length,
  turnRoots: turnAccumulator.size,
  sessions: new Set(
    allTurns.map((turn) => turn.sessionId ?? `unknown:${turn.turnRootId}`),
  ).size,
  turnsWithPreviousOutput,
  turnsBeyondFirst: allTurns.filter((turn) => turn.sessionContext.turnsSoFar > 0).length,
  controlLoss: sessionControlLoss,
  candidateLoss: sessionCandidateLoss,
  percent:
    sessionControlLoss === 0
      ? 0
      : 100 * (sessionCandidateLoss / sessionControlLoss - 1),
  meanDifference: sessionComparison.meanDifference,
  ciLower: sessionComparison.ciLower,
  ciUpper: sessionComparison.ciUpper,
  percentCiLower: asSessionPercent(sessionComparison.ciLower),
  percentCiUpper: asSessionPercent(sessionComparison.ciUpper),
  worstFoldPercent: worstSessionFoldPercent,
  folds: sessionFolds,
  ciBelowZero: sessionComparison.ciUpper < 0,
  foldsWithinTolerance: worstSessionFoldPercent <= SESSION_FOLD_TOLERANCE_PCT,
  turnTotalGateAdopt: turnTotalGate.adopt,
  turnTotalGateAdoptV5: turnTotalGate.adoptV5,
  candidateSessionSplits: countSplitsAtOrAbove(finalSessionBoost.model, CONTROL_WIDTH),
  typing: {
    demoModel,
    phrases: TYPING_PHRASES.length,
    incumbent: {
      featureSchema: TURN_BOOST_CONFIG.featureSchema,
      ...typingTrajectory((turn) =>
        finalTurnBoosts.get(TURN_BOOST_CONFIG.featureSchema).predict(turn),
      ),
    },
    candidateTurnsSoFar0: {
      featureSchema: TURN_BOOST_SESSION_SCHEMA,
      turnsSoFar: 0,
      ...typingTrajectory((turn) => finalSessionBoost.predict(turn), sessionDemoTurn(0)),
    },
    candidateTurnsSoFar5: {
      featureSchema: TURN_BOOST_SESSION_SCHEMA,
      turnsSoFar: 5,
      ...typingTrajectory((turn) => finalSessionBoost.predict(turn), sessionDemoTurn(5)),
    },
  },
};
sessionSignalGate.adopt =
  sessionSignalGate.ciBelowZero &&
  sessionSignalGate.foldsWithinTolerance &&
  turnTotalGate.adopt &&
  turnTotalGate.adoptV5;
// Recorded, never applied here: adopting v5 is a wiring task of its own (the
// loader, the companion and telemetry all have to learn the family first).
sessionSignalGate.deployedTurnSchema = deployedTurnSchema;
sessionSignalGate.shipsThisRun = false;



let deployment = null;
if (baseProfileFile) {
  const baseProfile = JSON.parse(await readFile(baseProfileFile, "utf8"));
  const profileBase = (row) => {
    for (const groupKey of [key.mtp(row), key.path(row), key.mt(row), key.model(row), "overall"]) {
      if (groupKey === null) continue;
      const group = baseProfile.groups[groupKey];
      if (group?.sampleSize >= MIN_GROUP) return [group.p50, group.p90, group.p99];
    }
    return [1_000, 4_000, 12_000];
  };
  const trained = trainPortableQuantileBoost(rows, profileBase, {
    featureSchema: deployedSchema,
  });
  const profile = { ...baseProfile, boostedCorrection: trained.model };
  // Turn totals: refit adopted rungs and correction on ALL turns for
  // deployment, exactly like the per-call correction above.
  let turnDeployment = null;
  if (turnTotalGate.adopt) {
    const finalRungFits = TURN_RUNGS.map((rung) =>
      fitTurnGroups(allTurns, turnKey[rung]),
    );
    const rungGroups = {};
    for (const fits of finalRungFits) {
      for (const [key, value] of fits.entries()) {
        rungGroups[key] = {
          sampleSize: value.n,
          p50: value.q[0],
          p90: value.q[1],
          p99: value.q[2],
        };
      }
    }
    profile.turnTotals = { ...(baseProfile.turnTotals ?? {}), ...rungGroups };
    // Both all-data turn models were already trained for the typing check; the
    // gate decides which of them ships, so the shipped trees are literally the
    // trees whose trajectory was printed.
    const finalTurnBoost = finalTurnBoosts.get(deployedTurnSchema);
    profile.turnTotalBoost = finalTurnBoost.model;
    turnDeployment = {
      rungGroups: Object.keys(rungGroups).length,
      turnTotalBoost: {
        trainingSamples: finalTurnBoost.model.trainingSamples,
        featureSchema: finalTurnBoost.model.featureSchema,
        treesPerQuantile: finalTurnBoost.model.ensembles.map((trees) => trees.length),
      },
      textHeadAdopted: textHeadGate.adopt,
      baseTextHeadVersion: textHeadGate.adopt ? BASE_TEXT_HEAD_VERSION : null,
    };
  }
  deployment = {
    profileId: profile.id,
    trainingSamples: trained.model.trainingSamples,
    featureSchema: trained.model.featureSchema,
    treesPerQuantile: trained.model.ensembles.map((trees) => trees.length),
    schemaGate,
    turnTotalGate,
    textHeadGate,
    sessionSignalGate,
    deployedTurnSchema,
    turnDeployment,
  };
  if (profileOut) {
    await mkdir(path.dirname(profileOut), { recursive: true });
    await writeFile(profileOut, `${JSON.stringify(profile, null, 2)}\n`);
  }
  if (bundledOut) {
    await mkdir(path.dirname(bundledOut), { recursive: true });
    await writeFile(
      bundledOut,
      `import type { HistoricalForecastProfile } from "./historical.js";\n\n/**\n * Generated by eval-claude-code-history.mjs + eval-winning-boost.mjs.\n * Privacy-safe aggregates and shallow portable correction only; no prompt text.\n */\nexport const BUNDLED_CLAUDE_CODE_PROFILE: HistoricalForecastProfile = ${JSON.stringify(profile, null, 2)};\n`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  predictorVersion: "baseline-3-boosted/0.3.0",
  dataset: {
    filesScanned,
    calls: rows.length,
    sessions: new Set(rows.map((row) => row.sessionId).filter(Boolean)).size,
    users: 1,
  },
  method: {
    base: "model+thinking+promptPath -> pooled promptPath -> model+thinking -> model -> overall",
    correction: `48 depth-3 trees per quantile; portable structured pre-call, deployed schema ${deployedSchema}`,
    adoption: "paired session-block bootstrap CI upper < 0",
    breakthrough: "at least 5% loss reduction or material width reduction without calibration damage",
  },
  singleSplit,
  rolling,
  segments: {
    byWorkload: segment((row) => row.workloadId),
    byModelThinking: segment((row) => `${row.model}|thinking=${row.thinking}`),
    byPromptPath: segment((row) => row.promptPath),
    bySessionPosition: segment((row) =>
      row.sessionPosition < 5
        ? "0-4"
        : row.sessionPosition < 20
          ? "5-19"
          : row.sessionPosition < 60
            ? "20-59"
            : "60+",
    ),
    byDeliverable: segment((row) => row.turnPrompt?.deliverableType ?? null),
    byFollowupCompression: segment(
      (row) =>
        row.turnPrompt === null || row.turnPrompt === undefined
          ? null
          : row.turnPrompt.followupCompression
            ? "yes"
            : "no",
      1,
    ),
  },
  schemaGate,
  turnTotalGate,
  textHeadGate,
  sessionSignalGate,
  deployment,
};
await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const show = (label, evaluation) =>
  `${label}: loss=${evaluation.loss.toFixed(1)} coverage=${evaluation.coverage.map((value) => `${(value * 100).toFixed(1)}%`).join("/")} widths=${evaluation.width.map((value) => Math.round(value)).join("/")}`;
console.log(show("Single baseline", singleSplit.baseline));
console.log(show("Single boosted ", singleSplit.boosted));
console.log(
  `Single diff ${singleSplit.comparison.meanDifference.toFixed(1)} ` +
    `[${singleSplit.comparison.ciLower.toFixed(1)}, ${singleSplit.comparison.ciUpper.toFixed(1)}]`,
);
console.log(show("Rolling baseline", rolling.baseline));
console.log(show("Rolling boosted ", rolling.boosted));
console.log(
  `Rolling diff ${rolling.comparison.meanDifference.toFixed(1)} ` +
    `[${rolling.comparison.ciLower.toFixed(1)}, ${rolling.comparison.ciUpper.toFixed(1)}]`,
);
for (const fold of rolling.folds) {
  console.log(
    `  fold ${fold.fold}: ${fold.comparison.meanDifference.toFixed(1)} ` +
      `[${fold.comparison.ciLower.toFixed(1)}, ${fold.comparison.ciUpper.toFixed(1)}]`,
  );
}
console.log(show("Rolling v3     ", rolling.candidate));
console.log(
  `Schema v3-v2 ${schemaGate.meanDifference.toFixed(2)} ` +
    `[${schemaGate.ciLower.toFixed(2)}, ${schemaGate.ciUpper.toFixed(2)}] ` +
    `p90cov=${(schemaGate.p90Coverage * 100).toFixed(1)}% ` +
    `support=${candidateFeatureRows} calls / ${candidateFeatureTurns} turns -> ` +
    `${schemaGate.adopt ? "ADOPTED" : "NOT ADOPTED"} (deploying ${deployedSchema})`,
);
const compressionSegment = report.segments.byFollowupCompression.yes;
if (compressionSegment) {
  console.log(
    `  compression follow-ups n=${compressionSegment.n}: v3-v2 ` +
      `${compressionSegment.schemaComparison.meanDifference.toFixed(2)} ` +
      `[${compressionSegment.schemaComparison.ciLower.toFixed(2)}, ` +
      `${compressionSegment.schemaComparison.ciUpper.toFixed(2)}]`,
  );
}
const gateLine = (label, pair) =>
  `${label}: ${pair.meanDifference.toFixed(1)}/turn ` +
  `[${pair.ciLower.toFixed(1)}, ${pair.ciUpper.toFixed(1)}]`;
console.log(gateLine("Turn rungs vs thinking-only", turnTotalGate.rungsVsThinking));
console.log(gateLine("Turn boost vs rungs        ", turnTotalGate.boostVsRungs));
console.log(
  `${gateLine("Turn rungs+boost vs shipped", turnTotalGate.combinedVsThinking)} ` +
    `p90cov=${(turnTotalGate.p90Coverage * 100).toFixed(1)}% -> ` +
    `${turnTotalGate.adopt ? "ADOPTED (no-provable-regression rule)" : "NOT ADOPTED"}`,
);
console.log(
  `${gateLine("Turn v4 rungs+boost vs shipped", turnTotalGate.combinedV4VsThinking)} ` +
    `p90cov=${(turnTotalGate.p90CoverageV4 * 100).toFixed(1)}% -> ` +
    `${turnTotalGate.adoptV4 ? "PASSES" : "FAILS"}`,
);
console.log(
  `Text head ${textHeadGate.candidateSchema} vs ${textHeadGate.controlSchema} on ` +
    `${textHeadGate.turnsWithText}/${textHeadGate.exactTurns} exact turns with text ` +
    `in ${textHeadGate.sessionsWithText} sessions (head ${textHeadGate.baseTextHeadVersion}):`,
);
console.log(
  `  loss ${textHeadGate.controlLoss.toFixed(1)} -> ${textHeadGate.candidateLoss.toFixed(1)} ` +
    `(${textHeadGate.percent.toFixed(2)}%), diff ${textHeadGate.meanDifference.toFixed(1)} ` +
    `[${textHeadGate.ciLower.toFixed(1)}, ${textHeadGate.ciUpper.toFixed(1)}] ` +
    `= [${textHeadGate.percentCiLower.toFixed(2)}%, ${textHeadGate.percentCiUpper.toFixed(2)}%]`,
);
for (const fold of textHeadGate.folds) {
  console.log(
    `  fold ${fold.fold}: n=${fold.turns} ${fold.controlLoss.toFixed(0)} -> ` +
      `${fold.candidateLoss.toFixed(0)} (${fold.percent >= 0 ? "+" : ""}${fold.percent.toFixed(1)}%)`,
  );
}
console.log(
  `  head splits in the final candidate model: ${textHeadGate.candidateHeadSplits}`,
);
console.log(
  `  worst fold ${textHeadGate.worstFoldPercent >= 0 ? "+" : ""}` +
    `${textHeadGate.worstFoldPercent.toFixed(1)}% ` +
    `(ciBelowZero=${textHeadGate.ciBelowZero}, foldsWithinTolerance=${textHeadGate.foldsWithinTolerance}, ` +
    `turnGate=${turnTotalGate.adopt}, turnGateV4=${turnTotalGate.adoptV4}) -> ` +
    `${textHeadGate.adopt ? "ADOPTED" : "NOT ADOPTED"} (deploying ${deployedTurnSchema})`,
);
for (const arm of ["incumbent", "candidate"]) {
  const track = textHeadGate.typing[arm];
  console.log(
    `  typing ${arm} (${track.featureSchema}): ${track.p50s.map((value) => Math.round(value)).join(",")} ` +
      `drops=${track.drops} growth=${Math.round(track.growth)}`,
  );
}
console.log(
  `Session signals ${sessionSignalGate.candidateSchema} vs ${sessionSignalGate.controlSchema} on ` +
    `${sessionSignalGate.exactTurns} exact turns in ${sessionSignalGate.sessions} sessions ` +
    `(${sessionSignalGate.turnsBeyondFirst} past the session's first turn, ` +
    `${sessionSignalGate.turnsWithPreviousOutput}/${sessionSignalGate.turnRoots} turn roots ` +
    "with a completed predecessor):",
);
console.log(
  `  loss ${sessionSignalGate.controlLoss.toFixed(1)} -> ${sessionSignalGate.candidateLoss.toFixed(1)} ` +
    `(${sessionSignalGate.percent.toFixed(2)}%), diff ${sessionSignalGate.meanDifference.toFixed(1)} ` +
    `[${sessionSignalGate.ciLower.toFixed(1)}, ${sessionSignalGate.ciUpper.toFixed(1)}] ` +
    `= [${sessionSignalGate.percentCiLower.toFixed(2)}%, ${sessionSignalGate.percentCiUpper.toFixed(2)}%]`,
);
for (const fold of sessionSignalGate.folds) {
  console.log(
    `  fold ${fold.fold}: n=${fold.turns} ${fold.controlLoss.toFixed(0)} -> ` +
      `${fold.candidateLoss.toFixed(0)} (${fold.percent >= 0 ? "+" : ""}${fold.percent.toFixed(1)}%)`,
  );
}
console.log(
  `${gateLine("Turn v5 rungs+boost vs shipped", turnTotalGate.combinedV5VsThinking)} ` +
    `p90cov=${(turnTotalGate.p90CoverageV5 * 100).toFixed(1)}% -> ` +
    `${turnTotalGate.adoptV5 ? "PASSES" : "FAILS"}`,
);
console.log(
  `  session splits in the final candidate model: ${sessionSignalGate.candidateSessionSplits}`,
);
console.log(
  `  worst fold ${sessionSignalGate.worstFoldPercent >= 0 ? "+" : ""}` +
    `${sessionSignalGate.worstFoldPercent.toFixed(1)}% ` +
    `(ciBelowZero=${sessionSignalGate.ciBelowZero}, ` +
    `foldsWithinTolerance=${sessionSignalGate.foldsWithinTolerance}, ` +
    `turnGate=${turnTotalGate.adopt}, turnGateV5=${turnTotalGate.adoptV5}) -> ` +
    `${sessionSignalGate.adopt ? "ADOPTED" : "NOT ADOPTED"} ` +
    `(this run still deploys ${deployedTurnSchema}; wiring is a separate task)`,
);
for (const arm of ["incumbent", "candidateTurnsSoFar0", "candidateTurnsSoFar5"]) {
  const track = sessionSignalGate.typing[arm];
  console.log(
    `  typing ${arm} (${track.featureSchema}): ${track.p50s.map((value) => Math.round(value)).join(",")} ` +
      `drops=${track.drops} growth=${Math.round(track.growth)}`,
  );
}
console.log(`Wrote ${jsonOut}`);

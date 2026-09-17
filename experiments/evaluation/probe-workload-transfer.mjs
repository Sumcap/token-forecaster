#!/usr/bin/env node
/**
 * probe-workload-transfer.mjs - leave-one-project-out transfer.
 *
 * The shipped profile was fitted on one person's ~/.claude. This probe asks the
 * only between-population question the corpus can answer today: does a fit
 * survive being moved to a workload it never saw? `loadRequests` already hashes
 * each project directory into `workloadId` (lib/load-history.mjs), so every
 * project is a pseudo-user.
 *
 * READ THE ASYMMETRY BEFORE READING THE NUMBERS. All projects share one person,
 * one prompting style, one toolchain, one machine, one Claude Code version, one
 * model mix, one era, one account. With the person held fixed, a PASS is a lower
 * bound on the trouble and never a clearance; a FAIL is conclusive in the other
 * direction, because a fit that cannot survive the same person changing project
 * will not survive the person changing.
 *
 * Protocol, per eligible project u:
 *   test    = u's last 20% of sessions, chronologically by session start.
 *   transfer fit = every OTHER project's rows strictly before the test start.
 *   within  fit  = u's OWN rows strictly before the test start.
 * Both fits are scored on the same test rows, so the pinball difference is
 * paired and blocks on u's sessions. The time cut applies to both, so neither
 * fit sees the future.
 *
 * THRESHOLDS, FIXED BEFORE THE FIRST RUN (docs/MULTI-USER-PLAN.md section 1):
 *   PASS ("generalizes better than feared"): every PRIMARY project holds
 *     transfer P90 coverage >= 85%, every restore-scale sits inside
 *     [0.75, 1.35], and the boost does not make transfer worse than the bare
 *     ladder.
 *   FAIL ("mostly personal"): any PRIMARY project needs a rescale beyond 1.5x,
 *     or covers under 80% at P90, or the boost trees make transfer worse than
 *     the bare ladder.
 *   Anything else is MIXED and decides nothing on its own.
 *
 * Eligibility, also fixed before the run. PRIMARY is the plan's rule: >= 15
 * sessions and >= 300 calls. The live tree holds only four of those, so a
 * SECONDARY tier (>= 8 sessions and >= 300 calls) is measured and printed for
 * information. Secondary projects never move the verdict.
 *
 * Artifact: experiments/artifacts/workload-transfer.json - aggregates only,
 * salted workload hashes, no prompt or response text.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { trainPortableQuantileBoost } from "./lib/quantile-boost.mjs";
import {
  BOOTSTRAP_SEED,
  bootstrapBlocks,
  blockBootstrapDifference,
  mulberry32,
  pinball,
  quantile,
} from "./lib/stats.mjs";

const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;
const MIN_TURN_GROUP = 60;
const BOOST_CONFIG = { featureSchema: "portable-precall-v2" };
const TURN_BOOST_CONFIG = {
  featureSchema: "portable-precall-v2",
  minimumLeaf: 60,
  iterations: 24,
  maxDepth: 2,
  learningRate: 0.05,
};
const PRIMARY = { sessions: 15, calls: 300 };
const SECONDARY = { sessions: 8, calls: 300 };
const MIN_TEST = { sessions: 3, calls: 50 };
const GATE = {
  passCoverageP90: 0.85,
  passScaleRange: [0.75, 1.35],
  failCoverageP90: 0.8,
  failScale: 1.5,
};

// --- corpus ----------------------------------------------------------------
const projectsDir = defaultProjectsDir();
const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
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
  const key = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  sessions.get(key).push(row);
}
for (const list of sessions.values()) {
  list.sort((left, right) => left.timestampMs - right.timestampMs);
  list.forEach((row, index) => {
    row.sessionPosition = index;
  });
}
// Same featurization as eval-winning-boost.mjs and probe-reviewer-checks.mjs.
// A probe that featurized differently would be measuring a different model.
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
}

// --- the shipped per-call ladder -------------------------------------------
const fit = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    q: QUANTILES.map((probability) => Math.round(quantile(sorted, probability))),
  };
};
function fitGroups(trainRows, keyFn, minimum) {
  const grouped = new Map();
  for (const row of trainRows) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.outputTokens);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length >= minimum)
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
const LADDER = [key.mtp, key.path, key.mt, key.model];
function makeLadder(trainRows) {
  const fits = LADDER.map((keyFn) => fitGroups(trainRows, keyFn, MIN_GROUP));
  const overall = fit(trainRows.map((row) => row.outputTokens));
  return (row) => {
    for (let index = 0; index < LADDER.length; index++) {
      const groupKey = LADDER[index](row);
      if (groupKey === null) continue;
      const found = fits[index].get(groupKey);
      if (found) return found.q;
    }
    return overall.q;
  };
}

// --- the shipped turn ladder ------------------------------------------------
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
function makeTurnLadder(turns) {
  const fits = TURN_RUNGS.map((rung) =>
    fitGroups(turns, turnKey[rung], MIN_TURN_GROUP),
  );
  const overall = fit(turns.map((turn) => turn.outputTokens));
  return (turn) => {
    for (let index = 0; index < TURN_RUNGS.length; index++) {
      const groupKey = turnKey[TURN_RUNGS[index]](turn);
      if (groupKey === null) continue;
      const found = fits[index].get(groupKey);
      if (found) return found.q;
    }
    return overall.q;
  };
}

// Turn totals, assembled exactly as eval-winning-boost.mjs does them.
const turnAccumulator = new Map();
for (const row of rows) {
  if (row.turnRootId == null) continue;
  let turn = turnAccumulator.get(row.turnRootId);
  if (!turn) {
    turn = {
      sessionId: row.sessionId ?? null,
      workloadId: row.workloadId,
      total: 0,
      exact: true,
      firstMs: Infinity,
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
  turn.timestampMs = turn.firstMs;
  turn.outputTokens = turn.total;
}

// Whole-session totals: unconditional only, which is all the shipped profile
// carries (STATE-OF-PLAY 6.26).
const sessionTotals = [];
for (const [sessionId, list] of sessions.entries()) {
  const workloadId = list[0].workloadId;
  let total = 0;
  for (const row of list) total += row.outputTokens;
  sessionTotals.push({
    sessionId,
    workloadId,
    outputTokens: total,
    timestampMs: list[0].timestampMs,
  });
}
sessionTotals.sort((left, right) => left.timestampMs - right.timestampMs);

// --- scoring ---------------------------------------------------------------
const loss = (actual, forecast) =>
  QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(actual, forecast[index], probability),
    0,
  );
/** Session-cluster bootstrap CI for a coverage rate. */
function coverageCi(hits, sessionIds) {
  if (hits.length === 0) return [null, null];
  const { blocks } = bootstrapBlocks(sessionIds);
  const random = mulberry32(BOOTSTRAP_SEED);
  const draws = [];
  for (let draw = 0; draw < 2_000; draw++) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      for (const position of block) {
        sum += hits[position];
        count++;
      }
    }
    draws.push(count === 0 ? 0 : sum / count);
  }
  draws.sort((left, right) => left - right);
  return [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]];
}
/**
 * The single multiplicative factor that restores a target coverage at one
 * quantile. Same bisection as probe-reviewer-checks.mjs: 60 halvings over
 * [0.05, 20] is exact to well past the reported precision.
 */
function restoreScale(records, quantileIndex, target) {
  let low = 0.05;
  let high = 20;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    const covered =
      records.filter((r) => r.actual <= r.forecast[quantileIndex] * mid).length /
      records.length;
    if (covered < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function score(records) {
  const n = records.length;
  const coverage = [0, 0, 0];
  let total = 0;
  for (const record of records) {
    total += loss(record.actual, record.forecast);
    for (let index = 0; index < 3; index++) {
      if (record.actual <= record.forecast[index]) coverage[index]++;
    }
  }
  const sessionIds = records.map((record) => record.sessionId);
  return {
    n,
    loss: total / n,
    coverage: coverage.map((value) => value / n),
    coverageCi: [0, 1, 2].map((index) =>
      coverageCi(
        records.map((record) => (record.actual <= record.forecast[index] ? 1 : 0)),
        sessionIds,
      ),
    ),
    restoreScaleP90: restoreScale(records, 1, 0.9),
    restoreScaleP50: restoreScale(records, 0, 0.5),
    restoreScaleP99: restoreScale(records, 2, 0.99),
    meanP90: records.reduce((sum, record) => sum + record.forecast[1], 0) / n,
  };
}
const paired = (transfer, within) =>
  blockBootstrapDifference(
    transfer.map((record, index) => loss(record.actual, record.forecast) - loss(within[index].actual, within[index].forecast)),
    transfer.map((record) => record.sessionId),
  );

// --- pseudo-users ----------------------------------------------------------
const workloads = new Map();
for (const row of rows) {
  let entry = workloads.get(row.workloadId);
  if (!entry) {
    entry = { workloadId: row.workloadId, calls: 0, sessionIds: new Set() };
    workloads.set(row.workloadId, entry);
  }
  entry.calls++;
  if (row.sessionId) entry.sessionIds.add(row.sessionId);
}
const tierOf = (entry) => {
  const sessionCount = entry.sessionIds.size;
  if (sessionCount >= PRIMARY.sessions && entry.calls >= PRIMARY.calls) return "primary";
  if (sessionCount >= SECONDARY.sessions && entry.calls >= SECONDARY.calls) return "secondary";
  return null;
};
const eligible = [...workloads.values()]
  .map((entry) => ({ ...entry, tier: tierOf(entry) }))
  .filter((entry) => entry.tier !== null)
  .sort((left, right) => right.calls - left.calls);

console.log(
  `corpus ${rows.length} calls / ${sessions.size} sessions / ${allTurns.length} exact turns / ${filesScanned} files`,
);
console.log(
  `pseudo-users: ${eligible.filter((e) => e.tier === "primary").length} primary, ${eligible.filter((e) => e.tier === "secondary").length} secondary (of ${workloads.size} projects)`,
);

// --- leave one project out --------------------------------------------------
/** u's last 20% of sessions, chronological by session start. */
function holdoutFor(workloadId) {
  const own = [...sessions.entries()]
    .filter(([, list]) => list[0].workloadId === workloadId)
    .sort((left, right) => left[1][0].timestampMs - right[1][0].timestampMs);
  const cut = Math.floor(own.length * 0.8);
  const testSessions = own.slice(cut);
  const testRows = testSessions.flatMap(([, list]) => list);
  const startMs = testRows.length === 0 ? Infinity : Math.min(...testRows.map((r) => r.timestampMs));
  return { own, testSessions, testRows, startMs };
}

const results = [];
for (const workload of eligible) {
  const { own, testSessions, testRows, startMs } = holdoutFor(workload.workloadId);
  if (testSessions.length < MIN_TEST.sessions || testRows.length < MIN_TEST.calls) {
    console.log(
      `skip ${workload.workloadId}: holdout ${testSessions.length} sessions / ${testRows.length} calls is under the declared floor`,
    );
    results.push({
      workloadId: workload.workloadId,
      tier: workload.tier,
      skipped: `holdout under floor (${testSessions.length} sessions, ${testRows.length} calls)`,
    });
    continue;
  }
  const transferTrain = rows.filter(
    (row) => row.workloadId !== workload.workloadId && row.timestampMs < startMs,
  );
  const withinTrain = rows.filter(
    (row) => row.workloadId === workload.workloadId && row.timestampMs < startMs,
  );
  const entry = {
    workloadId: workload.workloadId,
    tier: workload.tier,
    calls: workload.calls,
    sessions: workload.sessionIds.size,
    holdout: {
      sessions: testSessions.length,
      calls: testRows.length,
      trainCallsTransfer: transferTrain.length,
      trainCallsWithin: withinTrain.length,
      trainProjectsTransfer: new Set(transferTrain.map((row) => row.workloadId)).size,
    },
  };

  // per call: ladder only, and ladder + boost.
  const transferLadder = makeLadder(transferTrain);
  const withinLadder = makeLadder(withinTrain);
  const transferBoost = trainPortableQuantileBoost(transferTrain, transferLadder, BOOST_CONFIG);
  const withinBoost = trainPortableQuantileBoost(withinTrain, withinLadder, BOOST_CONFIG);
  const asRecord = (row, forecast) => ({
    actual: row.outputTokens,
    forecast,
    sessionId: row.sessionId ?? null,
  });
  const call = {
    ladder: {
      transfer: testRows.map((row) => asRecord(row, transferLadder(row))),
      within: testRows.map((row) => asRecord(row, withinLadder(row))),
    },
    boosted: {
      transfer: testRows.map((row) => asRecord(row, transferBoost.predict(row))),
      within: testRows.map((row) => asRecord(row, withinBoost.predict(row))),
    },
  };
  entry.perCall = {};
  for (const variant of ["ladder", "boosted"]) {
    entry.perCall[variant] = {
      transfer: score(call[variant].transfer),
      within: score(call[variant].within),
      transferMinusWithin: paired(call[variant].transfer, call[variant].within),
    };
  }
  // Does the boost travel worse than the bare rungs? Paired on the same rows.
  entry.perCall.boostMinusLadderOnTransfer = paired(
    call.boosted.transfer,
    call.ladder.transfer,
  );

  // turn totals
  const testSessionIds = new Set(testSessions.map(([id]) => id));
  const testTurns = allTurns.filter(
    (turn) => turn.workloadId === workload.workloadId && testSessionIds.has(turn.sessionId),
  );
  if (testTurns.length >= 20) {
    const transferTurnTrain = allTurns.filter(
      (turn) => turn.workloadId !== workload.workloadId && turn.firstMs < startMs,
    );
    const withinTurnTrain = allTurns.filter(
      (turn) => turn.workloadId === workload.workloadId && turn.firstMs < startMs,
    );
    const transferTurnLadder = makeTurnLadder(transferTurnTrain);
    const transferTurnBoost = trainPortableQuantileBoost(
      transferTurnTrain,
      transferTurnLadder,
      TURN_BOOST_CONFIG,
    );
    const turnRecords = testTurns.map((turn) => ({
      actual: turn.total,
      forecast: transferTurnBoost.predict(turn),
      sessionId: turn.sessionId,
    }));
    entry.turnTotals = {
      turns: testTurns.length,
      trainTurnsTransfer: transferTurnTrain.length,
      trainTurnsWithin: withinTurnTrain.length,
      transfer: score(turnRecords),
    };
    if (withinTurnTrain.length >= MIN_TURN_GROUP) {
      const withinTurnLadder = makeTurnLadder(withinTurnTrain);
      const withinRecords = testTurns.map((turn) => ({
        actual: turn.total,
        forecast: withinTurnLadder(turn),
        sessionId: turn.sessionId,
      }));
      entry.turnTotals.within = score(withinRecords);
      entry.turnTotals.transferMinusWithin = paired(turnRecords, withinRecords);
    } else {
      entry.turnTotals.within = null;
      entry.turnTotals.withinUnavailable = `only ${withinTurnTrain.length} own turns before the cut, under MIN_TURN_GROUP ${MIN_TURN_GROUP}`;
    }
  } else {
    entry.turnTotals = { turns: testTurns.length, skipped: "under 20 held-out turns" };
  }

  // session totals, unconditional
  const testSessionTotals = sessionTotals.filter((s) => testSessionIds.has(s.sessionId));
  const transferSessionTrain = sessionTotals.filter(
    (s) => s.workloadId !== workload.workloadId && s.timestampMs < startMs,
  );
  if (testSessionTotals.length >= MIN_TEST.sessions && transferSessionTrain.length >= 30) {
    const transferQ = fit(transferSessionTrain.map((s) => s.outputTokens)).q;
    const records = testSessionTotals.map((s) => ({
      actual: s.outputTokens,
      forecast: transferQ,
      sessionId: s.sessionId,
    }));
    entry.sessionTotals = {
      sessions: testSessionTotals.length,
      trainSessionsTransfer: transferSessionTrain.length,
      transfer: score(records),
    };
  } else {
    entry.sessionTotals = {
      sessions: testSessionTotals.length,
      skipped: "not enough held-out or training sessions",
    };
  }

  results.push(entry);
  const perCall = entry.perCall.boosted;
  console.log(
    `\n${workload.workloadId} [${workload.tier}] ${workload.calls} calls / ${workload.sessionIds.size} sessions` +
      `  holdout ${testRows.length} calls in ${testSessions.length} sessions`,
  );
  for (const variant of ["ladder", "boosted"]) {
    const v = entry.perCall[variant];
    console.log(
      `  ${variant.padEnd(7)} transfer loss ${v.transfer.loss.toFixed(1).padStart(7)}` +
        `  cov ${v.transfer.coverage.map((c) => (c * 100).toFixed(1) + "%").join("/")}` +
        `  P90cov CI [${(v.transfer.coverageCi[1][0] * 100).toFixed(1)}%, ${(v.transfer.coverageCi[1][1] * 100).toFixed(1)}%]` +
        `  restoreP90 x${v.transfer.restoreScaleP90.toFixed(2)}` +
        `  vs within ${v.transferMinusWithin.meanDifference >= 0 ? "+" : ""}${v.transferMinusWithin.meanDifference.toFixed(1)}` +
        ` [${v.transferMinusWithin.ciLower.toFixed(1)}, ${v.transferMinusWithin.ciUpper.toFixed(1)}]`,
    );
  }
  const bl = entry.perCall.boostMinusLadderOnTransfer;
  console.log(
    `  boost-minus-ladder on transfer ${bl.meanDifference >= 0 ? "+" : ""}${bl.meanDifference.toFixed(1)} [${bl.ciLower.toFixed(1)}, ${bl.ciUpper.toFixed(1)}]`,
  );
  if (entry.turnTotals.transfer) {
    const t = entry.turnTotals.transfer;
    console.log(
      `  turnTotal transfer over ${entry.turnTotals.turns} turns  cov ${t.coverage.map((c) => (c * 100).toFixed(1) + "%").join("/")}` +
        `  restoreP90 x${t.restoreScaleP90.toFixed(2)}`,
    );
  }
  if (entry.sessionTotals.transfer) {
    const s = entry.sessionTotals.transfer;
    console.log(
      `  sessionTotal transfer over ${entry.sessionTotals.sessions} sessions  cov ${s.coverage.map((c) => (c * 100).toFixed(1) + "%").join("/")}` +
        `  restoreP90 x${s.restoreScaleP90.toFixed(2)}`,
    );
  }
  console.log(`  perCall boosted P50/P99 restore x${perCall.transfer.restoreScaleP50.toFixed(2)} / x${perCall.transfer.restoreScaleP99.toFixed(2)}`);
}

// --- verdict against the pre-declared thresholds -----------------------------
const graded = results.filter((entry) => entry.tier === "primary" && !entry.skipped);
const reasons = [];
let failed = false;
let passed = graded.length > 0;
for (const entry of graded) {
  const v = entry.perCall.boosted.transfer;
  if (v.coverage[1] < GATE.failCoverageP90) {
    failed = true;
    reasons.push(
      `${entry.workloadId}: transfer P90 coverage ${(v.coverage[1] * 100).toFixed(1)}% is under the ${GATE.failCoverageP90 * 100}% fail line`,
    );
  } else if (v.coverage[1] < GATE.passCoverageP90) {
    passed = false;
    reasons.push(
      `${entry.workloadId}: transfer P90 coverage ${(v.coverage[1] * 100).toFixed(1)}% misses the ${GATE.passCoverageP90 * 100}% pass line`,
    );
  }
  if (v.restoreScaleP90 > GATE.failScale) {
    failed = true;
    reasons.push(
      `${entry.workloadId}: needs x${v.restoreScaleP90.toFixed(2)} to restore 90% coverage, beyond the x${GATE.failScale} fail line`,
    );
  } else if (
    v.restoreScaleP90 < GATE.passScaleRange[0] ||
    v.restoreScaleP90 > GATE.passScaleRange[1]
  ) {
    passed = false;
    reasons.push(
      `${entry.workloadId}: restore-scale x${v.restoreScaleP90.toFixed(2)} is outside the pass range [${GATE.passScaleRange.join(", ")}]`,
    );
  }
  const bl = entry.perCall.boostMinusLadderOnTransfer;
  if (bl.ciLower > 0) {
    failed = true;
    reasons.push(
      `${entry.workloadId}: the boost trees travel WORSE than the bare ladder (+${bl.meanDifference.toFixed(1)} [${bl.ciLower.toFixed(1)}, ${bl.ciUpper.toFixed(1)}], whole CI above zero)`,
    );
  } else if (bl.meanDifference > 0) {
    passed = false;
    reasons.push(
      `${entry.workloadId}: the boost trees travel worse on average (+${bl.meanDifference.toFixed(1)} [${bl.ciLower.toFixed(1)}, ${bl.ciUpper.toFixed(1)}], CI straddles zero)`,
    );
  }
}
const verdict = failed ? "MOSTLY_PERSONAL" : passed ? "GENERALIZES" : "MIXED";
console.log(`\n=== verdict against the pre-declared thresholds: ${verdict}`);
for (const reason of reasons) console.log(`  - ${reason}`);
if (reasons.length === 0) console.log("  - every primary project cleared every threshold");

const out = path.join(process.cwd(), "experiments/artifacts/workload-transfer.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      probe: "probe-workload-transfer.mjs",
      readThisFirst:
        "Leave-one-project-out with the PERSON HELD FIXED. Every project shares one person, one prompting style, one toolchain, one machine, one Claude Code version, one model mix, one era, one account. A PASS is therefore a LOWER BOUND on the between-user problem and never a clearance. A FAIL is conclusive in the other direction: a fit that cannot survive the same person changing project will not survive the person changing.",
      privacy:
        "Aggregates and salted workload hashes only. No prompt text, no response text, no file paths.",
      corpus: {
        source: projectsDir,
        filesScanned,
        calls: rows.length,
        sessions: sessions.size,
        exactTurns: allTurns.length,
        projects: workloads.size,
      },
      protocol: {
        holdout: "the project's last 20% of sessions, chronological by session start",
        transferFit: "every OTHER project's rows strictly before the holdout start",
        withinFit: "the project's OWN rows strictly before the holdout start",
        blocks: "session (bootstrapBlocks), 2000 resamples, BOOTSTRAP_SEED",
        ladder: "model+thinking+promptPath -> pooled promptPath -> model+thinking -> model -> overall",
        boost: BOOST_CONFIG,
        turnBoost: TURN_BOOST_CONFIG,
        minGroup: MIN_GROUP,
        minTurnGroup: MIN_TURN_GROUP,
      },
      thresholds: {
        declaredBeforeRunning: true,
        eligibility: { primary: PRIMARY, secondary: SECONDARY, minimumHoldout: MIN_TEST },
        gate: GATE,
        gradedOn: "primary tier only; secondary projects are reported for information and never move the verdict",
      },
      verdict,
      verdictReasons: reasons,
      workloads: results,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${out}`);

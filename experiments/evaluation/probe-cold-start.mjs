#!/usr/bin/env node
/**
 * Grade the COLD-START path of the shipped ladder as a first-class citizen.
 *
 * The 9 August 2026 decision reframed the product: the predictor ships inside
 * sheep-manager and runs on machines with no telemetry, no history corpus and
 * often no agent-loop context. The zero-context path is the product; every
 * context-hungry rung is a bonus. This probe answers, in the same
 * rolling-origin harness as the eval, questions no report has answered:
 *
 *   A. What do the caller tiers actually score?
 *        full     model+thinking+promptPath ladder (the graded headline)
 *        tier b   {model, maxTokens, thinkingEnabled}   -> mt -> model -> overall
 *        tier a   {model, maxTokens}                    -> model -> overall
 *      each scored on the identical holdout calls, so the difference is
 *      exactly what the context-hungry rungs are worth.
 *
 *   B. Is the `overall` fallback CALIBRATED for a model the profile has never
 *      seen (`usedFallback: true`), or merely labelled low-confidence?
 *      Honest simulation = leave-one-model-out: refit every group with model M
 *      excluded from training, then score M's holdout calls through the
 *      fallback path a real unknown-model caller would take.
 *
 *   C. The untested candidate that only helps cold callers: pooled
 *      `thinking=yes|no` groups. The predictor's ladder has carried a
 *      ["thinking"] rung since June (HISTORICAL_GROUP_TIERS), but no shipped
 *      profile has ever materialized those groups, so a fallback caller that
 *      knows its thinking flag gets the same blended `overall` numbers as one
 *      that knows nothing. Thinking is the strongest pre-call signal in the
 *      corpus (~2.8x at the median); if the pooled rung clears the gate on
 *      leave-one-model-out calls, shipping it is pure profit for the product's
 *      primary path — and requires zero predictor code change.
 *
 * Population and statistics match eval-winning-boost.mjs / lib/stats.mjs:
 * chronological 80% seed, 5 rolling folds, minGroup 100, paired session-block
 * bootstrap for every adoption claim.
 *
 * Writes experiments/artifacts/cold-start-probe.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
  redactHome,
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
  path.join(process.cwd(), "experiments/artifacts/cold-start-probe.json"),
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
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
}
console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls\n`,
);

// ---------------------------------------------------------------------------
// Shared fitting machinery (mirrors eval-winning-boost.mjs)
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
const key = {
  mtp: (row) =>
    row.promptPath === null
      ? null
      : `model=${row.model}|thinking=${row.thinking}|promptPath=${row.promptPath}`,
  path: (row) => (row.promptPath === null ? null : `promptPath=${row.promptPath}`),
  mt: (row) => `model=${row.model}|thinking=${row.thinking}`,
  model: (row) => `model=${row.model}`,
  thinking: (row) => `thinking=${row.thinking}`,
};

/**
 * Build every ladder tier once per training slice. Each tier returns
 * { q, rung } so the report can say WHICH rung fired (house rule 12).
 */
function buildTiers(trainRows) {
  const fits = {
    mtp: fitGroups(trainRows, key.mtp),
    path: fitGroups(trainRows, key.path),
    mt: fitGroups(trainRows, key.mt),
    model: fitGroups(trainRows, key.model),
    thinking: fitGroups(trainRows, key.thinking),
  };
  const overall = { ...fit(trainRows.map((row) => row.outputTokens)), rung: "overall" };
  const walk = (row, rungs) => {
    for (const rung of rungs) {
      const group = key[rung](row);
      if (group === null) continue;
      const found = fits[rung].get(group);
      if (found) return { q: found.q, rung };
    }
    return { q: overall.q, rung: "overall" };
  };
  return {
    // The graded headline ladder (what the eval reports).
    full: (row) => walk(row, ["mtp", "path", "mt", "model"]),
    // Tier b: a cold caller that passes model + thinkingEnabled.
    coldModelThinking: (row) => walk(row, ["mt", "model"]),
    // Tier a: a cold caller that passes only model + maxTokens.
    coldModel: (row) => walk(row, ["model"]),
    // What today's profile hands a fallback (unknown-model) caller.
    overallOnly: () => ({ q: overall.q, rung: "overall" }),
    // Candidate: the pooled thinking rung the predictor already knows how to
    // read but no profile has ever shipped.
    thinkingPooled: (row) => {
      const found = fits.thinking.get(key.thinking(row));
      return found ? { q: found.q, rung: "thinking" } : { q: overall.q, rung: "overall" };
    },
  };
}

const totalLoss = (row, q) =>
  QUANTILES.reduce(
    (sum, probability, index) => sum + pinball(row.outputTokens, q[index], probability),
    0,
  );

function metrics(records, field) {
  const result = {
    n: records.length,
    loss: 0,
    perQuantileLoss: [0, 0, 0],
    coverage: [0, 0, 0],
    width: [0, 0],
    rungs: {},
  };
  for (const record of records) {
    const { q, rung } = record[field];
    result.rungs[rung] = (result.rungs[rung] ?? 0) + 1;
    for (let index = 0; index < QUANTILES.length; index++) {
      result.perQuantileLoss[index] += pinball(
        record.row.outputTokens,
        q[index],
        QUANTILES[index],
      );
      result.coverage[index] += record.row.outputTokens <= q[index] ? 1 : 0;
    }
    result.width[0] += q[1] - q[0];
    result.width[1] += q[2] - q[0];
  }
  result.perQuantileLoss = result.perQuantileLoss.map((value) => value / records.length);
  result.loss = result.perQuantileLoss.reduce((sum, value) => sum + value, 0);
  result.coverage = result.coverage.map((value) => value / records.length);
  result.width = result.width.map((value) => value / records.length);
  return result;
}

function compare(records, candidateField, baselineField) {
  const differences = records.map(
    (record) =>
      totalLoss(record.row, record[candidateField].q) -
      totalLoss(record.row, record[baselineField].q),
  );
  return blockBootstrapDifference(
    differences,
    records.map((record) => record.row.sessionId ?? null),
  );
}

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

// ---------------------------------------------------------------------------
// A. Tier scoreboard on the identical holdout calls
// ---------------------------------------------------------------------------

const TIER_FIELDS = ["full", "coldModelThinking", "coldModel", "overallOnly"];
const records = [];
for (const fold of folds) {
  const tiers = buildTiers(fold.train);
  for (const row of fold.test) {
    const record = { row };
    for (const field of [...TIER_FIELDS, "thinkingPooled"]) {
      record[field] = tiers[field](row);
    }
    records.push(record);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  calls: rows.length,
  holdoutCalls: records.length,
  minGroup: MIN_GROUP,
  tiers: {},
};

console.log("A. CALLER-TIER SCOREBOARD (rolling-origin holdout, identical calls)\n");
const header =
  "tier                      loss    p50cov  p90cov  p99cov  p90-p50  p99-p50";
console.log(header);
for (const field of TIER_FIELDS) {
  const m = metrics(records, field);
  report.tiers[field] = m;
  console.log(
    `${field.padEnd(24)} ${m.loss.toFixed(1).padStart(7)}  ${pct(m.coverage[0]).padStart(6)}  ${pct(m.coverage[1]).padStart(6)}  ${pct(m.coverage[2]).padStart(6)}  ${fmt(m.width[0]).padStart(7)}  ${fmt(m.width[1]).padStart(7)}`,
  );
}
for (const [candidate, baseline] of [
  ["coldModelThinking", "full"],
  ["coldModel", "coldModelThinking"],
]) {
  const comparison = compare(records, candidate, baseline);
  report.tiers[`${candidate}_vs_${baseline}`] = comparison;
  console.log(
    `  ${candidate} vs ${baseline}: +${comparison.meanDifference.toFixed(2)}/call ` +
      `[${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]`,
  );
}

// ---------------------------------------------------------------------------
// B/C. Leave-one-model-out: the honest unknown-model fallback simulation
// ---------------------------------------------------------------------------

console.log(
  "\nB. LEAVE-ONE-MODEL-OUT FALLBACK (score model M through a profile fitted without M)\n",
);

const lomoRecords = [];
const perModel = {};
for (const fold of folds) {
  const models = new Set(fold.test.map((row) => row.model));
  for (const excluded of models) {
    const trainWithout = fold.train.filter((row) => row.model !== excluded);
    if (trainWithout.length < MIN_GROUP) continue;
    const tiers = buildTiers(trainWithout);
    for (const row of fold.test) {
      if (row.model !== excluded) continue;
      lomoRecords.push({
        row,
        overallOnly: tiers.overallOnly(row),
        thinkingPooled: tiers.thinkingPooled(row),
      });
    }
  }
}
for (const excluded of [...new Set(lomoRecords.map((r) => r.row.model))].sort()) {
  const subset = lomoRecords.filter((record) => record.row.model === excluded);
  if (subset.length < 30) continue;
  perModel[excluded] = {
    n: subset.length,
    overallOnly: metrics(subset, "overallOnly"),
    thinkingPooled: metrics(subset, "thinkingPooled"),
  };
  const o = perModel[excluded].overallOnly;
  const t = perModel[excluded].thinkingPooled;
  console.log(`  excluded model ${excluded} (${subset.length} holdout calls)`);
  console.log(
    `    overall-blend    loss ${o.loss.toFixed(1).padStart(7)}  cov ${o.coverage.map(pct).join("/")}`,
  );
  console.log(
    `    +pooled thinking loss ${t.loss.toFixed(1).padStart(7)}  cov ${t.coverage.map(pct).join("/")}`,
  );
}
report.leaveOneModelOut = {
  perModel,
  pooled: {
    overallOnly: metrics(lomoRecords, "overallOnly"),
    thinkingPooled: metrics(lomoRecords, "thinkingPooled"),
  },
};

const lomoComparison = compare(lomoRecords, "thinkingPooled", "overallOnly");
report.leaveOneModelOut.comparison = lomoComparison;
console.log(
  `\n  pooled-thinking vs overall on ${lomoRecords.length} LOMO calls: ` +
    `${lomoComparison.meanDifference.toFixed(2)}/call ` +
    `[${lomoComparison.ciLower.toFixed(2)}, ${lomoComparison.ciUpper.toFixed(2)}] ` +
    `(${lomoComparison.blocks} ${lomoComparison.blockKind} blocks)` +
    `${lomoComparison.ciUpper < 0 ? "  <- clears the adoption gate" : "  <- CI includes 0"}`,
);

// ---------------------------------------------------------------------------
// C2. Ladder ORDER for a fallback caller that knows both thinking and the
// prompt-path bit. HISTORICAL_GROUP_TIERS reads pooled promptPath ABOVE pooled
// thinking, so once thinking groups ship, the predictor would still hand a
// prompt-bearing fallback caller the WEAKER conditioner. Measure all three
// fallback ladders on the same LOMO calls.
// ---------------------------------------------------------------------------

console.log("\nC2. FALLBACK LADDER ORDER on LOMO calls (both thinking and promptPath known where available)\n");
{
  const jointKey = (row) =>
    row.promptPath === null
      ? null
      : `thinking=${row.thinking}|promptPath=${row.promptPath}`;
  const pathKey = (row) =>
    row.promptPath === null ? null : `promptPath=${row.promptPath}`;
  const thinkingKey = (row) => `thinking=${row.thinking}`;
  const ladderRecords = [];
  for (const fold of folds) {
    const models = new Set(fold.test.map((row) => row.model));
    for (const excluded of models) {
      const trainWithout = fold.train.filter((row) => row.model !== excluded);
      if (trainWithout.length < MIN_GROUP) continue;
      const fits = {
        joint: fitGroups(trainWithout, jointKey),
        path: fitGroups(trainWithout, pathKey),
        thinking: fitGroups(trainWithout, thinkingKey),
      };
      const overall = fit(trainWithout.map((row) => row.outputTokens));
      const walk = (row, order) => {
        for (const rung of order) {
          const keyFns = { joint: jointKey, path: pathKey, thinking: thinkingKey };
          const group = keyFns[rung](row);
          if (group === null) continue;
          const found = fits[rung].get(group);
          if (found) return found.q;
        }
        return overall.q;
      };
      for (const row of fold.test) {
        if (row.model !== excluded) continue;
        ladderRecords.push({
          row,
          pathFirst: walk(row, ["path", "thinking"]), // predictor order today
          thinkingFirst: walk(row, ["thinking", "path"]),
          jointFirst: walk(row, ["joint", "thinking", "path"]),
        });
      }
    }
  }
  const scoreboard = {};
  for (const field of ["pathFirst", "thinkingFirst", "jointFirst"]) {
    const m = { loss: 0, coverage: [0, 0, 0] };
    for (const record of ladderRecords) {
      m.loss += totalLoss(record.row, record[field]);
      for (let i = 0; i < QUANTILES.length; i++) {
        m.coverage[i] += record.row.outputTokens <= record[field][i] ? 1 : 0;
      }
    }
    m.loss /= ladderRecords.length;
    m.coverage = m.coverage.map((v) => v / ladderRecords.length);
    scoreboard[field] = m;
    console.log(
      `  ${field.padEnd(14)} loss ${m.loss.toFixed(1)}  cov ${m.coverage.map(pct).join("/")}`,
    );
  }
  const orderComparisons = {};
  for (const [candidate, baseline] of [
    ["thinkingFirst", "pathFirst"],
    ["jointFirst", "thinkingFirst"],
  ]) {
    const differences = ladderRecords.map(
      (record) =>
        totalLoss(record.row, record[candidate]) - totalLoss(record.row, record[baseline]),
    );
    const comparison = blockBootstrapDifference(
      differences,
      ladderRecords.map((record) => record.row.sessionId ?? null),
    );
    orderComparisons[`${candidate}_vs_${baseline}`] = comparison;
    console.log(
      `  ${candidate} vs ${baseline}: ${comparison.meanDifference.toFixed(2)}/call ` +
        `[${comparison.ciLower.toFixed(2)}, ${comparison.ciUpper.toFixed(2)}]` +
        `${comparison.ciUpper < 0 ? "  <- clears the gate" : ""}`,
    );
  }
  report.fallbackLadderOrder = { scoreboard, comparisons: orderComparisons };
}

// ---------------------------------------------------------------------------
// C3. Does moving the pooled promptPath rung BELOW the thinking-family rungs
// change anything for in-profile callers? (The reorder is required so a
// fallback caller gets the stronger conditioner; it must not cost the callers
// the current order was measured on.)
// ---------------------------------------------------------------------------

console.log("\nC3. IN-PROFILE REORDER CHECK: mtp->path->mt->model (shipped) vs mtp->mt->model->thinking->path\n");
{
  const reorderRecords = [];
  for (const fold of folds) {
    const tiers = buildTiers(fold.train);
    const fits = {
      mtp: fitGroups(fold.train, key.mtp),
      path: fitGroups(fold.train, key.path),
      mt: fitGroups(fold.train, key.mt),
      model: fitGroups(fold.train, key.model),
      thinking: fitGroups(fold.train, key.thinking),
    };
    const overall = fit(fold.train.map((row) => row.outputTokens));
    const reordered = (row) => {
      for (const rung of ["mtp", "mt", "model", "thinking", "path"]) {
        const group = key[rung](row);
        if (group === null) continue;
        const found = fits[rung].get(group);
        if (found) return found.q;
      }
      return overall.q;
    };
    for (const row of fold.test) {
      reorderRecords.push({
        row,
        shipped: tiers.full(row).q,
        reordered: reordered(row),
      });
    }
  }
  const changed = reorderRecords.filter(
    (record) => record.shipped.join() !== record.reordered.join(),
  ).length;
  const differences = reorderRecords.map(
    (record) =>
      totalLoss(record.row, record.reordered) - totalLoss(record.row, record.shipped),
  );
  const comparison = blockBootstrapDifference(
    differences,
    reorderRecords.map((record) => record.row.sessionId ?? null),
  );
  report.inProfileReorder = { changedCalls: changed, comparison };
  console.log(
    `  forecasts changed on ${changed}/${reorderRecords.length} in-profile holdout calls; ` +
      `diff ${comparison.meanDifference.toFixed(3)}/call [${comparison.ciLower.toFixed(3)}, ${comparison.ciUpper.toFixed(3)}]`,
  );
}

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

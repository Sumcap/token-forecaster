#!/usr/bin/env node
/**
 * Evaluate output-token forecasts against real Claude Code API-call history.
 *
 * The script deliberately separates two jobs:
 *   1. descriptive statistics over all deduplicated API calls; and
 *   2. forward evaluation on a chronological holdout of uncensored calls.
 *
 * Calls ending at max_tokens or the model context limit are right-censored:
 * their natural output length is at least the observed length. They are
 * counted and reported, but excluded from ordinary empirical quantiles and
 * pinball-loss evaluation.
 *
 * A privacy-safe aggregate historical profile is written beside the report.
 * It contains only sample counts and quantiles, never transcript content.
 *
 * Model aliases are generated from @token-forecaster/model-registry rather than
 * hand-written here, so a dated snapshot id from the caller resolves onto
 * whichever form the transcripts recorded.
 *
 * Requires the model-registry package to have been built (`pnpm build`).
 *
 * Usage:
 *   node eval-claude-code-history.mjs
 *     [--projects-dir <dir>]
 *     [--out <report.json>]
 *     [--profile-out <profile.json>]
 *     [--bundled-profile-out <bundled-profile.ts>]
 *     [--train-fraction <0..1>]
 *     [--min-group-samples <integer>]
 *     [--cv-folds <integer>]
 */

import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

// Agent-loop reconstruction only. This script keeps its own scan for the
// population it evaluates (censoring, sidechains, input tokens, transcript
// copies), but the parentUuid walk is subtle enough that a second
// implementation of it would be a liability — the one bug that invented two
// published findings came from a second, subtly different loader. So the parent
// link is imported from the shared module and joined on requestId, at the cost
// of one extra pass over the transcripts.
import { loadRequests } from "./lib/load-history.mjs";
// The adoption statistic itself is shared, for the same reason. A probe grading
// with the 5-fold t while this script grades with a block bootstrap is how the
// same stable effect got adopted and refused twenty minutes apart (§7.1).
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  blockBootstrapDifference,
} from "./lib/stats.mjs";

const registryDist = path.join(
  import.meta.dirname,
  "..",
  "..",
  "packages",
  "model-registry",
  "dist",
  "index.js",
);
let listModelIdAliases;
try {
  ({ listModelIdAliases } = await import(registryDist));
} catch (error) {
  throw new Error(
    `Could not load the built model registry from ${registryDist}. ` +
      `Run \`pnpm build\` first. Original error: ${error.message}`,
  );
}

const STATIC_BASELINE = { p50: 1_000, p90: 4_000, p99: 12_000 };
const QUANTILES = [0.5, 0.9, 0.99];
const CENSORED_STOP_REASONS = new Set([
  "max_tokens",
  "model_context_window_exceeded",
]);
// Extended-thinking tokens are billed as output tokens, so the flag is the
// strongest pre-call signal we have. Transcripts do not record the request's
// thinking configuration, so we infer it from the emitted blocks. That is sound
// in one direction only: a thinking block implies thinking was enabled, while a
// request with thinking enabled that happens to emit no thinking block is
// labelled "no" here. The bias slightly inflates the "no" group; replace this
// inference with the recorded request configuration once first-party telemetry
// (Phase 3) lands.
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);
// Tiers materialized into the shipped profile. These must stay a subset of
// HISTORICAL_GROUP_TIERS in packages/predictor/src/historical.ts; a test in
// that package asserts every shipped key is reproducible by historicalGroupKey.
//
// Prompt-path and model+thinking+prevOutput tiers are appended only when their
// candidates clear this run's paired session-block bootstrap gate below.
const BASE_DEPLOYMENT_TIERS = [["model"], ["model", "thinking"]];
const PROMPT_PATH_TIERS = [
  ["model", "thinking", "promptPath"],
  ["promptPath"],
];
// Whether the turn-root message carries an image attachment. Found by
// probe-missing-signals.mjs (10 Aug 2026): negative at all five corpus
// endpoints tested, gate-clear at two. Ships only when the gate below clears
// on the current regeneration.
const PROMPT_IMAGE_TIERS = [
  ["model", "thinking", "promptImage"],
  ["promptImage"],
];
const PREV_OUTPUT_TIER = ["model", "thinking", "prevOutput"];
// Mirror of previousOutputBucket() in packages/predictor/src/historical.ts.
// These are the boundaries used by the original exploratory previous-output
// effect; the current evaluator re-tests the candidate with the bootstrap gate.
const PREV_OUTPUT_EDGES = [200, 800, 3_000];
// Repo rule 1: a change replaces the shipped predictor only if it BEATS it on
// held-out data. The test is a paired block bootstrap over per-call losses —
// adopt only when the upper end of the 95% CI is strictly below zero. See
// lib/stats.mjs's blockBootstrapDifference() for why the 5-fold t was not usable.
// Recency windows swept against the rolling-origin CV, in days. `null` means
// "use everything before the fold boundary".
const WINDOW_DAYS_SWEEP = [7, 14, 30, 90, null];
const DAY_MS = 24 * 60 * 60 * 1_000;

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function numericArg(flag, fallback) {
  const value = Number(argValue(flag, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${flag} must be numeric`);
  return value;
}

const projectsDir = argValue(
  "--projects-dir",
  path.join(homedir(), ".claude", "projects"),
);
const outFile = argValue(
  "--out",
  path.join(import.meta.dirname, "..", "artifacts", "claude-code-history-eval.json"),
);
const profileFile = argValue(
  "--profile-out",
  path.join(
    import.meta.dirname,
    "..",
    "artifacts",
    "claude-code-history-profile.json",
  ),
);
const bundledProfileFile = argValue(
  "--bundled-profile-out",
  path.join(
    import.meta.dirname,
    "..",
    "..",
    "packages",
    "predictor",
    "src",
    "bundled-profile.ts",
  ),
);
const trainFraction = numericArg("--train-fraction", 0.8);
const minGroupSamples = numericArg("--min-group-samples", 100);
const cvFolds = numericArg("--cv-folds", 5);
if (!(trainFraction > 0 && trainFraction < 1)) {
  throw new Error("--train-fraction must satisfy 0 < value < 1");
}
if (!Number.isInteger(minGroupSamples) || minGroupSamples <= 0) {
  throw new Error("--min-group-samples must be a positive integer");
}
if (!Number.isInteger(cvFolds) || cvFolds < 2) {
  throw new Error("--cv-folds must be an integer >= 2");
}

async function* jsonlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

function addToSet(target, value) {
  if (typeof value === "string" && value.length > 0) target.add(value);
}

// requestId -> merged API-call record. Claude Code may repeat a call once per
// content block and may copy it into forked transcripts.
const requests = new Map();
let filesScanned = 0;
let badLines = 0;
let assistantRows = 0;
let duplicateRows = 0;
let varyingDuplicateRows = 0;

for await (const file of jsonlFiles(projectsDir)) {
  filesScanned++;
  const lines = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"assistant"') || !line.includes("output_tokens")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (entry.type !== "assistant") continue;
    const usage = entry.message?.usage;
    const model = entry.message?.model;
    if (!entry.requestId || typeof usage?.output_tokens !== "number") continue;
    if (!model || model === "<synthetic>") continue;
    assistantRows++;

    const timestampMs = Date.parse(entry.timestamp ?? "");
    const previous = requests.get(entry.requestId);
    if (previous !== undefined) {
      duplicateRows++;
      if (previous.outputTokens !== usage.output_tokens) varyingDuplicateRows++;
    }

    const record = previous ?? {
      requestId: entry.requestId,
      outputTokens: usage.output_tokens,
      inputTokens: 0,
      model,
      sidechain: entry.isSidechain === true,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      stopReasons: new Set(),
      contentTypes: new Set(),
      transcriptFiles: new Set(),
    };

    if (usage.output_tokens >= record.outputTokens) {
      record.outputTokens = usage.output_tokens;
      record.inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      record.model = model;
    }
    // Prefer main-chain classification when the same call appears in both.
    record.sidechain = record.sidechain && entry.isSidechain === true;
    if (
      Number.isFinite(timestampMs) &&
      (record.timestampMs === null || timestampMs < record.timestampMs)
    ) {
      record.timestampMs = timestampMs;
    }
    addToSet(record.stopReasons, entry.message?.stop_reason);
    if (Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        addToSet(record.contentTypes, block?.type);
      }
    }
    record.transcriptFiles.add(file);
    requests.set(entry.requestId, record);
  }
}

/**
 * The previous call's output length, per requestId.
 *
 * "Previous" means the call this one is answering along the `parentUuid` chain,
 * not whatever was nearest in time: sidechains run concurrently inside a single
 * session, so timestamp order would hand a subagent's call a parent it never
 * saw. A call with no recoverable predecessor gets `undefined`, which every
 * consumer must treat as *unknown*, never as *short*.
 */
const loopContext = await loadRequests(projectsDir, {
  withLoopContext: true,
  withPromptFeatures: true,
});
const outputByRequestId = new Map(
  loopContext.rows.map((row) => [row.requestId, row.outputTokens]),
);
// Session id per call, used only to define bootstrap blocks: calls inside one
// session are correlated (same task, same files, same user), so they must be
// resampled together or the error bar comes out too small.
const sessionByRequestId = new Map(
  loopContext.rows
    .filter((row) => row.sessionId)
    .map((row) => [row.requestId, row.sessionId]),
);
const promptPathByRequestId = new Map(
  loopContext.rows
    .filter((row) => row.turnPrompt !== null)
    .map((row) => [row.requestId, row.turnPrompt.mentionsPath]),
);
// Image presence resolves whenever the turn ROOT resolves, including on
// command turns whose stripped prompt text is empty — so its coverage is
// slightly higher than the prompt-feature join above.
const promptImageByRequestId = new Map(
  loopContext.rows
    .filter((row) => row.turnHasImage !== null)
    .map((row) => [row.requestId, row.turnHasImage]),
);
const previousOutputByRequestId = new Map();
for (const row of loopContext.rows) {
  if (row.parentRequestId === null) continue;
  const parentOutput = outputByRequestId.get(row.parentRequestId);
  if (parentOutput !== undefined) {
    previousOutputByRequestId.set(row.requestId, parentOutput);
  }
}

const observations = [...requests.values()].map((record) => {
  const stopReasons = [...record.stopReasons].sort();
  const isCensored = stopReasons.some((reason) =>
    CENSORED_STOP_REASONS.has(reason),
  );
  return {
    requestId: record.requestId,
    outputTokens: record.outputTokens,
    inputTokens: record.inputTokens,
    model: record.model,
    sidechain: record.sidechain,
    thinking: [...record.contentTypes].some((type) =>
      THINKING_BLOCK_TYPES.has(type),
    ),
    timestampMs: record.timestampMs,
    stopReason: stopReasons.length === 0 ? "missing" : stopReasons.join("+"),
    contentTypes:
      record.contentTypes.size === 0
        ? "missing"
        : [...record.contentTypes].sort().join("+"),
    isCensored,
    transcriptCopies: record.transcriptFiles.size,
    // undefined when this call opens a turn or its ancestry is missing from the
    // transcript. Never coerce it to 0.
    previousOutputTokens: previousOutputByRequestId.get(record.requestId),
    // undefined means the human turn-root prompt could not be reconstructed;
    // false is a measured prompt that named no path. Never conflate the two.
    promptMentionsPath: promptPathByRequestId.get(record.requestId),
    // undefined means the turn root could not be reconstructed; false is a
    // resolved root with no image attached. Never conflate the two.
    promptHasImage: promptImageByRequestId.get(record.requestId),
    sessionId: sessionByRequestId.get(record.requestId) ?? null,
  };
});

if (observations.length === 0) {
  console.error(`No observations found under ${projectsDir}`);
  process.exit(1);
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * (index - lowerIndex);
}

function pinballLoss(values, prediction, probability) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const actual of values) {
    const difference = actual - prediction;
    sum +=
      difference >= 0
        ? probability * difference
        : (probability - 1) * difference;
  }
  return sum / values.length;
}

function coverage(values, bound) {
  if (values.length === 0) return null;
  return values.filter((value) => value <= bound).length / values.length;
}

function fitQuantiles(rows) {
  const sorted = rows.map((row) => row.outputTokens).sort((a, b) => a - b);
  return {
    sampleSize: sorted.length,
    p50: Math.round(quantile(sorted, 0.5)),
    p90: Math.round(quantile(sorted, 0.9)),
    p99: Math.round(quantile(sorted, 0.99)),
  };
}

function summarize(rows) {
  const values = rows.map((row) => row.outputTokens);
  const sorted = [...values].sort((a, b) => a - b);
  if (values.length === 0) return null;
  const baselineCoverage = {
    p50: coverage(values, STATIC_BASELINE.p50),
    p90: coverage(values, STATIC_BASELINE.p90),
    p99: coverage(values, STATIC_BASELINE.p99),
  };
  const baselinePinballLoss = {
    p50: pinballLoss(values, STATIC_BASELINE.p50, 0.5),
    p90: pinballLoss(values, STATIC_BASELINE.p90, 0.9),
    p99: pinballLoss(values, STATIC_BASELINE.p99, 0.99),
  };
  return {
    n: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    empirical: {
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      p99: quantile(sorted, 0.99),
    },
    baselineCoverage,
    pinballLoss: baselinePinballLoss,
  };
}

function histogram(rows) {
  const values = rows.map((row) => row.outputTokens);
  const edges = [];
  for (let exponent = 0; 2 ** exponent <= 65_536; exponent++) {
    edges.push(2 ** exponent);
  }
  const bins = edges.map((upper, index) => ({
    lower: index === 0 ? 0 : edges[index - 1],
    upper,
    count: 0,
  }));
  const overflow = { lower: edges[edges.length - 1], upper: null, count: 0 };
  for (const value of values) {
    const bin = bins.find((candidate) => value > candidate.lower && value <= candidate.upper);
    if (bin) bin.count++;
    else if (value === 0) bins[0].count++;
    else overflow.count++;
  }
  return [...bins, overflow].filter((bin) => bin.count > 0);
}

function groupedSummaries(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const group = key(row);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort((left, right) => right[1].length - left[1].length)
      .map(([group, values]) => [group, summarize(values)]),
  );
}

/**
 * Bucket the previous call's output length, or null when there wasn't one.
 *
 * Returning null (rather than a "none" level) is what makes the ladder SKIP the
 * rung for a turn-opening call. Turn-opening calls are the longest in the
 * corpus and are overwhelmingly thinking-enabled; filing them under the
 * smallest bucket would poison it in the one direction we cannot afford.
 */
function previousOutputBucket(tokens) {
  if (tokens === undefined) return null;
  const [small, medium, large] = PREV_OUTPUT_EDGES;
  if (tokens < small) return `lt${small}`;
  if (tokens < medium) return `${small}-${medium}`;
  if (tokens < large) return `${medium}-${large}`;
  return `gte${large}`;
}

/**
 * The same feature with `<200` folded into `200-800`.
 *
 * Measured separately because a short previous reply tested at 0.97x — i.e. no
 * effect — so the extra level may be buying nothing but thinner groups. Repo
 * rule 7: when two ladders tie, take the shorter one.
 */
function previousOutputBucketMerged(tokens) {
  const bucket = previousOutputBucket(tokens);
  return bucket === `lt${PREV_OUTPUT_EDGES[0]}`
    ? `${PREV_OUTPUT_EDGES[0]}-${PREV_OUTPUT_EDGES[1]}`
    : bucket;
}

function inputBucket(tokens) {
  if (tokens < 5_000) return "lt5k";
  if (tokens < 20_000) return "5k-20k";
  if (tokens < 100_000) return "20k-100k";
  if (tokens < 300_000) return "100k-300k";
  return "gte300k";
}

function fitGroups(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const group = key(row);
    // A null key means the feature is unknown for this row, so the row does not
    // belong to any level of it — it must not become a "null" group that the
    // forecaster could then select.
    if (group === null) continue;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(row);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length >= minGroupSamples)
      .map(([group, values]) => [group, fitQuantiles(values)]),
  );
}

/**
 * Keep only the trailing `windowDays` of a (chronologically sorted) training
 * slice. The window is anchored on the last training timestamp, not on wall
 * clock, so a fold's window means the same thing wherever the fold sits.
 */
function applyWindow(rows, windowDays) {
  if (windowDays === null || rows.length === 0) return rows;
  const cutoff = rows[rows.length - 1].timestampMs - windowDays * DAY_MS;
  return rows.filter((row) => row.timestampMs >= cutoff);
}

const eligible = observations.filter((row) => !row.isCensored);
const timedEligible = eligible
  .filter((row) => row.timestampMs !== null)
  .sort((left, right) => left.timestampMs - right.timestampMs);
if (timedEligible.length < 2) {
  throw new Error("At least two timestamped uncensored observations are required");
}
const splitIndex = Math.max(
  1,
  Math.min(timedEligible.length - 1, Math.floor(timedEligible.length * trainFraction)),
);
const train = timedEligible.slice(0, splitIndex);
const holdout = timedEligible.slice(splitIndex);

/**
 * Fit every candidate predictor on one training slice.
 *
 * The `input` / sidechain variants are kept only to document negative results:
 * conditioning on an input-size bucket has now been tested four independent
 * ways and hurt p99 every time, which is why neither dimension survives in
 * HISTORICAL_GROUP_TIERS.
 */
function buildPredictors(trainRows) {
  const globalFit = fitQuantiles(trainRows);
  const modelFits = fitGroups(trainRows, (row) => row.model);
  const modelThinkingFits = fitGroups(
    trainRows,
    (row) => `${row.model}|${row.thinking}`,
  );
  const modelInputFits = fitGroups(
    trainRows,
    (row) => `${row.model}|${inputBucket(row.inputTokens)}`,
  );
  const modelInputChainFits = fitGroups(
    trainRows,
    (row) => `${row.model}|${inputBucket(row.inputTokens)}|${row.sidechain}`,
  );
  const modelThinkingInputFits = fitGroups(
    trainRows,
    (row) => `${row.model}|${row.thinking}|${inputBucket(row.inputTokens)}`,
  );

  const promptPathValue = (row) =>
    row.promptMentionsPath === undefined
      ? null
      : row.promptMentionsPath
        ? "yes"
        : "no";
  const promptPathJointKey = (row) => {
    const value = promptPathValue(row);
    return value === null ? null : `${row.model}|${row.thinking}|${value}`;
  };
  const modelThinkingPromptPathFits = fitGroups(
    trainRows,
    promptPathJointKey,
  );
  const pooledPromptPathFits = fitGroups(trainRows, promptPathValue);

  const promptImageValue = (row) =>
    row.promptHasImage === undefined ? null : row.promptHasImage ? "yes" : "no";
  const promptImageJointKey = (row) => {
    const value = promptImageValue(row);
    return value === null ? null : `${row.model}|${row.thinking}|img=${value}`;
  };
  const modelThinkingPromptImageFits = fitGroups(trainRows, promptImageJointKey);
  const pooledPromptImageFits = fitGroups(trainRows, (row) => {
    const value = promptImageValue(row);
    return value === null ? null : `img=${value}`;
  });

  // The previous call's output size, on top of the shipped ladder. `bucket` is
  // null for a call with no recoverable predecessor, and a null key skips the
  // rung rather than selecting a level of it.
  const prevOutputKey = (bucket) => (row) => {
    const value = bucket(row.previousOutputTokens);
    return value === null ? null : `${row.model}|${row.thinking}|${value}`;
  };
  const modelThinkingPrevOutputFits = fitGroups(
    trainRows,
    prevOutputKey(previousOutputBucket),
  );
  const modelThinkingPrevOutputMergedFits = fitGroups(
    trainRows,
    prevOutputKey(previousOutputBucketMerged),
  );

  const byModel = (row) => modelFits.get(row.model) ?? globalFit;
  const byModelThinking = (row) =>
    modelThinkingFits.get(`${row.model}|${row.thinking}`) ?? byModel(row);
  const promptPathFit = (row) => {
    const value = promptPathValue(row);
    if (value === null) return undefined;
    const joint = promptPathJointKey(row);
    return (joint === null ? undefined : modelThinkingPromptPathFits.get(joint)) ??
      pooledPromptPathFits.get(value);
  };
  const byPromptPath = (row) => promptPathFit(row) ?? byModelThinking(row);
  const promptImageFit = (row) => {
    const value = promptImageValue(row);
    if (value === null) return undefined;
    const joint = promptImageJointKey(row);
    return (
      (joint === null ? undefined : modelThinkingPromptImageFits.get(joint)) ??
      pooledPromptImageFits.get(`img=${value}`)
    );
  };
  const byPromptImage = (row) => promptImageFit(row) ?? byModelThinking(row);
  const byPrevOutput = (fits, bucket) => (row) => {
    const key = prevOutputKey(bucket)(row);
    return (key === null ? undefined : fits.get(key)) ?? byModelThinking(row);
  };
  const byPromptPathThenPrevOutput = (fits, bucket) => (row) => {
    const pathFit = promptPathFit(row);
    if (pathFit !== undefined) return pathFit;
    const key = prevOutputKey(bucket)(row);
    return (key === null ? undefined : fits.get(key)) ?? byModelThinking(row);
  };

  return {
    static: () => STATIC_BASELINE,
    historicalGlobal: () => globalFit,
    historicalModel: byModel,
    historicalModelInput: (row) =>
      modelInputFits.get(`${row.model}|${inputBucket(row.inputTokens)}`) ??
      byModel(row),
    historicalModelInputChain: (row) =>
      modelInputChainFits.get(
        `${row.model}|${inputBucket(row.inputTokens)}|${row.sidechain}`,
      ) ??
      modelInputFits.get(`${row.model}|${inputBucket(row.inputTokens)}`) ??
      byModel(row),
    // Shipped predictor.
    historicalModelThinking: byModelThinking,
    historicalModelThinkingInput: (row) =>
      modelThinkingInputFits.get(
        `${row.model}|${row.thinking}|${inputBucket(row.inputTokens)}`,
      ) ?? byModelThinking(row),
    // Candidates for adoption on top of the shipped predictor.
    historicalModelThinkingPromptPath: byPromptPath,
    historicalModelThinkingPromptImage: byPromptImage,
    historicalModelThinkingPrevOutput: byPrevOutput(
      modelThinkingPrevOutputFits,
      previousOutputBucket,
    ),
    historicalModelThinkingPrevOutputMerged: byPrevOutput(
      modelThinkingPrevOutputMergedFits,
      previousOutputBucketMerged,
    ),
    historicalModelThinkingPromptPathPrevOutput: byPromptPathThenPrevOutput(
      modelThinkingPrevOutputFits,
      previousOutputBucket,
    ),
    historicalModelThinkingPromptPathPrevOutputMerged:
      byPromptPathThenPrevOutput(
        modelThinkingPrevOutputMergedFits,
        previousOutputBucketMerged,
      ),
  };
}

// Retained alongside the rolling-origin CV below: the single 80/20 split is
// the number every earlier result in docs/ was reported against, so keeping it
// makes the before/after comparable.
const singleSplitPredictors = buildPredictors(train);
const PREDICTOR_NAMES = Object.keys(singleSplitPredictors);

function evaluate(predict, holdoutRows) {
  const result = {};
  for (const probability of QUANTILES) {
    const name = `p${probability * 100}`;
    let covered = 0;
    let loss = 0;
    let averagePrediction = 0;
    for (const row of holdoutRows) {
      const prediction = predict(row)[name];
      const difference = row.outputTokens - prediction;
      covered += row.outputTokens <= prediction;
      loss +=
        difference >= 0
          ? probability * difference
          : (probability - 1) * difference;
      averagePrediction += prediction;
    }
    const empiricalCoverage = covered / holdoutRows.length;
    result[name] = {
      targetCoverage: probability,
      empiricalCoverage,
      calibrationError: empiricalCoverage - probability,
      pinballLoss: loss / holdoutRows.length,
      averagePrediction: averagePrediction / holdoutRows.length,
    };
  }
  result.totalPinballLoss = QUANTILES.reduce(
    (sum, probability) => sum + result[`p${probability * 100}`].pinballLoss,
    0,
  );
  return result;
}

/**
 * The same loss, one number per held-out call instead of one per fold.
 *
 * This is what makes an honest error bar possible. Summarising 2,900 held-out
 * calls into a single fold total and then testing on 5 of those totals throws
 * away almost all the data, and the resulting standard error is estimated from
 * 5 numbers — which is why the identical comparison passed at one moment and
 * failed twenty minutes later on 160 more calls.
 *
 * Every value here is still strictly out-of-sample: `predict` was fitted on
 * data strictly before its fold boundary and is never refitted on the holdout.
 */
function perCallTotalPinball(predict, holdoutRows) {
  const losses = new Float64Array(holdoutRows.length);
  for (let index = 0; index < holdoutRows.length; index++) {
    const row = holdoutRows[index];
    const prediction = predict(row);
    let total = 0;
    for (const probability of QUANTILES) {
      const difference = row.outputTokens - prediction[`p${probability * 100}`];
      total +=
        difference >= 0
          ? probability * difference
          : (probability - 1) * difference;
    }
    losses[index] = total;
  }
  return losses;
}


/**
 * Rolling-origin cross-validation.
 *
 * A single 80/20 chronological split gives one number per predictor, and the
 * differences we were reading off it (+/-2%) are smaller than the variation
 * between periods. This walks the origin forward instead: fold k trains on
 * everything before its boundary and tests on the block that follows, so every
 * fold is still strictly forward-looking but we get a mean and a spread rather
 * than a single sample.
 *
 *   fold 1: [train      ][test]
 *   fold 2: [train         ][test]
 *   fold 3: [train            ][test]
 */
function rollingOriginFolds(rows, folds) {
  // The first `trainFraction` of the data is the seed training set that fold 1
  // starts from; the remainder is cut into `folds` equal test blocks.
  const seed = Math.floor(rows.length * trainFraction);
  const blockSize = Math.floor((rows.length - seed) / folds);
  if (blockSize < 1) {
    throw new Error(
      `Not enough observations for ${folds} folds at trainFraction ${trainFraction}`,
    );
  }
  return Array.from({ length: folds }, (_, index) => {
    const start = seed + index * blockSize;
    const end = index === folds - 1 ? rows.length : start + blockSize;
    return { train: rows.slice(0, start), holdout: rows.slice(start, end) };
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Run every predictor across every fold at one recency window, and summarize
 * each predictor by the mean and spread of its total pinball loss.
 */
function crossValidate(folds, windowDays) {
  // Per-call out-of-sample losses, concatenated across folds. Each fold's
  // holdout block is disjoint, so every held-out call appears exactly once and
  // the concatenation is one clean out-of-sample series per predictor. Kept
  // outside `perFold` because it must never reach the report JSON.
  const perCall = Object.fromEntries(PREDICTOR_NAMES.map((name) => [name, []]));
  const perCallSessions = [];

  const perFold = folds.map(({ train: trainRows, holdout: holdoutRows }) => {
    const windowed = applyWindow(trainRows, windowDays);
    // A window can starve a fold of data entirely; fall back to the full
    // history rather than fitting quantiles on nothing.
    const fitted = buildPredictors(windowed.length > 0 ? windowed : trainRows);
    for (const name of PREDICTOR_NAMES) {
      const losses = perCallTotalPinball(fitted[name], holdoutRows);
      for (const loss of losses) perCall[name].push(loss);
    }
    for (const row of holdoutRows) perCallSessions.push(row.sessionId ?? null);
    return {
      trainCalls: windowed.length,
      holdoutCalls: holdoutRows.length,
      holdoutFrom: new Date(holdoutRows[0].timestampMs).toISOString(),
      evaluation: Object.fromEntries(
        PREDICTOR_NAMES.map((name) => [
          name,
          evaluate(fitted[name], holdoutRows),
        ]),
      ),
    };
  });

  const summary = Object.fromEntries(
    PREDICTOR_NAMES.map((name) => {
      const totals = perFold.map((fold) => fold.evaluation[name].totalPinballLoss);
      const coverageP90 = perFold.map(
        (fold) => fold.evaluation[name].p90.empiricalCoverage,
      );
      return [
        name,
        {
          meanTotalPinballLoss: mean(totals),
          stdDevTotalPinballLoss: standardDeviation(totals),
          minTotalPinballLoss: Math.min(...totals),
          maxTotalPinballLoss: Math.max(...totals),
          perFoldTotalPinballLoss: totals,
          meanCoverageP90: mean(coverageP90),
        },
      ];
    }),
  );

  // `perCall` / `perCallSessions` are deliberately NOT part of the returned
  // report shape — they are ~14k floats per predictor and belong in the test,
  // not in a committed artifact. They are attached non-enumerably so the
  // adoption tests can reach them while JSON.stringify cannot.
  const run = { windowDays, folds: perFold, summary };
  Object.defineProperty(run, "perCall", { value: perCall, enumerable: false });
  Object.defineProperty(run, "perCallSessions", {
    value: perCallSessions,
    enumerable: false,
  });
  return run;
}

const generatedAt = new Date().toISOString();

const cvFoldSlices = rollingOriginFolds(timedEligible, cvFolds);
const windowSweep = WINDOW_DAYS_SWEEP.map((windowDays) =>
  crossValidate(cvFoldSlices, windowDays),
);

const SHIPPED_PREDICTOR = "historicalModelThinking";
const noWindowRun = windowSweep.find((run) => run.windowDays === null);

/**
 * Compare a windowed run against the no-window baseline fold by fold.
 *
 * Folds differ enormously from each other (the spread across folds is ~70
 * total pinball), so comparing two means directly says almost nothing. The
 * folds are paired, though — same holdout blocks, same everything but the
 * window — so the per-fold difference cancels that shared variation, and its
 * standard error is the right yardstick for "is this bigger than noise".
 */
function pairedImprovement(run) {
  const baseline = noWindowRun.perCall[SHIPPED_PREDICTOR];
  const candidate = run.perCall[SHIPPED_PREDICTOR];
  const differences = candidate.map((value, index) => value - baseline[index]);
  const bootstrap = blockBootstrapDifference(differences, run.perCallSessions);
  // Retained for continuity with every number published before 4 August 2026,
  // and so the two inferences can be compared side by side. It is NOT the
  // decision rule any more.
  const foldDifferences = run.summary[
    SHIPPED_PREDICTOR
  ].perFoldTotalPinballLoss.map(
    (value, index) =>
      value - noWindowRun.summary[SHIPPED_PREDICTOR].perFoldTotalPinballLoss[index],
  );
  const foldStandardError =
    standardDeviation(foldDifferences) / Math.sqrt(foldDifferences.length);
  return {
    windowDays: run.windowDays,
    ...bootstrap,
    adopt: bootstrap.ciUpper < 0,
    legacyFoldMeanDifference: mean(foldDifferences),
    legacyFoldStandardError: foldStandardError,
    legacyFoldT:
      foldStandardError === 0 ? 0 : mean(foldDifferences) / foldStandardError,
  };
}

// A window is adopted only if the upper end of the 95% CI on the per-call mean
// difference is strictly below zero. Repo rule: a change replaces the previous
// predictor only if it BEATS it on held-out data — and "the point estimate came
// out negative" is not a win, it is a coin flip that also throws away training
// data.
const windowComparisons = windowSweep.map(pairedImprovement);
const adoptable = windowComparisons
  .filter((comparison) => comparison.windowDays !== null)
  .filter((comparison) => comparison.adopt)
  .sort((left, right) => left.meanDifference - right.meanDifference);
const selectedWindowDays = adoptable[0]?.windowDays ?? null;

/**
 * Compare a candidate predictor against the shipped one, fold by fold.
 *
 * Same pairing argument as pairedImprovement(): folds differ from each other by
 * far more than any candidate differs from the baseline, and the folds are
 * identical between the two predictors, so the per-fold difference is the only
 * comparison with a usable error bar.
 */
const selectedWindowRun =
  windowSweep.find((run) => run.windowDays === selectedWindowDays) ?? noWindowRun;

function pairedAgainst(
  candidateName,
  baselineName = SHIPPED_PREDICTOR,
  run = selectedWindowRun,
) {
  const baseline = run.perCall[baselineName];
  const differences = run.perCall[candidateName].map(
    (value, index) => value - baseline[index],
  );
  const bootstrap = blockBootstrapDifference(differences, run.perCallSessions);
  const foldDifferences = run.summary[
    candidateName
  ].perFoldTotalPinballLoss.map(
    (value, index) =>
      value - run.summary[baselineName].perFoldTotalPinballLoss[index],
  );
  const foldStandardError =
    standardDeviation(foldDifferences) / Math.sqrt(foldDifferences.length);
  return {
    predictor: candidateName,
    baseline: baselineName,
    windowDays: run.windowDays,
    ...bootstrap,
    adopt: bootstrap.ciUpper < 0,
    legacyFoldMeanDifference: mean(foldDifferences),
    legacyFoldStandardError: foldStandardError,
    legacyFoldT:
      foldStandardError === 0 ? 0 : mean(foldDifferences) / foldStandardError,
  };
}

const PROMPT_PATH_ADOPTABLE = "historicalModelThinkingPromptPath";
const promptPathComparison = pairedAgainst(PROMPT_PATH_ADOPTABLE);
const promptPathAdopted = promptPathComparison.adopt
  ? promptPathComparison
  : null;
const activeBaselinePredictor =
  promptPathAdopted?.predictor ?? SHIPPED_PREDICTOR;

// Image presence is graded against whatever the prompt-path gate left as the
// active baseline, so the two prompt-derived rungs never double-claim the
// same improvement.
const PROMPT_IMAGE_ADOPTABLE = "historicalModelThinkingPromptImage";
const promptImageComparison = pairedAgainst(
  PROMPT_IMAGE_ADOPTABLE,
  activeBaselinePredictor,
);
const promptImageAdopted = promptImageComparison.adopt
  ? promptImageComparison
  : null;

// Only the 4-bucket ladder is ADOPTABLE. The merged variant is measured and
// reported, never shipped, and that is a correctness constraint rather than a
// preference: `previousOutputBucket()` in packages/predictor is the single
// definition the forecaster routes requests through, and it has no merged mode.
// A merged profile would fit every `<200` call into the `200-800` group and
// then never select that group for one — 21.5% of the calls that have a
// predecessor, silently mis-routed, delivering none of the measured gain.
//
// Repo rule 7 (prefer the simpler ladder when tied) can only be applied once
// both sides can express the same bucketing. Until then the merged column is a
// diagnostic: if it ever clearly beats the 4-bucket ladder, teach
// previousOutputBucket() the merge FIRST, then make it adoptable here.
const PREV_OUTPUT_ADOPTABLE =
  promptPathAdopted === null
    ? "historicalModelThinkingPrevOutput"
    : "historicalModelThinkingPromptPathPrevOutput";
const PREV_OUTPUT_DIAGNOSTIC =
  promptPathAdopted === null
    ? "historicalModelThinkingPrevOutputMerged"
    : "historicalModelThinkingPromptPathPrevOutputMerged";
const prevOutputComparisons = [
  PREV_OUTPUT_ADOPTABLE,
  PREV_OUTPUT_DIAGNOSTIC,
].map((name) => ({
  ...pairedAgainst(name, activeBaselinePredictor),
  adoptable: name === PREV_OUTPUT_ADOPTABLE,
}));
const prevOutputAdopted =
  prevOutputComparisons.find(
    (comparison) => comparison.adoptable && comparison.adopt,
  ) ?? null;
const prevOutputBucketOf = previousOutputBucket;

/**
 * Cold-start fallback gate: pooled `thinking=yes|no` groups for callers whose
 * model the profile has never seen (`usedFallback: true`).
 *
 * The predictor's ladder has carried a ["thinking"] rung since June, but no
 * profile ever materialized those groups, so an unknown-model caller got the
 * blended `overall` numbers even when it declared its thinking flag — the
 * strongest pre-call signal in the corpus. The honest simulation of that
 * caller is leave-one-model-out: refit with model M excluded from training,
 * then score M's holdout calls through the fallback path. Adoption follows
 * the same rule as everything else: paired session-block bootstrap on
 * per-call total pinball, CI upper strictly below zero.
 * (First measured 9 August 2026, experiments/evaluation/probe-cold-start.mjs:
 * −54.9/call, CI [−68.2, −39.9]. This gate re-tests it every regeneration.)
 */
const THINKING_POOLED_TIER = ["thinking"];
function lomoThinkingComparison() {
  const differences = [];
  const sessionIds = [];
  const tally = {
    overall: { loss: 0, covered: [0, 0, 0] },
    thinkingPooled: { loss: 0, covered: [0, 0, 0] },
    calls: 0,
  };
  for (const { train: trainRows, holdout: holdoutRows } of cvFoldSlices) {
    const models = new Set(holdoutRows.map((row) => row.model));
    for (const excluded of models) {
      const trainWithout = trainRows.filter((row) => row.model !== excluded);
      if (trainWithout.length < minGroupSamples) continue;
      const overallFit = fitQuantiles(trainWithout);
      const thinkingFits = fitGroups(trainWithout, (row) =>
        row.thinking ? "yes" : "no",
      );
      for (const row of holdoutRows) {
        if (row.model !== excluded) continue;
        const pooled =
          thinkingFits.get(row.thinking ? "yes" : "no") ?? overallFit;
        let overallLoss = 0;
        let pooledLoss = 0;
        for (const [index, probability] of QUANTILES.entries()) {
          const name = `p${probability * 100}`;
          const overallDiff = row.outputTokens - overallFit[name];
          const pooledDiff = row.outputTokens - pooled[name];
          overallLoss +=
            overallDiff >= 0
              ? probability * overallDiff
              : (probability - 1) * overallDiff;
          pooledLoss +=
            pooledDiff >= 0
              ? probability * pooledDiff
              : (probability - 1) * pooledDiff;
          tally.overall.covered[index] += row.outputTokens <= overallFit[name];
          tally.thinkingPooled.covered[index] += row.outputTokens <= pooled[name];
        }
        tally.overall.loss += overallLoss;
        tally.thinkingPooled.loss += pooledLoss;
        tally.calls++;
        differences.push(pooledLoss - overallLoss);
        sessionIds.push(row.sessionId ?? null);
      }
    }
  }
  const bootstrap = blockBootstrapDifference(differences, sessionIds);
  const summarizeSide = (side) => ({
    meanTotalPinballLoss: tally.calls === 0 ? null : side.loss / tally.calls,
    coverage: side.covered.map((count) =>
      tally.calls === 0 ? null : count / tally.calls,
    ),
  });
  return {
    lomoCalls: tally.calls,
    overall: summarizeSide(tally.overall),
    thinkingPooled: summarizeSide(tally.thinkingPooled),
    ...bootstrap,
    adopt: bootstrap.ciUpper < 0 && tally.calls > 0,
  };
}
const thinkingPooledComparison = lomoThinkingComparison();
const thinkingPooledAdopted = thinkingPooledComparison.adopt
  ? thinkingPooledComparison
  : null;

const DEPLOYMENT_TIERS = [
  ...BASE_DEPLOYMENT_TIERS,
  ...(promptPathAdopted === null ? [] : PROMPT_PATH_TIERS),
  ...(promptImageAdopted === null ? [] : PROMPT_IMAGE_TIERS),
  ...(prevOutputAdopted === null ? [] : [PREV_OUTPUT_TIER]),
  ...(thinkingPooledAdopted === null ? [] : [THINKING_POOLED_TIER]),
];

// Mirrors historicalGroupKey() in packages/predictor/src/historical.ts. A
// dimension that returns null is unknown for that row, and historicalGroupKey
// returns null for the whole tier in that case — so the row contributes to no
// group at that tier rather than to a fabricated "unknown" level.
const DIMENSION_VALUE = {
  model: (row) => row.model,
  thinking: (row) => (row.thinking ? "yes" : "no"),
  promptPath: (row) =>
    row.promptMentionsPath === undefined
      ? null
      : row.promptMentionsPath
        ? "yes"
        : "no",
  prevOutput: (row) => prevOutputBucketOf(row.previousOutputTokens),
  promptImage: (row) =>
    row.promptHasImage === undefined
      ? null
      : row.promptHasImage
        ? "yes"
        : "no",
};
function deploymentGroupKey(tier, row) {
  const parts = [];
  for (const dimension of tier) {
    const value = DIMENSION_VALUE[dimension](row);
    if (value === null) return null;
    parts.push(`${dimension}=${encodeURIComponent(value)}`);
  }
  return parts.join("|");
}

// The shipped profile is fitted on the same recency window the CV selected, so
// what ships matches what was measured.
const deploymentRows = applyWindow(timedEligible, selectedWindowDays);

// Only groups that clear minGroupSamples are shipped. Smaller groups would be
// skipped by the forecaster's own threshold anyway, so shipping them just puts
// unusable noise in a published artifact.
const deploymentGroups = { overall: fitQuantiles(deploymentRows) };
for (const tier of DEPLOYMENT_TIERS) {
  const grouped = new Map();
  for (const row of deploymentRows) {
    const key = deploymentGroupKey(tier, row);
    if (key === null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const [key, rows] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (rows.length >= minGroupSamples) deploymentGroups[key] = fitQuantiles(rows);
  }
}

/**
 * Model aliases, generated from the registry rather than hand-written.
 *
 * The profile is keyed on whatever model string the transcripts recorded. A
 * caller may hold either the canonical id or the dated snapshot, so map
 * whichever form is absent from the profile onto the form that is present. A
 * missing alias is not a loud failure — it silently drops the request to the
 * blended `overall` group — which is exactly why this is derived, not typed by
 * hand.
 */
const shippedModels = new Set(
  Object.keys(deploymentGroups)
    .filter((key) => key.startsWith("model="))
    .map((key) => decodeURIComponent(key.split("|")[0].slice("model=".length))),
);
const modelAliases = {};
for (const { id, snapshot } of listModelIdAliases()) {
  if (shippedModels.has(snapshot) && !shippedModels.has(id)) {
    modelAliases[id] = snapshot;
  } else if (shippedModels.has(id) && !shippedModels.has(snapshot)) {
    modelAliases[snapshot] = id;
  }
}

// Whole-turn output totals (STATE-OF-PLAY §6.25). Fitted per TURN, keyed by
// the turn-opening call's thinking flag plus `overall`. No finer slicing: at
// ~1,100 turns every conditioning candidate failed endpoint stability in
// probe-turn-totals.mjs, so only the coarse, calibration-checked groups ship.
const MIN_TURN_GROUP = 60;
const turnAccumulator = new Map();
// Sessions with a call outside any turn cannot report an honest total; one
// missing turn poisons the sum (STATE-OF-PLAY §6.26).
const orphanSessions = new Set();
for (const row of loopContext.rows) {
  if (!Number.isFinite(row.timestampMs) || !Number.isFinite(row.outputTokens)) continue;
  if (row.turnRootId === null) {
    if (row.sessionId != null) orphanSessions.add(row.sessionId);
    continue;
  }
  let turn = turnAccumulator.get(row.turnRootId);
  if (!turn) {
    turn = {
      total: 0,
      exact: true,
      firstMs: Infinity,
      openerThinking: false,
      sessionId: row.sessionId ?? null,
    };
    turnAccumulator.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  if (!row.loopDepthExact) turn.exact = false;
  if (row.timestampMs < turn.firstMs) {
    turn.firstMs = row.timestampMs;
    turn.openerThinking = [...row.blockTypes].some((type) =>
      THINKING_BLOCK_TYPES.has(type),
    );
  }
}
const turnRecords = [...turnAccumulator.values()].filter((turn) => turn.exact);
const fitTurnGroup = (turns) => {
  const sorted = turns.map((turn) => turn.total).sort((left, right) => left - right);
  const at = (probability) => {
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
  };
  return { sampleSize: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
};
const turnTotals = {};
if (turnRecords.length >= MIN_TURN_GROUP) {
  turnTotals.overall = fitTurnGroup(turnRecords);
  for (const flag of [true, false]) {
    const subset = turnRecords.filter((turn) => turn.openerThinking === flag);
    if (subset.length >= MIN_TURN_GROUP) {
      turnTotals[`thinking=${flag ? "yes" : "no"}`] = fitTurnGroup(subset);
    }
  }
}

// Whole-session output totals (STATE-OF-PLAY §6.26). Unconditional on
// purpose: at ~300 sessions no conditional forecast (turn-count buckets,
// spent-so-far buckets, turns×median) separated from these quantiles at 95%
// with endpoint stability — probe-session-totals.mjs. A session counts only
// when every turn in it has exact ancestry and no call fell outside a turn.
const MIN_SESSION_GROUP = 60;
const sessionAccumulator = new Map();
for (const turn of turnAccumulator.values()) {
  if (turn.sessionId === null || orphanSessions.has(turn.sessionId)) continue;
  let session = sessionAccumulator.get(turn.sessionId);
  if (!session) {
    session = { total: 0, exact: true };
    sessionAccumulator.set(turn.sessionId, session);
  }
  session.total += turn.total;
  if (!turn.exact) session.exact = false;
}
const sessionRecords = [...sessionAccumulator.values()].filter(
  (session) => session.exact,
);
const sessionTotals = {};
if (sessionRecords.length >= MIN_SESSION_GROUP) {
  sessionTotals.overall = fitTurnGroup(sessionRecords);
}

const deploymentProfile = {
  id: `claude-code-local-${generatedAt.slice(0, 10)}`,
  generatedAt,
  scope: "Local Claude Code output tokens per API call",
  // One person's ~/.claude is the whole corpus, so every quantile and every
  // trained tree below is a prior for this kind of work, not a calibration of
  // whoever consumes it. Consumers render the caveat off this field instead of
  // matching on a profile id (docs/MULTI-USER-PLAN.md).
  provenance: "single-user-corpus",
  eligibleObservations: deploymentRows.length,
  windowDays: selectedWindowDays,
  modelAliases,
  groups: deploymentGroups,
  ...(Object.keys(turnTotals).length === 0 ? {} : { turnTotals }),
  ...(Object.keys(sessionTotals).length === 0 ? {} : { sessionTotals }),
};

const report = {
  generatedAt,
  source: projectsDir,
  filesScanned,
  badLines,
  baseline: STATIC_BASELINE,
  dataset: {
    assistantRows,
    uniqueApiCalls: observations.length,
    duplicateRows,
    varyingDuplicateRows,
    transcriptCopies: observations.filter((row) => row.transcriptCopies > 1).length,
    eligibleUncensoredCalls: eligible.length,
    censoredCalls: observations.length - eligible.length,
    untimedEligibleCalls: eligible.length - timedEligible.length,
    // How often the previous-output feature is even available. The remainder
    // are turn-opening calls and calls whose ancestry is missing from the
    // transcript; both skip the rung.
    callsWithPreviousOutput: observations.filter(
      (row) => row.previousOutputTokens !== undefined,
    ).length,
    callsWithPromptPath: observations.filter(
      (row) => row.promptMentionsPath !== undefined,
    ).length,
    callsWithPromptImage: observations.filter(
      (row) => row.promptHasImage !== undefined,
    ).length,
    loopContextFilesScanned: loopContext.filesScanned,
  },
  // Backward-compatible descriptive fields used by the original artifact.
  overall: { ...summarize(observations), histogram: histogram(observations) },
  byModel: Object.fromEntries(
    Object.entries(groupedSummaries(observations, (row) => row.model)).map(
      ([model, summary]) => [
        model,
        {
          ...summary,
          histogram: histogram(observations.filter((row) => row.model === model)),
        },
      ],
    ),
  ),
  eligibleOverall: summarize(eligible),
  segments: {
    byThinking: groupedSummaries(observations, (row) =>
      row.thinking ? "thinking" : "no-thinking",
    ),
    byThinkingAndStopReason: groupedSummaries(
      observations,
      (row) => `${row.thinking ? "thinking" : "no-thinking"}|${row.stopReason}`,
    ),
    byStopReason: groupedSummaries(observations, (row) => row.stopReason),
    bySidechain: groupedSummaries(observations, (row) => String(row.sidechain)),
    byInputBucket: groupedSummaries(eligible, (row) => inputBucket(row.inputTokens)),
    byPreviousOutputBucket: groupedSummaries(
      eligible,
      (row) => previousOutputBucket(row.previousOutputTokens) ?? "unknown",
    ),
  },
  chronologicalHoldout: {
    trainFraction,
    minGroupSamples,
    trainCalls: train.length,
    holdoutCalls: holdout.length,
    trainThrough: new Date(train[train.length - 1].timestampMs).toISOString(),
    holdoutFrom: new Date(holdout[0].timestampMs).toISOString(),
    trainQuantiles: fitQuantiles(train),
    holdoutQuantiles: fitQuantiles(holdout),
    evaluation: Object.fromEntries(
      Object.entries(singleSplitPredictors).map(([name, predictor]) => [
        name,
        evaluate(predictor, holdout),
      ]),
    ),
  },
  rollingOriginCv: {
    folds: cvFolds,
    seedTrainFraction: trainFraction,
    minGroupSamples,
    shippedPredictor: SHIPPED_PREDICTOR,
    selectedWindowDays,
    // Adoption is decided by a paired block bootstrap over per-call losses
    // (ciUpper < 0), not by the 5-fold t. Every comparison also carries its
    // legacyFold* fields so results published before 4 August 2026 stay
    // comparable — those are documentation, not the decision rule.
    adoptionRule: "paired block bootstrap over per-call losses; adopt if ciUpper < 0",
    bootstrapResamples: BOOTSTRAP_RESAMPLES,
    bootstrapSeed: BOOTSTRAP_SEED,
    // Paired per-fold comparison of each window against the full history.
    windowComparisons,
    // The ancestry fix makes this the first prompt-derived feature to clear the
    // same held-out gate used by every other candidate.
    promptPathComparison,
    adoptedPromptPathPredictor: promptPathAdopted?.predictor ?? null,
    // Turn-root image attachment, graded against the active baseline.
    promptImageComparison,
    adoptedPromptImagePredictor: promptImageAdopted?.predictor ?? null,
    // Paired comparison of each previous-output ladder against the shipped
    // predictor, at the selected window.
    prevOutputComparisons,
    adoptedPrevOutputPredictor: prevOutputAdopted?.predictor ?? null,
    // Cold-start fallback tier: leave-one-model-out comparison of the pooled
    // thinking rung against the `overall` blend, re-run every regeneration.
    coldStartFallback: thinkingPooledComparison,
    adoptedThinkingPooledTier: thinkingPooledAdopted === null ? null : "thinking",
    activeBaselinePredictor,
    // One entry per swept recency window; each carries per-fold detail plus a
    // mean/spread summary per predictor.
    windowSweep,
  },
  deploymentProfile,
};

await mkdir(path.dirname(outFile), { recursive: true });
await mkdir(path.dirname(profileFile), { recursive: true });
await mkdir(path.dirname(bundledProfileFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(profileFile, `${JSON.stringify(deploymentProfile, null, 2)}\n`);
await writeFile(
  bundledProfileFile,
  `import type { HistoricalForecastProfile } from "./historical.js";\n\n/**\n * Generated by experiments/evaluation/eval-claude-code-history.mjs.\n * Privacy-safe aggregates only; no transcript or prompt content.\n * Scope: output tokens per Claude Code API call, not a full agent task.\n */\nexport const BUNDLED_CLAUDE_CODE_PROFILE: HistoricalForecastProfile = ${JSON.stringify(deploymentProfile, null, 2)};\n`,
);

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const format = (value) => Math.round(value).toLocaleString("en-US");
console.log(
  `Scanned ${filesScanned} transcripts: ${observations.length} unique API calls, ${eligible.length} uncensored`,
);
console.log(
  `Chronological split: ${train.length} train through ${report.chronologicalHoldout.trainThrough}, ${holdout.length} holdout`,
);
console.log(
  `Holdout actual: p50=${format(report.chronologicalHoldout.holdoutQuantiles.p50)} p90=${format(report.chronologicalHoldout.holdoutQuantiles.p90)} p99=${format(report.chronologicalHoldout.holdoutQuantiles.p99)}`,
);
for (const [name, evaluation] of Object.entries(
  report.chronologicalHoldout.evaluation,
)) {
  console.log(
    `${name.padEnd(28)} coverage p50=${percent(evaluation.p50.empiricalCoverage)} p90=${percent(evaluation.p90.empiricalCoverage)} p99=${percent(evaluation.p99.empiricalCoverage)} | pinball ${format(evaluation.p50.pinballLoss)} / ${format(evaluation.p90.pinballLoss)} / ${format(evaluation.p99.pinballLoss)} = ${format(evaluation.totalPinballLoss)}`,
  );
}

const windowLabel = (days) => (days === null ? "all" : `${days}d`);
console.log(
  `\nRolling-origin CV: ${cvFolds} folds, seed train fraction ${trainFraction}`,
);
console.log(
  `  fold holdout sizes: ${cvFoldSlices.map((fold) => fold.holdout.length).join(", ")}`,
);
for (const run of windowSweep) {
  console.log(`\n  window=${windowLabel(run.windowDays)}`);
  for (const name of PREDICTOR_NAMES) {
    const stats = run.summary[name];
    console.log(
      `    ${name.padEnd(28)} total pinball ${format(stats.meanTotalPinballLoss)} +/- ${format(stats.stdDevTotalPinballLoss)} (${format(stats.minTotalPinballLoss)}..${format(stats.maxTotalPinballLoss)}) | p90 coverage ${percent(stats.meanCoverageP90)}`,
    );
  }
}
const ci = (c) =>
  `diff ${c.meanDifference.toFixed(2)}/call, 95% CI [${c.ciLower.toFixed(2)}, ${c.ciUpper.toFixed(2)}]`;
const legacy = (c) =>
  `(5-fold t was ${c.legacyFoldT.toFixed(2)})`;

console.log(
  `\nWindow vs full history (${SHIPPED_PREDICTOR}, negative = window wins).` +
    `\n  Paired block bootstrap over ${windowComparisons[0]?.n ?? 0} held-out calls, ` +
    `${windowComparisons[0]?.blocks ?? 0} ${windowComparisons[0]?.blockKind ?? ""} blocks, ` +
    `${BOOTSTRAP_RESAMPLES} resamples, seed fixed. Adopt if CI upper < 0:`,
);
for (const comparison of windowComparisons) {
  if (comparison.windowDays === null) continue;
  console.log(
    `  ${windowLabel(comparison.windowDays).padEnd(5)} ${ci(comparison)} ${legacy(comparison)}` +
      `${comparison.adopt ? "  <- adoptable" : ""}`,
  );
}
console.log(
  `Selected recency window for the shipped profile: ${windowLabel(selectedWindowDays)}`,
);

console.log(
  `\nPrompt-path ladder vs ${SHIPPED_PREDICTOR} at window=` +
    `${windowLabel(selectedWindowDays)} (negative = the candidate wins):`,
);
console.log(
  `  feature available on ${report.dataset.callsWithPromptPath} of ` +
    `${observations.length} calls (${percent(report.dataset.callsWithPromptPath / observations.length)}); ` +
    `the rest skip the rung`,
);
console.log(`  ${ci(promptPathComparison)} ${legacy(promptPathComparison)}`);
console.log(
  promptPathAdopted === null
    ? `  NOT ADOPTED — the 95% CI includes 0.`
    : `  ADOPTED: ${promptPathAdopted.predictor}, CI upper ${promptPathAdopted.ciUpper.toFixed(2)} < 0.`,
);

console.log(
  `\nPrompt-image ladder vs ${activeBaselinePredictor} at window=` +
    `${windowLabel(selectedWindowDays)} (negative = the candidate wins):`,
);
console.log(
  `  feature available on ${report.dataset.callsWithPromptImage} of ` +
    `${observations.length} calls (${percent(report.dataset.callsWithPromptImage / observations.length)}); ` +
    `the rest skip the rung`,
);
console.log(`  ${ci(promptImageComparison)} ${legacy(promptImageComparison)}`);
console.log(
  promptImageAdopted === null
    ? `  NOT ADOPTED — the 95% CI includes 0.`
    : `  ADOPTED: ${promptImageAdopted.predictor}, CI upper ${promptImageAdopted.ciUpper.toFixed(2)} < 0.`,
);

console.log(
  `\nPrevious-output ladder vs ${activeBaselinePredictor} at window=` +
    `${windowLabel(selectedWindowDays)} (negative = the candidate wins):`,
);
console.log(
  `  feature available on ${report.dataset.callsWithPreviousOutput} of ` +
    `${observations.length} calls (${percent(report.dataset.callsWithPreviousOutput / observations.length)}); ` +
    `the rest skip the rung`,
);
for (const comparison of prevOutputComparisons) {
  console.log(
    `  ${comparison.predictor.replace("historicalModelThinking", "").padEnd(18)} ` +
      `${ci(comparison)} ${legacy(comparison)}` +
      `${!comparison.adoptable ? "  (diagnostic only — the predictor cannot express this bucketing)" : comparison.adopt ? "  <- adoptable" : ""}`,
  );
}
console.log(
  prevOutputAdopted === null
    ? `  NOT ADOPTED — the 95% CI includes 0.`
    : `  ADOPTED: ${prevOutputAdopted.predictor}, CI upper ${prevOutputAdopted.ciUpper.toFixed(2)} < 0. ` +
      `The profile ships the ${PREV_OUTPUT_TIER.join("+")} tier.`,
);

console.log(
  `\nCold-start fallback (leave-one-model-out, ${thinkingPooledComparison.lomoCalls} calls): ` +
    `pooled thinking rung vs overall blend`,
);
console.log(
  `  overall blend    loss ${format(thinkingPooledComparison.overall.meanTotalPinballLoss ?? 0)}/call, ` +
    `coverage ${thinkingPooledComparison.overall.coverage.map((value) => percent(value ?? 0)).join("/")}`,
);
console.log(
  `  pooled thinking  loss ${format(thinkingPooledComparison.thinkingPooled.meanTotalPinballLoss ?? 0)}/call, ` +
    `coverage ${thinkingPooledComparison.thinkingPooled.coverage.map((value) => percent(value ?? 0)).join("/")}`,
);
console.log(`  ${ci(thinkingPooledComparison)}`);
console.log(
  thinkingPooledAdopted === null
    ? `  NOT ADOPTED — the 95% CI includes 0; the profile ships no pooled thinking groups.`
    : `  ADOPTED: the profile ships the pooled ${THINKING_POOLED_TIER.join("+")} tier, CI upper ` +
      `${thinkingPooledAdopted.ciUpper.toFixed(2)} < 0.`,
);
console.log(
  `Shipped profile: ${deploymentRows.length} calls, ${Object.keys(deploymentGroups).length} groups, ` +
    `aliases ${JSON.stringify(modelAliases)}`,
);
for (const [key, group] of Object.entries(turnTotals)) {
  console.log(
    `Turn totals ${key}: n=${group.sampleSize} p50=${group.p50} p90=${group.p90} p99=${group.p99}`,
  );
}
for (const [key, group] of Object.entries(sessionTotals)) {
  console.log(
    `Session totals ${key}: n=${group.sampleSize} p50=${group.p50} p90=${group.p90} p99=${group.p99}`,
  );
}
console.log(`Wrote ${outFile}`);
console.log(`Wrote ${profileFile}`);
console.log(`Wrote ${bundledProfileFile}`);

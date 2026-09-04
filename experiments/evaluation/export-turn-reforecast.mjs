#!/usr/bin/env node
/**
 * LOCAL-ONLY exporter for the re-forecast-as-you-go turn-total probe
 * (docs/REFORECAST-PLAN.md).
 *
 * Writes one JSONL row per (EXACT turn, k) for k in {0, 1, 2, 3, 5}, k=0
 * standing for "no calls have completed yet" (one row per turn, used to fit
 * the pre-call control on turns rather than on (turn, k) rows) and k in
 * {1, 2, 3, 5} emitted only when the turn has more than k calls -- exactly
 * the population the status line would still be forecasting for at that
 * point in the loop.
 *
 * The row holds NUMBERS ONLY except for turnRootId, sessionId, workloadId,
 * model and thinking, asserted below before anything is written. Population
 * is identical to export-turn-context.mjs: every exact turn (loader
 * `loopDepthExact`), calls inside a turn ordered by timestamp.
 *
 * The turn assembly and the "second pass over the raw transcripts for a
 * tool_use input size the loader does not keep" pattern are both reused from
 * export-turn-context.mjs verbatim (that file is not edited); this file
 * additionally needs the largest tool_use input PER CALL (not per turn), so
 * the running max at k can be formed as calls complete.
 *
 *   node experiments/evaluation/export-turn-reforecast.mjs --out /tmp/.../reforecast.jsonl
 */
import { createReadStream, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { portableBoostFeatures } from "./lib/quantile-boost.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const out = argValue("--out");
if (!out) throw new Error("--out is required (use the scratchpad)");
const repoRoot = path.resolve(process.cwd());
if (path.resolve(out).startsWith(repoRoot + path.sep)) {
  throw new Error(`refusing to write a per-turn export inside the repository: ${out}`);
}
const columnsOut = argValue("--columns-out");
if (columnsOut && path.resolve(columnsOut).startsWith(repoRoot + path.sep)) {
  throw new Error(`refusing to write a columns side file inside the repository: ${columnsOut}`);
}

const log = (message) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ---------------------------------------------------------------------------
// Column layout, K (legal at k completed calls) and O (post-hoc oracle,
// never shippable). Names are written to the columns side file so the probe
// can label the arms, mirroring export-turn-context.mjs's S_COLUMNS/R_COLUMNS.
// ---------------------------------------------------------------------------

const K_COLUMNS = [
  "k_calls", // log1p(k) / 4
  "k_outputSoFar", // log1p(sum of output tokens of calls 1..k) / 12
  "k_maxOutputSoFar", // log1p(max output tokens over calls 1..k) / 12
  "k_lastOutput", // log1p(output tokens of call k) / 12 (the S7.1 feature)
  "k_maxToolInput", // log1p(largest single tool_use input in chars over calls 1..k) / 10
  "k_anyWrite", // 1 if any call 1..k carried a Write tool_use
  "k_anyMutation", // 1 if any call 1..k carried Write, Edit, MultiEdit or NotebookEdit
];

const O_COLUMNS = [
  "o_calls", // log1p(final calls in the turn) / 4
  "o_maxToolInput", // log1p(final largest single tool_use input in chars) / 10
];

const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const K_STEPS = [1, 2, 3, 5];

// ---------------------------------------------------------------------------
// Load. Same options as export-turn-context.mjs, minus withResolvedFileContext
// and withPromptText: this probe uses none of the R-family path/prompt-text
// machinery, only the 38 v3 columns (which need withPromptFeatures for
// turnPrompt/promptPath/turnHasImage) and the loop-context turnRootId.
// ---------------------------------------------------------------------------

log("loading transcripts (loop context + prompt features)");
const t0 = Date.now();
const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
});
log(`loaded ${loaded.length} calls from ${filesScanned} files in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0,
);

// sessionPosition, exactly as export-turn-context.mjs computes it (feature 7
// of the 38-column vector is derived from it).
const sessions = new Map();
for (const row of rows) {
  const key = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  sessions.get(key).push(row);
}
for (const list of sessions.values()) {
  list.sort((a, b) => a.timestampMs - b.timestampMs);
  list.forEach((row, index) => {
    row.sessionPosition = index;
  });
}

const turns = new Map();
for (const row of rows) {
  if (row.turnRootId === null) continue;
  let turn = turns.get(row.turnRootId);
  if (!turn) {
    turn = {
      turnRootId: row.turnRootId,
      sessionId: row.sessionId ?? null,
      workloadId: row.workloadId ?? null,
      total: 0,
      calls: 0,
      exact: true,
      firstMs: Infinity,
      opener: null,
      requestIds: new Set(),
      callRows: [],
    };
    turns.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  turn.calls++;
  if (!row.loopDepthExact) turn.exact = false;
  turn.requestIds.add(row.requestId);
  turn.callRows.push(row);
  if (row.timestampMs < turn.firstMs) {
    turn.firstMs = row.timestampMs;
    turn.opener = row;
  }
}
const exactTurns = [...turns.values()]
  .filter((turn) => turn.exact)
  .sort((a, b) => a.firstMs - b.firstMs);
log(`${exactTurns.length} exact turns of ${turns.size} turns total`);

// Order each turn's calls by timestamp, as the status line sees them.
for (const turn of exactTurns) {
  turn.callRows.sort((a, b) => a.timestampMs - b.timestampMs);
}

// ---------------------------------------------------------------------------
// Second scan: per-CALL largest single tool_use input, in characters. The
// loader keeps only a per-call total (`toolChars`), not the size of the
// largest individual block, and export-turn-context.mjs's second pass
// computes that max per TURN, not per call, so it cannot be reused as-is.
// Same scan shape, keyed by requestId instead of turnRootId.
// ---------------------------------------------------------------------------

const neededRequestIds = new Set();
for (const turn of exactTurns) {
  for (const requestId of turn.requestIds) neededRequestIds.add(requestId);
}
const maxToolInputByCall = new Map(); // requestId -> chars

async function* jsonlFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

log("second pass: per-call largest tool_use input");
const t1 = Date.now();
let scanned = 0;
for await (const file of jsonlFiles(projectsDir)) {
  scanned++;
  const lines = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    if (!line.includes('"assistant"') || !line.includes("output_tokens")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !entry.requestId) continue;
    if (!neededRequestIds.has(entry.requestId)) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    let biggest = maxToolInputByCall.get(entry.requestId) ?? 0;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const size = JSON.stringify(block.input ?? {}).length;
      if (size > biggest) biggest = size;
    }
    maxToolInputByCall.set(entry.requestId, biggest);
  }
}
log(`second pass over ${scanned} files in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// ---------------------------------------------------------------------------
// Per-turn prefix aggregates over the ordered call list, so the K family and
// the legality assertion can be read off directly at any k.
// ---------------------------------------------------------------------------

for (const turn of exactTurns) {
  let cumOutput = 0;
  let cumMaxOutput = 0;
  let cumMaxToolInput = 0;
  let cumAnyWrite = false;
  let cumAnyMutation = false;
  const prefixes = [
    {
      k: 0,
      outputSoFar: 0,
      maxOutputSoFar: 0,
      lastOutput: 0,
      maxToolInput: 0,
      anyWrite: false,
      anyMutation: false,
    },
  ];
  turn.callRows.forEach((row, index) => {
    const output = row.outputTokens;
    const toolInput = maxToolInputByCall.get(row.requestId) ?? 0;
    const tools = row.tools ?? [];
    cumOutput += output;
    cumMaxOutput = Math.max(cumMaxOutput, output);
    cumMaxToolInput = Math.max(cumMaxToolInput, toolInput);
    if (tools.includes("Write")) cumAnyWrite = true;
    if (tools.some((tool) => MUTATING_TOOLS.has(tool))) cumAnyMutation = true;
    prefixes.push({
      k: index + 1,
      outputSoFar: cumOutput,
      maxOutputSoFar: cumMaxOutput,
      lastOutput: output,
      maxToolInput: cumMaxToolInput,
      anyWrite: cumAnyWrite,
      anyMutation: cumAnyMutation,
    });
  });
  turn.prefixes = prefixes; // index i = state after i calls have completed
  turn.oracle = {
    calls: turn.calls,
    maxToolInput: cumMaxToolInput,
  };
}

// ---------------------------------------------------------------------------
// Write. One row per turn at k=0, plus one row per (turn, k) for k in
// {1,2,3,5} where the turn has more than k calls.
// ---------------------------------------------------------------------------

const NON_NUMERIC_FIELDS = new Set(["turnRootId", "sessionId", "workloadId", "model", "thinking"]);

function assertNumbersOnly(rowObject) {
  for (const [key, value] of Object.entries(rowObject)) {
    if (NON_NUMERIC_FIELDS.has(key)) {
      if (value !== null && typeof value !== "string") {
        throw new Error(`expected string|null for ${key}, got ${typeof value}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "number") throw new Error(`non-numeric entry in ${key}: ${typeof item}`);
      }
      continue;
    }
    if (typeof value !== "number") {
      throw new Error(`expected a number for ${key}, got ${typeof value}`);
    }
  }
}

const lines = [];
let rowsAtK = { 0: 0, 1: 0, 2: 0, 3: 0, 5: 0 };

for (const turn of exactTurns) {
  const opener = turn.opener;
  const shaped = {
    model: opener.model,
    thinking: hasThinkingBlock(opener) ? "yes" : "no",
    turnPrompt: opener.turnPrompt,
    promptPath:
      opener.turnPrompt === null ? null : opener.turnPrompt.mentionsPath ? "yes" : "no",
    promptImage: opener.turnHasImage === null ? null : opener.turnHasImage ? "yes" : "no",
    sessionPosition: opener.sessionPosition ?? 0,
    loopDepth: 0,
    priorCalls: 0,
    priorMaxOutput: null,
    priorArtifactCount: null,
    priorWrite: null,
    priorArtifact: null,
  };
  const features = [...portableBoostFeatures(shaped)].slice(0, 38);
  const O = [
    Math.log1p(turn.oracle.calls) / 4,
    Math.log1p(turn.oracle.maxToolInput) / 10,
  ];

  const stepsForTurn = [0, ...K_STEPS.filter((k) => turn.calls > k)];
  for (const k of stepsForTurn) {
    const prefix = turn.prefixes[k];
    const K = [
      Math.log1p(k) / 4,
      Math.log1p(prefix.outputSoFar) / 12,
      Math.log1p(prefix.maxOutputSoFar) / 12,
      Math.log1p(prefix.lastOutput) / 12,
      Math.log1p(prefix.maxToolInput) / 10,
      prefix.anyWrite ? 1 : 0,
      prefix.anyMutation ? 1 : 0,
    ];

    // Legality: outputSoFar plus the outputs of the remaining calls must
    // reconstruct the turn's final total exactly.
    const remaining = turn.callRows.slice(k).reduce((sum, row) => sum + row.outputTokens, 0);
    if (prefix.outputSoFar + remaining !== turn.total) {
      throw new Error(
        `legality violated for turn ${turn.turnRootId} at k=${k}: ` +
          `${prefix.outputSoFar} + ${remaining} !== ${turn.total}`,
      );
    }

    const rowObject = {
      turnRootId: turn.turnRootId,
      sessionId: turn.sessionId,
      workloadId: turn.workloadId,
      firstMs: turn.firstMs,
      k,
      total: turn.total,
      calls: turn.calls,
      model: shaped.model,
      thinking: shaped.thinking,
      features,
      K,
      O,
      outputSoFar: prefix.outputSoFar,
    };
    assertNumbersOnly(rowObject);
    lines.push(JSON.stringify(rowObject));
    rowsAtK[k]++;
  }
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, lines.join("\n") + "\n");
if (columnsOut) {
  await mkdir(path.dirname(columnsOut), { recursive: true });
  await writeFile(
    columnsOut,
    JSON.stringify(
      {
        k: K_COLUMNS,
        o: O_COLUMNS,
        kSteps: K_STEPS,
        turns: exactTurns.length,
        rowsAtK,
      },
      null,
      1,
    ) + "\n",
  );
}
log(`wrote ${lines.length} rows (${exactTurns.length} exact turns) to ${out}`);
console.error(JSON.stringify({ turns: exactTurns.length, rowsAtK }, null, 1));

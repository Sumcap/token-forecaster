#!/usr/bin/env node
/**
 * LOCAL-ONLY exporter for the semantic turn-total probe.
 *
 * Writes one JSONL row per exact turn: the turn total, the opener's
 * metadata, the shipped portable feature vector, and the CLEANED TURN-ROOT
 * PROMPT TEXT. The output contains prompt text and must never be committed or
 * written under experiments/artifacts -- it defaults to the session
 * scratchpad and refuses any path inside the repository.
 *
 * Population is identical to probe-turn-total-boost.mjs so numbers compare.
 */
import { mkdir, writeFile } from "node:fs/promises";
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
  throw new Error(`refusing to write prompt text inside the repository: ${out}`);
}

const { rows: loaded } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withPromptText: true,
});
const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0,
);
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
}
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
const lines = [];
for (const turn of [...turns.values()].filter((t) => t.exact).sort((a, b) => a.firstMs - b.firstMs)) {
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
  lines.push(
    JSON.stringify({
      turnRootId: turn.turnRootId,
      sessionId: turn.sessionId,
      firstMs: turn.firstMs,
      total: turn.total,
      calls: turn.calls,
      openerTokens: opener.outputTokens,
      model: shaped.model,
      thinking: shaped.thinking,
      command: opener.turnCommand,
      features: [...portableBoostFeatures(shaped)],
      text: opener.turnPromptText,
    }),
  );
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} exact turns to ${out}`);

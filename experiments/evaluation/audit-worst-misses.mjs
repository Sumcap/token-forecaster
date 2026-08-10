#!/usr/bin/env node
/**
 * Local-only ancestry audit for the largest rolling-origin misses.
 *
 * No artifact is written. Raw turn-root text is hidden unless --show-raw is
 * explicitly passed, then redacted and truncated before terminal output.
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { pinball, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const showRaw = args.includes("--show-raw");
const limit = Number(argValue("--limit", "15"));
const QUANTILES = [0.5, 0.9, 0.99];
const MIN_GROUP = 100;

function fit(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return QUANTILES.map((probability) => Math.round(quantile(sorted, probability)));
}
function fitGroups(rows, keyFn) {
  const values = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null) continue;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(row.outputTokens);
  }
  return new Map(
    [...values.entries()]
      .filter(([, sample]) => sample.length >= MIN_GROUP)
      .map(([key, sample]) => [key, fit(sample)]),
  );
}
const mt = (row) => `m=${row.model}|t=${row.thinking}`;
const model = (row) => `m=${row.model}`;
const prompt = (row) => (row.promptPath === null ? null : `path=${row.promptPath}`);
const joint = (row) => {
  const value = prompt(row);
  return value === null ? null : `${mt(row)}|${value}`;
};
function shipped(train) {
  const jointFits = fitGroups(train, joint);
  const promptFits = fitGroups(train, prompt);
  const mtFits = fitGroups(train, mt);
  const modelFits = fitGroups(train, model);
  const overall = fit(train.map((row) => row.outputTokens));
  return (row) =>
    jointFits.get(joint(row)) ??
    promptFits.get(prompt(row)) ??
    mtFits.get(mt(row)) ??
    modelFits.get(model(row)) ??
    overall;
}

const { rows: loaded } = await loadRequests(projectsDir, { withPromptFeatures: true });
const rows = loaded
  .filter(
    (row) =>
      Number.isFinite(row.timestampMs) &&
      Number.isFinite(row.outputTokens) &&
      row.outputTokens >= 0,
  )
  .sort((left, right) => left.timestampMs - right.timestampMs);
const byId = new Map(rows.map((row) => [row.requestId, row]));
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath =
    row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
}
const seed = Math.floor(rows.length * 0.8);
const block = Math.floor((rows.length - seed) / 5);
const scored = [];
for (let fold = 0; fold < 5; fold++) {
  const start = seed + fold * block;
  const end = fold === 4 ? rows.length : start + block;
  const predict = shipped(rows.slice(0, start));
  for (const row of rows.slice(start, end)) {
    const forecast = predict(row);
    const loss = QUANTILES.reduce(
      (sum, probability, index) =>
        sum + pinball(row.outputTokens, forecast[index], probability),
      0,
    );
    scored.push({ row, forecast, loss });
  }
}
const worst = scored.sort((left, right) => right.loss - left.loss).slice(0, limit);
const rootIds = new Set(worst.map((entry) => entry.row.turnRootId).filter(Boolean));

async function* jsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}
function userText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  return text.length ? text.join("\n") : null;
}
function redact(text) {
  if (!text) return "(no human text)";
  return text
    .replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, " ")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+\S+)\b/gi, "[REDACTED]")
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, "[REDACTED-HIGH-ENTROPY]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const rawByRoot = new Map();
if (showRaw) {
  for await (const file of jsonlFiles(projectsDir)) {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (![...rootIds].some((id) => line.includes(id))) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (rootIds.has(entry.uuid) && entry.type === "user") {
        rawByRoot.set(entry.uuid, redact(userText(entry)));
      }
    }
  }
}

for (const [index, entry] of worst.entries()) {
  const row = entry.row;
  const ancestors = [];
  let parent = row.parentRequestId === null ? null : byId.get(row.parentRequestId) ?? null;
  while (parent && ancestors.length < 5) {
    ancestors.push({
      action: parent.tools[0] ?? "(no-tool)",
      outputTokens: parent.outputTokens,
    });
    parent =
      parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  console.log(`\n#${index + 1} loss=${entry.loss.toFixed(0)} actual=${row.outputTokens} forecast=${entry.forecast.join("/")}`);
  console.log(
    `  model=${row.model} thinking=${row.thinking} action=${row.tools[0] ?? "(no-tool)"} ` +
      `depth=${row.loopDepthExact ? row.loopDepth : "unknown"} workload=${row.workloadId ?? "unknown"}`,
  );
  console.log(
    `  pre-call prompt: path=${row.promptPath ?? "unknown"} ` +
      `deliverable=${row.turnPrompt?.deliverableType ?? "unknown"} ` +
      `format=${row.turnPrompt?.requestedFormat ?? "unknown"} ` +
      `artifactIntent=${row.turnPrompt?.artifactIntent ?? "unknown"}`,
  );
  console.log(`  legal ancestors (nearest first): ${JSON.stringify(ancestors)}`);
  if (showRaw) console.log(`  redacted turn root: ${rawByRoot.get(row.turnRootId) ?? "(not found)"}`);
}

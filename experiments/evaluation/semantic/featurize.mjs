#!/usr/bin/env node
/**
 * Add the shipped 38-float portable feature vector to a turns.jsonl that
 * carries `text` but no `features`, IN PLACE.
 *
 *   node experiments/evaluation/semantic/featurize.mjs <turns.jsonl> [--dry-run]
 *
 * Generic on purpose: any public-corpus harvester can emit the turn rows
 * (`turnRootId, sessionId, firstMs, total, calls, openerTokens, model,
 * thinking, command, text, ...`) and hand the file to this script, so every
 * dataset's metadata control is built by exactly the code path the client
 * runs -- `derivePromptFeatures` from `packages/ingest-claude/load-history.mjs`
 * and `portableBoostFeatures` from `experiments/evaluation/lib/quantile-boost.mjs`.
 *
 * The row is shaped the way `export-turn-text.mjs` shapes a local turn root:
 * `thinking` and `model` come from the row, `promptPath` from the derived
 * `mentionsPath`, `promptImage` is "no" (public chat logs record no image
 * attachment), and every loop/prior field is the turn-root constant (session
 * position 0, loop depth 0, prior calls 0, the rest null). Rows whose text
 * derives no features -- a message that is only harness wrapper -- are DROPPED
 * and counted, because the shipped rung refuses to invent a level for them.
 *
 * Rows that already carry a 38-length `features` array are left untouched, so
 * a rerun is a no-op.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { derivePromptFeatures } from "../../../packages/ingest-claude/load-history.mjs";
import { portableBoostFeatures } from "../lib/quantile-boost.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((value) => !value.startsWith("--"));
if (!file) {
  console.error(
    "usage: node experiments/evaluation/semantic/featurize.mjs <turns.jsonl> [--dry-run]",
  );
  process.exit(2);
}

const source = await readFile(file, "utf8");
const lines = source.split("\n").filter((line) => line.trim().length > 0);

let dropped = 0;
let already = 0;
const out = [];
for (const line of lines) {
  const row = JSON.parse(line);
  if (Array.isArray(row.features) && row.features.length === 38) {
    already++;
    out.push(JSON.stringify(row));
    continue;
  }
  const turnPrompt = derivePromptFeatures(row.text ?? null);
  if (turnPrompt === null) {
    dropped++;
    continue;
  }
  const shaped = {
    model: row.model ?? "unknown",
    thinking: row.thinking === "yes" ? "yes" : "no",
    turnPrompt,
    promptPath: turnPrompt.mentionsPath ? "yes" : "no",
    promptImage: "no",
    sessionPosition: 0,
    loopDepth: 0,
    priorCalls: 0,
    priorMaxOutput: null,
    priorArtifactCount: null,
    priorWrite: null,
    priorArtifact: null,
  };
  out.push(
    JSON.stringify({ ...row, features: [...portableBoostFeatures(shaped)] }),
  );
}

console.log(
  `featurized ${out.length - already} rows (${already} already had features, ` +
    `${dropped} dropped for null prompt features) in ${file}`,
);
if (dryRun) process.exit(0);

const temporary = path.join(
  path.dirname(path.resolve(file)),
  `.${path.basename(file)}.featurize.tmp`,
);
await writeFile(temporary, out.join("\n") + "\n");
await rename(temporary, file);

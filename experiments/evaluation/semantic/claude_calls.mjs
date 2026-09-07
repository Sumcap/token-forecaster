#!/usr/bin/env node
/**
 * Per-call extractor for Claude Code `.jsonl` transcripts harvested from public
 * GitHub repositories, for `harvest_sessions.py` (Tier A of
 * `docs/PLAN-OF-ATTACK.md` Track 2).
 *
 * It exists so the public corpus is cut into turns and calls by EXACTLY the
 * code that cuts the local corpus: `loadRequests` in
 * `packages/ingest-claude/load-history.mjs`. Re-implementing `parentUuid`
 * ancestry in Python would have produced a second, silently different
 * definition of "a call" and "a turn", and the whole point of the multi-source
 * base is that rows from different sources are comparable.
 *
 *     node claude_calls.mjs --staging <dir> --out <calls.jsonl>
 *
 * `--staging` is a directory of hardlinks laid out as `<sha>/<sha>.jsonl`, one
 * directory per harvested blob, so the loader's `workloadId` (a hash of the
 * first path segment) identifies the file a call came from. One file is one
 * session; public transcripts are standalone and are never resumed across
 * blobs.
 *
 * Output carries the CLEANED TURN-ROOT PROMPT TEXT on turn-opening calls, so it
 * is written under the gitignored dataset directory and never committed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  hasThinkingBlock,
  loadRequests,
} from "../../../packages/ingest-claude/load-history.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const staging = argValue("--staging");
const out = argValue("--out");
if (!staging || !out) throw new Error("--staging and --out are required");

const workloadId = (root) =>
  createHash("sha256")
    .update(`token-forecaster-workload\0${root}`)
    .digest("hex")
    .slice(0, 16);

const dirs = (await readdir(staging, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const byWorkload = new Map(dirs.map((sha) => [workloadId(sha), sha]));

/**
 * Largest single `tool_use` input, per call.
 *
 * The loader keeps only the SUM of tool-input characters, and the feature the
 * plan asks for is the largest one -- a call that wrote one 40 KB file and one
 * that ran twenty greps are different animals with the same sum. Recovering it
 * needs a pass over the same rows, which is cheap next to the loader's own.
 */
const largestToolInput = new Map();
for (const sha of dirs) {
  const file = path.join(staging, sha, `${sha}.jsonl`);
  const lines = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes("tool_use")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !entry.requestId) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    let biggest = largestToolInput.get(entry.requestId) ?? 0;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const chars = JSON.stringify(block.input ?? {}).length;
      if (chars > biggest) biggest = chars;
    }
    largestToolInput.set(entry.requestId, biggest);
  }
}

const { rows, filesScanned } = await loadRequests(staging, { withPromptText: true });

const lines = [];
let unattributed = 0;
for (const row of rows) {
  const sha = byWorkload.get(row.workloadId);
  if (sha === undefined) {
    // The same requestId appeared under two blob shas (a transcript committed
    // twice). Attribution is ambiguous, and a call that cannot be assigned to a
    // repository cannot be held out by user, so it is dropped rather than
    // guessed at.
    unattributed++;
    continue;
  }
  lines.push(
    JSON.stringify({
      sha,
      requestId: row.requestId,
      transcriptSessionId: row.sessionId ?? null,
      timestampMs: Number.isFinite(row.timestampMs) ? row.timestampMs : null,
      model: row.model ?? null,
      outputTokens: row.outputTokens,
      stopReason: row.stopReason ?? null,
      turnRootId: row.turnRootId ?? null,
      loopDepth: row.loopDepth ?? null,
      loopDepthExact: row.loopDepthExact === true,
      tools: row.tools ?? [],
      largestToolInputChars: largestToolInput.get(row.requestId) ?? 0,
      textChars: row.textChars,
      toolChars: row.toolChars,
      thinkingChars: row.thinkingChars,
      thinking: hasThinkingBlock(row) ? "yes" : "no",
      turnPromptText: row.turnPromptText ?? null,
    }),
  );
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, lines.length ? lines.join("\n") + "\n" : "");
console.error(
  JSON.stringify({
    filesScanned,
    blobs: dirs.length,
    calls: lines.length,
    unattributed,
  }),
);

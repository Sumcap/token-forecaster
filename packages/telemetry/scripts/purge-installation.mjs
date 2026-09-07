#!/usr/bin/env node
/**
 * Physically remove one installation's rows from the telemetry JSONL files,
 * and apply the retention window.
 *
 * The ingest handler answers a delete request by appending a tombstone to
 * `deletions.jsonl`; it does not rewrite the data files, because an
 * append-only log cannot be rewritten safely underneath live appends. This
 * script is the other half: run it with the collector stopped, and it rewrites
 * each file without the rows in question.
 *
 * Rows identify their installation exactly as they always have, in
 * `metadata.userIdHash`: an opaque local identifier the client generated and
 * can show its user. There is no account, so this string is the whole of the
 * delete path's identity.
 *
 * Usage
 *   node scripts/purge-installation.mjs --file <observations.jsonl> [...]
 *     [--installation <id>]     purge exactly this one, tombstone or not
 *     [--deletions <path>]      default: deletions.jsonl beside the first file
 *     [--retain-days <n>]       also drop rows older than n days
 *     [--apply]                 without it, nothing is written
 *
 * Cron, once the operator has decided the numbers (see docs/TELEMETRY.md):
 *   0 4 * * *  systemctl stop token-forecaster-ingest &&
 *              node purge-installation.mjs --file … --retain-days 400 --apply &&
 *              systemctl start token-forecaster-ingest
 */
import { createReadStream } from "node:fs";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const argv = process.argv.slice(2);
const files = [];
let installation = null;
let deletionsPath = null;
let retainDays = null;
let apply = false;

for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--file") {
    files.push(path.resolve(value));
    i += 1;
  } else if (flag === "--installation") {
    installation = value;
    i += 1;
  } else if (flag === "--deletions") {
    deletionsPath = path.resolve(value);
    i += 1;
  } else if (flag === "--retain-days") {
    retainDays = Number.parseInt(value, 10);
    i += 1;
  } else if (flag === "--apply") {
    apply = true;
  } else {
    throw new Error(`unknown option: ${flag}`);
  }
}

if (files.length === 0) throw new Error("at least one --file is required");
if (retainDays !== null && (!Number.isInteger(retainDays) || retainDays <= 0)) {
  throw new Error("--retain-days must be a positive integer");
}

deletionsPath ??= path.join(path.dirname(files[0]), "deletions.jsonl");

/** Every installation id with a tombstone, plus an explicit --installation. */
async function requestedDeletions() {
  const ids = new Set();
  if (installation) ids.add(installation);
  let raw;
  try {
    raw = await readFile(deletionsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return ids;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "deletion_requested" && typeof record.installationId === "string") {
        ids.add(record.installationId);
      }
    } catch {
      // A corrupt tombstone line is reported by the count, not acted on.
    }
  }
  return ids;
}

const doomed = await requestedDeletions();
const cutoffMs =
  retainDays === null ? null : Date.now() - retainDays * 24 * 60 * 60 * 1000;

const summary = [];
for (const file of files) {
  let kept = 0;
  let removedByInstallation = 0;
  let removedByRetention = 0;
  let unparsable = 0;
  const keptLines = [];

  let lines;
  try {
    await stat(file);
    lines = createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      summary.push({ file, missing: true });
      continue;
    }
    throw error;
  }

  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // Keep a line we cannot read: deleting data because the parser choked is
      // worse than keeping a line the evaluator will skip.
      unparsable += 1;
      keptLines.push(line);
      continue;
    }
    const owner = row?.metadata?.userIdHash;
    if (typeof owner === "string" && doomed.has(owner)) {
      removedByInstallation += 1;
      continue;
    }
    if (cutoffMs !== null) {
      const at = Date.parse(row?.timestamp ?? "");
      if (Number.isFinite(at) && at < cutoffMs) {
        removedByRetention += 1;
        continue;
      }
    }
    kept += 1;
    keptLines.push(line);
  }

  if (apply && (removedByInstallation > 0 || removedByRetention > 0)) {
    const temporary = `${file}.purge-${process.pid}`;
    await writeFile(temporary, keptLines.length ? `${keptLines.join("\n")}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }
  summary.push({ file, kept, removedByInstallation, removedByRetention, unparsable });
}

process.stdout.write(
  `${JSON.stringify(
    {
      apply,
      installationsRequested: doomed.size,
      retainDays,
      files: summary,
    },
    null,
    2,
  )}\n`,
);
if (!apply) {
  process.stdout.write("dry run: pass --apply to rewrite the files\n");
}

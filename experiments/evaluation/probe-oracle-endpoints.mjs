#!/usr/bin/env node
/**
 * Replication driver for the corrected oracle ceiling (STATE-OF-PLAY §4.2).
 *
 * The claim under test is that the published ceiling -- "an oracle told the true
 * tool is worth ~-49 pinball/call" -- is an artifact of the 100-sample floor in
 * probe-loop-depth.mjs, which prevents the joint `m|t|action` rung from ever
 * firing on `Write`. A single re-run at one corpus endpoint cannot settle that,
 * because §7.1 already showed this repo capable of reading a stable effect as
 * two different numbers at two nearby endpoints. So: re-run the whole probe at
 * many endpoints and report the DISTRIBUTION.
 *
 * It shells out to probe-loop-depth.mjs rather than reimplementing the ladder,
 * because a second implementation of the population or the fit is the one thing
 * this directory has been bitten by twice (house rule 6).
 *
 * Privacy: aggregates only. No prompt or response text is read or retained.
 *
 * Usage:
 *   node experiments/evaluation/probe-oracle-endpoints.mjs
 *     [--projects-dir <dir>] [--json <path>] [--endpoints <n>] [--min-group <n>]
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultProjectsDir, loadRequests, redactHome } from "./lib/load-history.mjs";
import { fmt, median, pct, quantile } from "./lib/stats.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/oracle-endpoints-probe.json"),
);
const endpointCount = Number(argValue("--endpoints", "12"));
const minGroup = argValue("--min-group", "100");
const probe = path.join(import.meta.dirname, "probe-loop-depth.mjs");

// Endpoints are chosen on the CALL index and converted to instants, so they are
// evenly spaced in data rather than in wall-clock time -- the corpus is bursty
// and calendar-spaced endpoints would cluster.
const { rows } = await loadRequests(projectsDir);
const stamps = rows
  .filter((row) => Number.isFinite(row.timestampMs) && row.outputTokens > 0)
  .map((row) => row.timestampMs)
  .sort((a, b) => a - b);
const total = stamps.length;
const firstIndex = Math.floor(total * 0.78);
const endpoints = [];
for (let i = 0; i < endpointCount; i++) {
  const index =
    firstIndex +
    Math.round(((total - 1 - firstIndex) * i) / Math.max(endpointCount - 1, 1));
  // +1ms so the call at `index` is included by the probe's strict `<` filter.
  endpoints.push({ index, asOf: new Date(stamps[index] + 1).toISOString() });
}

console.log(
  `Replicating the oracle ceiling at ${endpoints.length} corpus endpoints` +
    ` spanning ${fmt(endpoints[0].index + 1)} -> ${fmt(total)} calls,` +
    ` minGroup=${minGroup}.\n`,
);

const scratch = path.join(tmpdir(), `oracle-endpoints-${process.pid}`);
await mkdir(scratch, { recursive: true });

const ORACLES = ["oracleAction", "oracleActionPooled", "oracleWriteBinary"];
const results = [];
console.log(
  `  ${"calls".padStart(8)}${"joint only".padStart(13)}${"+ pooled".padStart(13)}` +
    `${"binary Write".padStart(14)}${"shipped".padStart(10)}` +
    `${"pooled %".padStart(10)}${"joint %".padStart(9)}${"pooled>joint".padStart(14)}`,
);
for (const endpoint of endpoints) {
  const out = path.join(scratch, `${endpoint.index}.json`);
  await run("node", [
    probe,
    "--projects-dir",
    projectsDir,
    "--as-of",
    endpoint.asOf,
    "--min-group",
    minGroup,
    "--no-sweep",
    "--json",
    out,
  ]);
  const report = JSON.parse(await readFile(out, "utf8"));
  const shipped = report.ceiling.shippedPerCall;
  const grade = (name) => report.candidates[name].vsShipped;
  const row = {
    asOf: endpoint.asOf,
    calls: report.coverage.calls,
    shippedPerCall: shipped,
    oracles: Object.fromEntries(ORACLES.map((n) => [n, grade(n)])),
    writeCoverage: Object.fromEntries(
      ORACLES.map((n) => [n, report.oracleRungUsage[n].writeCoverage]),
    ),
    pooledShareOfShipped: Math.abs(grade("oracleActionPooled").meanDifference) / shipped,
    jointShareOfShipped: Math.abs(grade("oracleAction").meanDifference) / shipped,
  };
  // The claim being replicated is not a number, it is an INEQUALITY: the joint
  // rung understates the ceiling. Record the direction separately from the size.
  row.pooledBeatsJoint =
    grade("oracleActionPooled").meanDifference <
    grade("oracleAction").meanDifference;
  results.push(row);
  console.log(
    `  ${fmt(row.calls).padStart(8)}` +
      `${grade("oracleAction").meanDifference.toFixed(1).padStart(13)}` +
      `${grade("oracleActionPooled").meanDifference.toFixed(1).padStart(13)}` +
      `${grade("oracleWriteBinary").meanDifference.toFixed(1).padStart(14)}` +
      `${shipped.toFixed(0).padStart(10)}` +
      `${pct(row.pooledShareOfShipped).padStart(10)}` +
      `${pct(row.jointShareOfShipped).padStart(9)}` +
      `${(row.pooledBeatsJoint ? "yes" : "NO").padStart(14)}`,
  );
}
await rm(scratch, { recursive: true, force: true });

const summarise = (values) => ({
  n: values.length,
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
  p25: quantile(values, 0.25),
  p75: quantile(values, 0.75),
});
const pooled = results.map((r) => r.oracles.oracleActionPooled.meanDifference);
const joint = results.map((r) => r.oracles.oracleAction.meanDifference);
const binary = results.map((r) => r.oracles.oracleWriteBinary.meanDifference);
const agreeing = results.filter((r) => r.pooledBeatsJoint).length;
const clearOfZero = (name) =>
  results.filter((r) => r.oracles[name].ciUpper < 0).length;

console.log("\n  ACROSS ENDPOINTS\n");
const line = (label, values) => {
  const s = summarise(values);
  console.log(
    `  ${label.padEnd(22)}median ${s.median.toFixed(1).padStart(7)}` +
      `   IQR [${s.p25.toFixed(1)}, ${s.p75.toFixed(1)}]` +
      `   range [${s.min.toFixed(1)}, ${s.max.toFixed(1)}]`,
  );
};
line("joint only", joint);
line("+ pooled", pooled);
line("binary Write", binary);
console.log(
  `\n  pooled rung beats joint rung at ${agreeing}/${results.length} endpoints` +
    `  <- the claim under test`,
);
console.log(
  `  95% CI clear of zero:  joint ${clearOfZero("oracleAction")}/${results.length}` +
    `   pooled ${clearOfZero("oracleActionPooled")}/${results.length}` +
    `   binary ${clearOfZero("oracleWriteBinary")}/${results.length}`,
);
const shareOfShipped = results.map((r) => r.pooledShareOfShipped);
const jointShare = results.map((r) => r.jointShareOfShipped);
console.log(
  `\n  Corrected ceiling as a share of shipped loss:` +
    ` median ${pct(median(shareOfShipped))}, range ` +
    `${pct(Math.min(...shareOfShipped))}-${pct(Math.max(...shareOfShipped))}`,
);
console.log(
  `  Joint-only ceiling, same measure:            ` +
    ` median ${pct(median(jointShare))}, range ` +
    `${pct(Math.min(...jointShare))}-${pct(Math.max(...jointShare))}`,
);

const report = {
  generatedAt: new Date().toISOString(),
  source: redactHome(projectsDir),
  minGroup: Number(minGroup),
  endpoints: results,
  summary: {
    joint: summarise(joint),
    pooled: summarise(pooled),
    binaryWrite: summarise(binary),
    pooledBeatsJointAt: agreeing,
    endpointCount: results.length,
    ciClearOfZero: Object.fromEntries(
      ORACLES.map((n) => [n, clearOfZero(n)]),
    ),
    pooledShareOfShipped: summarise(shareOfShipped),
    jointShareOfShipped: summarise(jointShare),
  },
};
await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

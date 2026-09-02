#!/usr/bin/env node
/**
 * Answers three reviewer questions with numbers, on the same corpus and the
 * same trained models as eval-winning-boost.mjs:
 *   1. call-level vs SESSION-level holdout (does the split leak?)
 *   2. sharpness of the rung ladder vs the pooled ladder AT MATCHED COVERAGE
 *   3. coverage measured after the trained correction, out of sample, with a
 *      session-cluster bootstrap interval so "9 in 10" carries an error bar.
 */
import { defaultProjectsDir, hasThinkingBlock, loadRequests } from "./lib/load-history.mjs";
import { trainPortableQuantileBoost } from "./lib/quantile-boost.mjs";
import { pinball, quantile, bootstrapBlocks, mulberry32, BOOTSTRAP_SEED } from "./lib/stats.mjs";

const QUANTILES = [0.5, 0.9, 0.99];
const FIELDS = ["pooled", "coldModel", "coldModelThinking", "ladder", "boosted"];
const MIN_GROUP = 100;
const { rows: loaded } = await loadRequests(defaultProjectsDir(), { withPromptFeatures: true });
const rows = loaded
  .filter((r) => Number.isFinite(r.timestampMs) && Number.isFinite(r.outputTokens) && r.outputTokens >= 0)
  .sort((a, b) => a.timestampMs - b.timestampMs);
const byId = new Map(rows.map((r) => [r.requestId, r]));
const sessions = new Map();
for (const row of rows) {
  const s = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(s)) sessions.set(s, []);
  sessions.get(s).push(row);
}
for (const list of sessions.values()) {
  list.sort((a, b) => a.timestampMs - b.timestampMs);
  list.forEach((r, i) => { r.sessionPosition = i; });
}
for (const row of rows) {
  row.thinking = hasThinkingBlock(row) ? "yes" : "no";
  row.promptPath = row.turnPrompt === null ? null : row.turnPrompt.mentionsPath ? "yes" : "no";
  row.promptImage = row.turnHasImage === null ? null : row.turnHasImage ? "yes" : "no";
  let parent = row.parentRequestId === null ? null : byId.get(row.parentRequestId) ?? null;
  let priorCalls = 0, priorMaxOutput = 0, priorArtifacts = 0, priorWrites = 0;
  const seen = new Set();
  while (parent && priorCalls < 200 && !seen.has(parent.requestId)) {
    seen.add(parent.requestId);
    priorCalls++;
    const action = parent.tools[0] ?? "(no-tool)";
    const artifact = action === "Write" || (action === "Edit" && parent.toolChars >= 4_000);
    if (action === "Write") priorWrites++;
    if (artifact) priorArtifacts++;
    priorMaxOutput = Math.max(priorMaxOutput, parent.outputTokens);
    parent = parent.parentRequestId === null ? null : byId.get(parent.parentRequestId) ?? null;
  }
  row.priorCalls = priorCalls;
  row.priorMaxOutput = priorCalls === 0 ? null : priorMaxOutput;
  row.priorArtifactCount = priorCalls === 0 ? null : priorArtifacts;
  row.priorWrite = priorCalls === 0 ? null : priorWrites > 0 ? "yes" : "no";
  row.priorArtifact = priorCalls === 0 ? null : priorArtifacts > 0 ? "yes" : "no";
}

const fit = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, q: QUANTILES.map((p) => Math.round(quantile(sorted, p))) };
};
function fitGroups(trainRows, keyFn) {
  const grouped = new Map();
  for (const row of trainRows) {
    const k = keyFn(row);
    if (k === null) continue;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(row.outputTokens);
  }
  return new Map([...grouped.entries()].filter(([, v]) => v.length >= MIN_GROUP).map(([k, v]) => [k, fit(v)]));
}
const key = {
  mtp: (r) => (r.promptPath === null ? null : `model=${r.model}|thinking=${r.thinking}|promptPath=${r.promptPath}`),
  path: (r) => (r.promptPath === null ? null : `promptPath=${r.promptPath}`),
  mt: (r) => `model=${r.model}|thinking=${r.thinking}`,
  model: (r) => `model=${r.model}`,
};
function makeLadder(trainRows, keys) {
  const fits = keys.map((f) => fitGroups(trainRows, f));
  const overall = fit(trainRows.map((r) => r.outputTokens));
  return (row) => {
    for (let i = 0; i < keys.length; i++) {
      const g = keys[i](row);
      if (g === null) continue;
      const found = fits[i].get(g);
      if (found) return found.q;
    }
    return overall.q;
  };
}
const loss = (row, f) => QUANTILES.reduce((s, p, i) => s + pinball(row.outputTokens, f[i], p), 0);
function metrics(records, field) {
  const m = { n: records.length, loss: 0, coverage: [0, 0, 0], p90Mean: 0, width: [0, 0] };
  for (const r of records) {
    const f = r[field];
    m.loss += loss(r.row, f);
    for (let i = 0; i < 3; i++) m.coverage[i] += r.row.outputTokens <= f[i] ? 1 : 0;
    m.p90Mean += f[1];
    m.width[0] += f[1] - f[0];
    m.width[1] += f[2] - f[0];
  }
  m.loss /= records.length;
  m.coverage = m.coverage.map((v) => v / records.length);
  m.p90Mean /= records.length;
  m.width = m.width.map((v) => v / records.length);
  return m;
}
/** Session-cluster bootstrap CI for a coverage rate. */
function coverageCi(records, field, qIndex, scale = 1) {
  const hits = records.map((r) => (r.row.outputTokens <= r[field][qIndex] * scale ? 1 : 0));
  const { blocks } = bootstrapBlocks(records.map((r) => r.row.sessionId ?? null));
  const random = mulberry32(BOOTSTRAP_SEED);
  const draws = [];
  for (let d = 0; d < 2000; d++) {
    let sum = 0, n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      for (const idx of block) { sum += hits[idx]; n++; }
    }
    draws.push(sum / n);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]];
}
function evaluateSplit(train, test, label) {
  const ladder = makeLadder(train, [key.mtp, key.path, key.mt, key.model]);
  const pooled = makeLadder(train, []); // overall pool only
  // Cold-start tiers, in the vocabulary of probe-cold-start.mjs: what a caller
  // gets when it knows less and less about the request.
  const coldModelThinking = makeLadder(train, [key.mt, key.model]);
  const coldModel = makeLadder(train, [key.model]);
  const boost = trainPortableQuantileBoost(train, ladder, { featureSchema: "portable-precall-v2" });
  const records = test.map((row) => ({
    row,
    pooled: pooled(row),
    coldModel: coldModel(row),
    coldModelThinking: coldModelThinking(row),
    ladder: ladder(row),
    boosted: boost.predict(row),
  }));
  const sessionCount = new Set(test.map((r) => r.sessionId)).size;
  return { label, trainCalls: train.length, testCalls: test.length, sessionCount, records };
}

// --- split A: chronological, cut at a call boundary (what ships today) -------
const cut = Math.floor(rows.length * 0.8);
const splitA = evaluateSplit(rows.slice(0, cut), rows.slice(cut), "call-boundary (shipped)");
const trainIds = new Set(rows.slice(0, cut).map((r) => r.sessionId));
const testIds = new Set(rows.slice(cut).map((r) => r.sessionId));
const straddling = [...testIds].filter((id) => trainIds.has(id));

// --- split B: chronological, whole sessions only ----------------------------
const ordered = [...sessions.entries()].sort((a, b) => a[1][0].timestampMs - b[1][0].timestampMs);
const trainB = [], testB = [];
let filled = 0;
for (const [, list] of ordered) {
  if (filled < cut) { trainB.push(...list); filled += list.length; } else testB.push(...list);
}
const splitB = evaluateSplit(trainB.sort((a, b) => a.timestampMs - b.timestampMs), testB, "session-boundary");

for (const split of [splitA, splitB]) {
  console.log(`\n=== ${split.label}: train ${split.trainCalls} / test ${split.testCalls} calls in ${split.sessionCount} sessions`);
  for (const field of FIELDS) {
    const m = metrics(split.records, field);
    const ci = coverageCi(split.records, field, 1);
    console.log(
      `${field.padEnd(8)} loss ${m.loss.toFixed(1).padStart(7)}  cov ${m.coverage.map((v) => (v * 100).toFixed(1) + "%").join("/")}` +
      `  P90cov CI [${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]  meanP90 ${Math.round(m.p90Mean)}  width(p50-p90) ${Math.round(m.width[0])}  (p50-p99) ${Math.round(m.width[1])}`,
    );
  }
}
console.log(`\nsessions split across the call boundary in split A: ${straddling.length} of ${testIds.size} holdout sessions`);

// --- sharpness at MATCHED coverage ------------------------------------------
// Scale every p90 by one constant per model until the holdout P90 coverage hits
// the same target, then compare how wide the bands had to be to get there.
function scaleForCoverage(records, field, target) {
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const cov = records.filter((r) => r.row.outputTokens <= r[field][1] * mid).length / records.length;
    if (cov < target) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const meanP90 = records.reduce((s, r) => s + r[field][1] * k, 0) / records.length;
  const cov = records.filter((r) => r.row.outputTokens <= r[field][1] * k).length / records.length;
  return { k, meanP90, cov };
}
console.log("\n=== sharpness at matched P90 coverage (session-boundary holdout)");
for (const target of [0.9, 0.92]) {
  const line = ["pooled", "ladder", "boosted"].map((field) => {
    const s = scaleForCoverage(splitB.records, field, target);
    return `${field} meanP90 ${Math.round(s.meanP90)} (x${s.k.toFixed(2)}, cov ${(s.cov * 100).toFixed(1)}%)`;
  });
  console.log(`target ${(target * 100).toFixed(0)}%: ${line.join("  |  ")}`);
}

// --- cold start: raw width vs width at matched coverage ---------------------
// The published "-24%" is a RAW p50-p99 width comparison at whatever coverage
// each tier happened to land on. This repeats it with the coverage matched, so
// the two claims can be read side by side.
function scaleForCoverage99(records, field, target) {
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const cov = records.filter((r) => r.row.outputTokens <= r[field][2] * mid).length / records.length;
    if (cov < target) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const width = records.reduce((s, r) => s + (r[field][2] * k - r[field][0]), 0) / records.length;
  const cov = records.filter((r) => r.row.outputTokens <= r[field][2] * k).length / records.length;
  return { k, width, cov };
}
console.log("\n=== cold start tiers, p50-p99 width (session-boundary holdout)");
const coldRaw = {}, coldMatched = {};
for (const field of FIELDS) {
  const m = metrics(splitB.records, field);
  coldRaw[field] = { width: m.width[1], p99Coverage: m.coverage[2] };
  coldMatched[field] = scaleForCoverage99(splitB.records, field, 0.99);
  console.log(
    `${field.padEnd(18)} raw width ${Math.round(m.width[1]).toString().padStart(6)} at ${(m.coverage[2] * 100).toFixed(1)}% coverage` +
    `   |   at a matched 99.0%: ${Math.round(coldMatched[field].width).toString().padStart(6)} (x${coldMatched[field].k.toFixed(2)})`,
  );
}

// --- conditional coverage ---------------------------------------------------
// A band can hit 90% overall and still be wrong everywhere: too wide on the
// cheap calls, too narrow on the expensive ones. This scales each model to the
// SAME 90% global coverage on the session-boundary holdout, then reports the
// coverage inside each fifth of the workload. The conditioning variable is the
// boosted p90, i.e. the size the predictor expects BEFORE the call. Bucketing on
// the realised output instead would make the top bucket uncoverable by
// construction, which measures nothing.
const COND_FIELDS = ["pooled", "ladder", "boosted"];
const COND_BUCKETS = 5;
const condSorted = splitB.records.map((r) => r.boosted[1]).sort((a, b) => a - b);
const condEdges = Array.from({ length: COND_BUCKETS - 1 }, (_, i) =>
  quantile(condSorted, (i + 1) / COND_BUCKETS),
);
const bucketOf = (v) => {
  let b = 0;
  while (b < condEdges.length && v > condEdges[b]) b++;
  return b;
};
const condGroups = Array.from({ length: COND_BUCKETS }, () => []);
for (const r of splitB.records) condGroups[bucketOf(r.boosted[1])].push(r);
const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);
const conditional = {};
for (const field of COND_FIELDS) {
  const { k } = scaleForCoverage(splitB.records, field, 0.9);
  conditional[field] = {
    scale: k,
    buckets: condGroups.map((g, i) => ({
      bucket: i + 1,
      n: g.length,
      medianExpectedP90: Math.round(median(g.map((r) => r.boosted[1]))),
      medianOutput: Math.round(median(g.map((r) => r.row.outputTokens))),
      meanBandP90: Math.round(g.reduce((s, r) => s + r[field][1] * k, 0) / g.length),
      coverage: g.filter((r) => r.row.outputTokens <= r[field][1] * k).length / g.length,
      coverageCi: coverageCi(g, field, 1, k),
    })),
  };
}
console.log("\n=== conditional P90 coverage, every model scaled to 90% overall (session-boundary holdout)");
console.log(`bucket edges on the expected p90: ${condEdges.map((e) => Math.round(e)).join(", ")}`);
for (const field of COND_FIELDS) {
  const line = conditional[field].buckets
    .map((b) => `${(b.coverage * 100).toFixed(1)}%`)
    .join("  ");
  console.log(`${field.padEnd(8)} x${conditional[field].scale.toFixed(2)}  light -> heavy  ${line}`);
}
console.log(
  `n per bucket ${conditional.boosted.buckets.map((b) => b.n).join("/")}` +
    `   median actual output ${conditional.boosted.buckets.map((b) => b.medianOutput).join("/")}`,
);

// --- artifact for the chart pack --------------------------------------------
const sharpness = {};
for (const target of [0.9, 0.92]) {
  sharpness[String(target)] = Object.fromEntries(
    FIELDS.map((field) => [field, scaleForCoverage(splitB.records, field, target)]),
  );
}
const dump = (split) => ({
  label: split.label,
  trainCalls: split.trainCalls,
  testCalls: split.testCalls,
  sessionCount: split.sessionCount,
  models: Object.fromEntries(
    FIELDS.map((field) => [
      field,
      {
        ...metrics(split.records, field),
        coverageCi: [0, 1, 2].map((i) => coverageCi(split.records, field, i)),
      },
    ]),
  ),
});
const { writeFile, mkdir } = await import("node:fs/promises");
const path = (await import("node:path")).default;
const out = path.join(process.cwd(), "experiments/artifacts/reviewer-checks.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpusCalls: rows.length,
      corpusSessions: sessions.size,
      quantiles: QUANTILES,
      straddlingSessions: straddling.length,
      holdoutSessions: testIds.size,
      callBoundary: dump(splitA),
      sessionBoundary: dump(splitB),
      sharpness,
      coldStart: { raw: coldRaw, matched: coldMatched },
      conditional: { bucketEdges: condEdges, models: conditional },
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${out}`);

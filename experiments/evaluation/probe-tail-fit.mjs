#!/usr/bin/env node
/**
 * STEP 2: fit the tail.
 *
 * docs/GENERATIVE-MODEL.md §5 is the last untested claim in that document. It
 * reports a Hill estimator drifting 2.61 -> 1.85 with no plateau and concludes
 * "power-law, alpha ~ 2", while flagging that the exponent itself is not
 * trustworthy. Three things follow that matter here:
 *
 *   1. The shipped p99 is an order statistic read off ~140 observations from a
 *      distribution with no stable second moment. It has no standard error. A
 *      fitted tail gives one.
 *   2. The p99 is where the forecast band is widest, so it is where narrowing
 *      pays most -- and a smooth tail fit can be tighter than a lone order
 *      statistic without being less safe.
 *   3. §5 claims a fitted tail unblocks cap risk (backlog #12) by extrapolation.
 *      That claim is testable WITHOUT extrapolating: fit as if nothing above T
 *      had ever been seen, predict P(Y > 2T) and P(Y > 4T), and check against
 *      the counts we actually have.
 *
 * Peaks-over-threshold: empirical quantiles below the threshold, a generalized
 * Pareto above it, threshold chosen from a Hill/stability scan. Standard errors
 * come from both the observed information matrix and a seeded bootstrap, because
 * the delta method assumes an asymptotic regime that a 140-point tail may not be
 * in.
 *
 * Privacy: aggregates only. No prompt or response text is retained.
 *
 * Usage:
 *   node experiments/evaluation/probe-tail-fit.mjs
 *     [--projects-dir <dir>] [--json <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { fmt, mulberry32, pct, pinball, quantile } from "./lib/stats.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const jsonOut = argValue(
  "--json",
  path.join(process.cwd(), "experiments/artifacts/tail-fit-probe.json"),
);

const MIN_GROUP = 100;
const QUANTILES = [0.5, 0.9, 0.99];

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const sd = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};
const seOf = (values) => sd(values) / Math.sqrt(values.length);

const { rows: allRows, filesScanned } = await loadRequests(projectsDir);
const rows = allRows
  .filter((row) => Number.isFinite(row.timestampMs) && row.outputTokens > 0)
  .sort((a, b) => a.timestampMs - b.timestampMs);
for (const row of rows) row.thinking = hasThinkingBlock(row) ? "yes" : "no";
const report = { generatedAt: new Date().toISOString(), source: projectsDir };
const values = rows.map((r) => r.outputTokens);

console.log(
  `Scanned ${filesScanned} transcripts -> ${fmt(rows.length)} usable API calls\n`,
);

// ---------------------------------------------------------------------------
// Generalized Pareto: excesses over a threshold.
//
//   P(Y - u > z | Y > u) = (1 + xi z / sigma)^(-1/xi),  xi != 0
//                        = exp(-z / sigma),             xi  = 0
//
// xi > 0 is the heavy-tailed case, and xi = 1/alpha ties it to the Hill
// exponent §5 reports.
// ---------------------------------------------------------------------------

function gpdLogLikelihood(excesses, xi, sigma, upperBound = null) {
  if (!(sigma > 0)) return -Infinity;
  const n = excesses.length;
  let total = -n * Math.log(sigma);
  if (Math.abs(xi) < 1e-8) {
    for (const z of excesses) total -= z / sigma;
  } else {
    const c = 1 + 1 / xi;
    for (const z of excesses) {
      const t = 1 + (xi * z) / sigma;
      if (t <= 0) return -Infinity;
      total -= c * Math.log(t);
    }
  }
  if (upperBound !== null) {
    // Right-truncated: we are pretending nothing above the bound was ever
    // observed, so the density must be renormalised onto (0, bound].
    const survival =
      Math.abs(xi) < 1e-8
        ? Math.exp(-upperBound / sigma)
        : (1 + (xi * upperBound) / sigma) ** (-1 / xi);
    const mass = 1 - survival;
    if (!(mass > 0)) return -Infinity;
    total -= n * Math.log(mass);
  }
  return total;
}

/** Nelder-Mead on (xi, log sigma). Two parameters, so a simplex is plenty. */
function fitGpd(excesses, upperBound = null) {
  const objective = ([xi, logSigma]) =>
    -gpdLogLikelihood(excesses, xi, Math.exp(logSigma), upperBound);
  const start = [0.1, Math.log(Math.max(mean(excesses), 1))];
  let simplex = [
    start,
    [start[0] + 0.2, start[1]],
    [start[0], start[1] + 0.2],
  ].map((point) => ({ point, value: objective(point) }));
  for (let iteration = 0; iteration < 2000; iteration++) {
    simplex.sort((a, b) => a.value - b.value);
    const [best, mid, worst] = simplex;
    if (Math.abs(worst.value - best.value) < 1e-10) break;
    const centroid = [
      (best.point[0] + mid.point[0]) / 2,
      (best.point[1] + mid.point[1]) / 2,
    ];
    const reflect = (factor) => {
      const point = [
        centroid[0] + factor * (centroid[0] - worst.point[0]),
        centroid[1] + factor * (centroid[1] - worst.point[1]),
      ];
      return { point, value: objective(point) };
    };
    const reflected = reflect(1);
    if (reflected.value < best.value) {
      const expanded = reflect(2);
      simplex[2] = expanded.value < reflected.value ? expanded : reflected;
    } else if (reflected.value < mid.value) {
      simplex[2] = reflected;
    } else {
      const contracted = reflect(-0.5);
      if (contracted.value < worst.value) simplex[2] = contracted;
      else {
        simplex = simplex.map((entry, index) =>
          index === 0
            ? entry
            : {
                point: [
                  (entry.point[0] + best.point[0]) / 2,
                  (entry.point[1] + best.point[1]) / 2,
                ],
                value: objective([
                  (entry.point[0] + best.point[0]) / 2,
                  (entry.point[1] + best.point[1]) / 2,
                ]),
              },
        );
      }
    }
  }
  simplex.sort((a, b) => a.value - b.value);
  const [xi, logSigma] = simplex[0].point;
  return {
    xi,
    sigma: Math.exp(logSigma),
    logLikelihood: -simplex[0].value,
    n: excesses.length,
  };
}

/** Observed information from a numerical Hessian, in (xi, sigma) coordinates. */
function gpdCovariance(excesses, xi, sigma, upperBound = null) {
  const h = [Math.max(1e-4, Math.abs(xi) * 1e-3), Math.max(1e-3, sigma * 1e-3)];
  const at = (a, b) => gpdLogLikelihood(excesses, a, b, upperBound);
  const base = at(xi, sigma);
  const dxx = (at(xi + h[0], sigma) - 2 * base + at(xi - h[0], sigma)) / h[0] ** 2;
  const dss = (at(xi, sigma + h[1]) - 2 * base + at(xi, sigma - h[1])) / h[1] ** 2;
  const dxs =
    (at(xi + h[0], sigma + h[1]) -
      at(xi + h[0], sigma - h[1]) -
      at(xi - h[0], sigma + h[1]) +
      at(xi - h[0], sigma - h[1])) /
    (4 * h[0] * h[1]);
  // Covariance is the inverse of the negative Hessian of the log-likelihood.
  const a = -dxx;
  const b = -dxs;
  const d = -dss;
  const determinant = a * d - b * b;
  if (!Number.isFinite(determinant) || determinant <= 0) return null;
  return { varXi: d / determinant, varSigma: a / determinant, cov: -b / determinant };
}

/** Quantile of the full distribution implied by the POT fit. */
function gpdQuantile(u, xi, sigma, exceedanceRate, p) {
  const r = (1 - p) / exceedanceRate;
  if (r >= 1) return null; // p is below the threshold; use the empirical value
  if (Math.abs(xi) < 1e-8) return u + sigma * Math.log(1 / r);
  return u + (sigma / xi) * (r ** -xi - 1);
}

/** Delta-method SE for that quantile, including the binomial term for the rate. */
function gpdQuantileSe(u, xi, sigma, exceedanceRate, n, covariance, p) {
  if (!covariance) return null;
  const r = (1 - p) / exceedanceRate;
  if (r >= 1) return null;
  const rNegXi = r ** -xi;
  const dSigma = (rNegXi - 1) / xi;
  const dXi = (-sigma / xi ** 2) * (rNegXi - 1) + (sigma / xi) * -Math.log(r) * rNegXi;
  const dRate = (sigma * rNegXi) / exceedanceRate;
  const varRate = (exceedanceRate * (1 - exceedanceRate)) / n;
  const variance =
    dXi ** 2 * covariance.varXi +
    dSigma ** 2 * covariance.varSigma +
    2 * dXi * dSigma * covariance.cov +
    dRate ** 2 * varRate;
  return variance > 0 ? Math.sqrt(variance) : null;
}

// ---------------------------------------------------------------------------
// A. The Hill plot, reproduced, and a threshold-stability scan.
// ---------------------------------------------------------------------------

console.log("A. HILL PLOT (reproduces GENERATIVE-MODEL.md §5)\n");
const descending = [...values].sort((a, b) => b - a);
function hill(k) {
  const yk = descending[k - 1];
  let total = 0;
  for (let i = 0; i < k; i++) total += Math.log(descending[i] / yk);
  return k / total;
}
console.log(`  ${"k".padStart(6)}${"y_(k)".padStart(9)}${"alpha".padStart(9)}${"xi=1/alpha".padStart(12)}`);
report.hill = [];
for (const k of [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000]) {
  if (k >= descending.length) continue;
  const alpha = hill(k);
  console.log(
    `  ${String(k).padStart(6)}${fmt(descending[k - 1]).padStart(9)}` +
      `${alpha.toFixed(2).padStart(9)}${(1 / alpha).toFixed(3).padStart(12)}`,
  );
  report.hill.push({ k, threshold: descending[k - 1], alpha, xi: 1 / alpha });
}
console.log(
  "\n  The drift §5 flagged is real and reproduces. A Hill plot with no plateau",
);
console.log(
  "  cannot pick a threshold on its own, so the choice below is made on the",
);
console.log("  stability of the GPD shape parameter instead, which is what we fit.\n");

console.log("   THRESHOLD-STABILITY SCAN (GPD shape, refitted at each threshold)\n");
console.log(
  `  ${"u@q".padStart(6)}${"u".padStart(9)}${"n>u".padStart(7)}${"xi".padStart(9)}` +
    `${"se(xi)".padStart(9)}${"sigma".padStart(10)}${"fitted p99".padStart(12)}${"se".padStart(9)}`,
);
report.thresholdScan = [];
const sortedAll = [...values].sort((a, b) => a - b);
for (const level of [0.75, 0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97]) {
  const u = quantile(sortedAll, level);
  const excesses = values.filter((v) => v > u).map((v) => v - u);
  if (excesses.length < MIN_GROUP) continue;
  const fit = fitGpd(excesses);
  const covariance = gpdCovariance(excesses, fit.xi, fit.sigma);
  const rate = excesses.length / values.length;
  const q99 = gpdQuantile(u, fit.xi, fit.sigma, rate, 0.99);
  const q99se = gpdQuantileSe(
    u,
    fit.xi,
    fit.sigma,
    rate,
    values.length,
    covariance,
    0.99,
  );
  console.log(
    `  ${level.toFixed(2).padStart(6)}${fmt(u).padStart(9)}${String(excesses.length).padStart(7)}` +
      `${fit.xi.toFixed(3).padStart(9)}` +
      `${(covariance ? Math.sqrt(covariance.varXi).toFixed(3) : "n/a").padStart(9)}` +
      `${fmt(fit.sigma).padStart(10)}${(q99 === null ? "n/a" : fmt(q99)).padStart(12)}` +
      `${(q99se === null ? "n/a" : fmt(q99se)).padStart(9)}`,
  );
  report.thresholdScan.push({
    level,
    u,
    exceedances: excesses.length,
    xi: fit.xi,
    seXi: covariance ? Math.sqrt(covariance.varXi) : null,
    sigma: fit.sigma,
    p99: q99,
    p99se: q99se,
  });
}
console.log(`\n  empirical p99 for comparison: ${fmt(quantile(sortedAll, 0.99))}`);

// Pick the lowest threshold from which the shape estimate stops moving: the
// standard bias-variance compromise, made explicit rather than by eye.
const scan = report.thresholdScan;
let chosenLevel = 0.9;
for (let i = 0; i < scan.length - 2; i++) {
  const window = scan.slice(i, i + 3);
  const spread = Math.max(...window.map((s) => s.xi)) - Math.min(...window.map((s) => s.xi));
  if (spread <= (scan[i].seXi ?? Infinity)) {
    chosenLevel = scan[i].level;
    break;
  }
}
console.log(
  `\n  Threshold adopted: the p${(chosenLevel * 100).toFixed(0)} of each group --` +
    ` the lowest level from which xi moves by less than its own standard error.`,
);
report.chosenThresholdLevel = chosenLevel;

// ---------------------------------------------------------------------------
// B. A p99 WITH a standard error, per shipped group.
// ---------------------------------------------------------------------------

console.log("\n\nB. FITTED p99 WITH A STANDARD ERROR, PER SHIPPED GROUP\n");

const groupsOf = (row) => [
  "overall",
  `model=${row.model}`,
  `model=${row.model}|thinking=${row.thinking}`,
];
const grouped = new Map();
for (const row of rows) {
  for (const key of groupsOf(row)) {
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.outputTokens);
  }
}

const random = mulberry32(20260803);
function bootstrapP99(sample, level, draws = 400) {
  const out = [];
  for (let b = 0; b < draws; b++) {
    const resampled = Array.from(
      { length: sample.length },
      () => sample[Math.floor(random() * sample.length)],
    );
    const sorted = [...resampled].sort((a, b) => a - b);
    const u = quantile(sorted, level);
    const excesses = resampled.filter((v) => v > u).map((v) => v - u);
    if (excesses.length < 30) continue;
    const fit = fitGpd(excesses);
    const q = gpdQuantile(u, fit.xi, fit.sigma, excesses.length / resampled.length, 0.99);
    if (q !== null && Number.isFinite(q)) out.push(q);
  }
  return out.length > 20
    ? { se: sd(out), lower: quantile(out, 0.025), upper: quantile(out, 0.975) }
    : null;
}

console.log(
  `  ${"group".padEnd(34)}${"n".padStart(7)}${"emp p99".padStart(10)}` +
    `${"GPD p99".padStart(10)}${"delta SE".padStart(10)}${"boot SE".padStart(10)}` +
    `${"95% CI".padStart(18)}${"xi".padStart(8)}`,
);
report.groups = {};
for (const [key, sample] of [...grouped.entries()].sort()) {
  if (sample.length < MIN_GROUP) continue;
  const sorted = [...sample].sort((a, b) => a - b);
  const u = quantile(sorted, chosenLevel);
  const excesses = sample.filter((v) => v > u).map((v) => v - u);
  if (excesses.length < 30) continue;
  const fit = fitGpd(excesses);
  const covariance = gpdCovariance(excesses, fit.xi, fit.sigma);
  const rate = excesses.length / sample.length;
  const q99 = gpdQuantile(u, fit.xi, fit.sigma, rate, 0.99);
  const deltaSe = gpdQuantileSe(u, fit.xi, fit.sigma, rate, sample.length, covariance, 0.99);
  const boot = bootstrapP99(sample, chosenLevel);
  const empirical = quantile(sorted, 0.99);
  console.log(
    `  ${key.padEnd(34)}${String(sample.length).padStart(7)}${fmt(empirical).padStart(10)}` +
      `${(q99 === null ? "n/a" : fmt(q99)).padStart(10)}` +
      `${(deltaSe === null ? "n/a" : fmt(deltaSe)).padStart(10)}` +
      `${(boot ? fmt(boot.se) : "n/a").padStart(10)}` +
      `${(boot ? `${fmt(boot.lower)}-${fmt(boot.upper)}` : "n/a").padStart(18)}` +
      `${fit.xi.toFixed(2).padStart(8)}`,
  );
  report.groups[key] = {
    n: sample.length,
    threshold: u,
    exceedances: excesses.length,
    xi: fit.xi,
    sigma: fit.sigma,
    empiricalP99: empirical,
    fittedP99: q99,
    deltaSe,
    bootstrap: boot,
  };
}
console.log(
  "\n  This is the number §5 said we did not have. The shipped p99 for" +
    ` opus-4-8+thinking`,
);
console.log(
  "  is a single order statistic; the standard error next to it says how much it",
);
console.log("  would move if the same workload were re-run.");

// ---------------------------------------------------------------------------
// C. THE TEST THAT DECIDES IT: does the fit extrapolate to unseen thresholds?
// ---------------------------------------------------------------------------

console.log(
  "\n\nC. EXTRAPOLATION TEST -- fit as if nothing above T had ever been seen\n",
);
console.log(
  "  The fit is right-truncated at T, so exceedances above T contribute nothing",
);
console.log(
  "  to it. Predicted counts above 2T and 4T are then compared with what the",
);
console.log("  corpus actually contains. This is §5's own proposed test.\n");

/**
 * The threshold cannot be chosen the same way here as in B. Truncating at T
 * leaves only the window (u, T] to fit on, so a threshold picked for the full
 * data can leave that window nearly empty -- and a GPD fitted to a few hundred
 * points spanning less than one order of magnitude is unidentified, which shows
 * up as a wild shape parameter rather than as an error. So u is lowered until
 * the window holds enough points to identify a shape, and the window is
 * reported alongside the answer.
 */
function truncatedFit(sample, T, level) {
  const sorted = [...sample].sort((a, b) => a - b);
  const u = quantile(sorted, level);
  if (u >= T) return null;
  const below = sample.filter((v) => v > u && v <= T).map((v) => v - u);
  if (below.length < 50) return null;
  const fit = fitGpd(below, T - u);
  // The exceedance rate over u is ALSO only observable below T, so it has to be
  // reconstructed from the truncated sample rather than counted directly:
  //   P(Y > u) = #(u < Y <= T) / (n * P(Y <= T | Y > u))
  const survivalAtT =
    Math.abs(fit.xi) < 1e-8
      ? Math.exp(-(T - u) / fit.sigma)
      : (1 + (fit.xi * (T - u)) / fit.sigma) ** (-1 / fit.xi);
  const observedBelowT = sample.filter((v) => v <= T).length;
  const rate = below.length / (observedBelowT + below.length * (survivalAtT / (1 - survivalAtT)));
  return { u, fit, rate: below.length / sample.length / (1 - survivalAtT), rawRate: rate };
}

function gpdSurvival(u, xi, sigma, rate, y) {
  if (y <= u) return null;
  const z = y - u;
  const conditional =
    Math.abs(xi) < 1e-8
      ? Math.exp(-z / sigma)
      : (1 + (xi * z) / sigma) ** (-1 / xi);
  return Number.isFinite(conditional) ? rate * conditional : null;
}

function lognormalTruncatedTail(sample, T, y) {
  // The rival §5 says must fail: a log-normal fitted to the same truncated data.
  const kept = sample.filter((v) => v > 0 && v <= T).map((v) => Math.log(v));
  if (kept.length < 50) return null;
  const logT = Math.log(T);
  // MLE for a right-truncated normal, by direct search on (mu, sigma).
  const objective = ([mu, logSigma]) => {
    const s = Math.exp(logSigma);
    const z = (logT - mu) / s;
    const mass = normalCdf(z);
    if (!(mass > 0)) return Infinity;
    let total = 0;
    for (const x of kept) {
      total += -Math.log(s) - 0.5 * ((x - mu) / s) ** 2 - Math.log(mass);
    }
    return -total;
  };
  let point = [mean(kept), Math.log(Math.max(sd(kept), 0.1))];
  let step = [0.5, 0.5];
  for (let iteration = 0; iteration < 400; iteration++) {
    let improved = false;
    for (let d = 0; d < 2; d++) {
      for (const sign of [1, -1]) {
        const trial = [...point];
        trial[d] += sign * step[d];
        if (objective(trial) < objective(point)) {
          point = trial;
          improved = true;
        }
      }
    }
    if (!improved) step = step.map((s) => s / 2);
    if (step[0] < 1e-6 && step[1] < 1e-6) break;
  }
  const [mu, logSigma] = point;
  return 1 - normalCdf((Math.log(y) - mu) / Math.exp(logSigma));
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 on erf.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Wilson interval: a count of 3 must not get a symmetric confidence interval. */
function wilson(count, n) {
  const z = 1.96;
  const centre = (count + (z * z) / 2) / (n + z * z);
  const half =
    (z * Math.sqrt((count * (n - count)) / n + (z * z) / 4)) / (n + z * z);
  return [centre - half, centre + half];
}

report.extrapolation = [];
const LEVELS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9];
for (const T of [2000, 4000]) {
  const targets = [2 * T, 4 * T];
  const observed = targets.map((target) => {
    const count = values.filter((v) => v > target).length;
    return { target, count, rate: count / values.length, ci: wilson(count, values.length) };
  });
  console.log(`  Fitted below T=${fmt(T)} (nothing above it is used):\n`);
  console.log(
    `    ${"u@q".padStart(5)}${"u".padStart(8)}${"window n".padStart(10)}${"xi".padStart(9)}` +
      targets.map((t) => `P(Y>${fmt(t)})`.padStart(14)).join("") +
      "   hits",
  );
  // The threshold is swept rather than chosen. Truncation leaves only (u, T] to
  // fit on, and a shape parameter identified from a narrow window is not really
  // identified at all -- if the extrapolation only works at one hand-picked u,
  // that is a coincidence and must not be reported as a capability.
  for (const level of LEVELS) {
    const truncated = truncatedFit(values, T, level);
    if (!truncated) continue;
    const predictions = targets.map((target) =>
      gpdSurvival(truncated.u, truncated.fit.xi, truncated.fit.sigma, truncated.rate, target),
    );
    const hits = predictions.filter(
      (p, i) => p !== null && p >= observed[i].ci[0] && p <= observed[i].ci[1],
    ).length;
    console.log(
      `    ${level.toFixed(2).padStart(5)}${fmt(truncated.u).padStart(8)}` +
        `${fmt(truncated.fit.n).padStart(10)}${truncated.fit.xi.toFixed(3).padStart(9)}` +
        predictions
          .map((p) => (p === null ? "n/a" : p.toExponential(2)).padStart(14))
          .join("") +
        `   ${hits}/${targets.length}`,
    );
    report.extrapolation.push({
      T,
      level,
      u: truncated.u,
      windowN: truncated.fit.n,
      xi: truncated.fit.xi,
      sigma: truncated.fit.sigma,
      predictions: targets.map((target, i) => ({
        target,
        gpdRate: predictions[i],
        observedRate: observed[i].rate,
        observedCount: observed[i].count,
        ci: observed[i].ci,
        inside:
          predictions[i] !== null &&
          predictions[i] >= observed[i].ci[0] &&
          predictions[i] <= observed[i].ci[1],
      })),
      hits,
    });
  }
  const lognormalRow = targets.map((target) => lognormalTruncatedTail(values, T, target));
  console.log(
    `    ${"lognormal".padStart(32)}` +
      lognormalRow
        .map((p) => (p === null ? "n/a" : p.toExponential(2)).padStart(14))
        .join("") +
      `   ${lognormalRow.filter((p, i) => p !== null && p >= observed[i].ci[0] && p <= observed[i].ci[1]).length}/${targets.length}`,
  );
  console.log(
    `    ${"OBSERVED".padStart(32)}` +
      observed.map((o) => o.rate.toExponential(2).padStart(14)).join(""),
  );
  console.log(
    `    ${"95% CI".padStart(32)}` +
      observed
        .map((o) => `${o.ci[0].toExponential(1)}-${o.ci[1].toExponential(1)}`.padStart(14))
        .join(""),
  );
  console.log("");
  report.lognormalExtrapolation ??= [];
  report.lognormalExtrapolation.push({
    T,
    predictions: targets.map((target, i) => ({
      target,
      rate: lognormalRow[i],
      inside:
        lognormalRow[i] !== null &&
        lognormalRow[i] >= observed[i].ci[0] &&
        lognormalRow[i] <= observed[i].ci[1],
    })),
  });
}
const totalTests = report.extrapolation.reduce((s, e) => s + e.predictions.length, 0);
const gpdPasses = report.extrapolation.reduce((s, e) => s + e.hits, 0);
const perThreshold = report.extrapolation.map((e) => `${e.hits}/${e.predictions.length}`);
console.log(
  `  Across every threshold tried, GPD lands inside the observed interval in` +
    ` ${gpdPasses}/${totalTests} tests (${perThreshold.join(" ")}).`,
);
const anyThresholdPerfect = report.extrapolation.some(
  (e) => e.hits === e.predictions.length,
);
const allThresholdsPerfect = report.extrapolation.every(
  (e) => e.hits === e.predictions.length,
);
report.extrapolationVerdict = {
  tests: totalTests,
  gpdPasses,
  anyThresholdPerfect,
  allThresholdsPerfect,
  // Extrapolating to a cap we have never observed is only justified if the
  // answer does not depend on a threshold we would have had to guess.
  earnsExtrapolation: allThresholdsPerfect,
};

// ---------------------------------------------------------------------------
// D. Does a fitted p99 beat the empirical p99 where it counts -- held out?
// ---------------------------------------------------------------------------

console.log(
  "\n\nD. HELD-OUT: FITTED p99 vs THE EMPIRICAL p99 THE PREDICTOR SHIPS TODAY\n",
);

const holdoutStart = Math.floor(rows.length * 0.8);
const blockSize = Math.floor((rows.length - holdoutStart) / 5);
const folds = [];
for (let f = 0; f < 5; f++) {
  const start = holdoutStart + f * blockSize;
  const end = f === 4 ? rows.length : start + blockSize;
  folds.push({ train: rows.slice(0, start), test: rows.slice(start, end) });
}

const keyOf = (row) => `model=${row.model}|thinking=${row.thinking}`;
const modelKeyOf = (row) => `model=${row.model}`;

function fitProfile(trainRows, useGpd) {
  const buckets = new Map();
  const add = (key, value) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(value);
  };
  for (const row of trainRows) {
    add("overall", row.outputTokens);
    add(modelKeyOf(row), row.outputTokens);
    add(keyOf(row), row.outputTokens);
  }
  const fits = new Map();
  for (const [key, sample] of buckets) {
    if (sample.length < MIN_GROUP) continue;
    const sorted = [...sample].sort((a, b) => a - b);
    let p99 = quantile(sorted, 0.99);
    if (useGpd) {
      const u = quantile(sorted, chosenLevel);
      const excesses = sample.filter((v) => v > u).map((v) => v - u);
      if (excesses.length >= 30) {
        const fit = fitGpd(excesses);
        const candidate = gpdQuantile(
          u,
          fit.xi,
          fit.sigma,
          excesses.length / sample.length,
          0.99,
        );
        if (candidate !== null && Number.isFinite(candidate) && candidate > 0) {
          p99 = candidate;
        }
      }
    }
    fits.set(key, {
      q: [quantile(sorted, 0.5), quantile(sorted, 0.9), p99],
    });
  }
  const fallback = fits.get("overall");
  return (row) =>
    fits.get(keyOf(row)) ?? fits.get(modelKeyOf(row)) ?? fallback;
}

const variants = { empiricalP99: false, gpdP99: true };
const foldLosses = {};
const foldP99Losses = {};
const foldBands = {};
const foldCoverage = {};
for (const [name, useGpd] of Object.entries(variants)) {
  foldLosses[name] = [];
  foldP99Losses[name] = [];
  foldBands[name] = [];
  foldCoverage[name] = [];
  for (const fold of folds) {
    const predict = fitProfile(fold.train, useGpd);
    let total = 0;
    let p99Total = 0;
    let band = 0;
    let covered = 0;
    for (const row of fold.test) {
      const fit = predict(row);
      for (const [i, p] of QUANTILES.entries()) {
        const loss = pinball(row.outputTokens, fit.q[i], p);
        total += loss;
        if (i === 2) p99Total += loss;
      }
      band += fit.q[2] - fit.q[0];
      if (row.outputTokens <= fit.q[2]) covered++;
    }
    foldLosses[name].push(total / fold.test.length);
    foldP99Losses[name].push(p99Total / fold.test.length);
    foldBands[name].push(band / fold.test.length);
    foldCoverage[name].push(covered / fold.test.length);
  }
}
const diffs = foldLosses.gpdP99.map((v, i) => v - foldLosses.empiricalP99[i]);
console.log(
  `  ${"p99 source".padEnd(16)}${"total".padStart(9)}${"p99 loss".padStart(10)}` +
    `${"mean band".padStart(11)}${"p99 coverage".padStart(14)}`,
);
for (const name of Object.keys(variants)) {
  console.log(
    `  ${name.padEnd(16)}${mean(foldLosses[name]).toFixed(1).padStart(9)}` +
      `${mean(foldP99Losses[name]).toFixed(1).padStart(10)}` +
      `${fmt(mean(foldBands[name])).padStart(11)}` +
      `${pct(mean(foldCoverage[name])).padStart(14)}`,
  );
}
console.log(
  `\n  paired difference (GPD - empirical): ${mean(diffs).toFixed(2)} +/- ${seOf(diffs).toFixed(2)}` +
    `  t=${(mean(diffs) / seOf(diffs)).toFixed(2)}`,
);
console.log(
  `  mean band change: ${fmt(mean(foldBands.gpdP99) - mean(foldBands.empiricalP99))} tokens` +
    ` (${pct(mean(foldBands.gpdP99) / mean(foldBands.empiricalP99) - 1)})`,
);
report.heldOut = {
  foldLosses,
  foldP99Losses,
  foldBands,
  foldCoverage,
  pairedDiff: { mean: mean(diffs), se: seOf(diffs), t: mean(diffs) / seOf(diffs) },
};

await mkdir(path.dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${jsonOut}`);

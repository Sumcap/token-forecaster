/**
 * Statistics shared by the probes in this directory.
 *
 * Extracted from probe-effort-confound.mjs after STEP 0, because the gates it
 * applied to `effort` -- support, then significance, then REPLICATION -- are
 * the same gates every other grouped claim in docs/GENERATIVE-MODEL.md has to
 * clear. Keeping them in one place means a later probe cannot quietly apply a
 * weaker standard than the one that rejected `effort`.
 *
 * Nothing here reads the filesystem or retains text.
 */

export function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export const median = (values) => quantile(values, 0.5);

export const fmt = (value) => Math.round(value).toLocaleString("en-US");
export const pct = (value) => `${(value * 100).toFixed(1)}%`;

/** Deterministic PRNG so re-runs reproduce the reported bootstrap figures. */
export function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-gamma (Lanczos), for the chi-square tail. */
export function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularized upper incomplete gamma Q(a, x) -- the chi-square upper tail. */
export function gammaQ(a, x) {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 1;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

export const chiSquareUpperTail = (statistic, df) => gammaQ(df / 2, statistic / 2);

/** Average ranks, with the tie-correction term the rank test needs. */
export function averageRanks(values) {
  const order = values
    .map((value, index) => [value, index])
    .sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let tieTerm = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[order[k][1]] = rank;
    const t = j - i + 1;
    if (t > 1) tieTerm += t ** 3 - t;
    i = j + 1;
  }
  return { ranks, tieTerm };
}

/**
 * van Elteren / stratified Mann-Whitney: compares `treated` to `control`
 * WITHIN each stratum and pools, so any between-stratum difference (date,
 * model, workload) is differenced out by construction.
 *
 * Returns the common-language effect size P(Y_treated > Y_control) -- 0.5 is
 * "no effect" -- and a normal-approximation z.
 */
export function stratifiedRankTest(strata) {
  let sumU = 0;
  let sumEU = 0;
  let sumVar = 0;
  let sumPairs = 0;
  let used = 0;
  for (const { treated, control } of strata) {
    const n1 = treated.length;
    const n2 = control.length;
    if (n1 === 0 || n2 === 0) continue;
    used++;
    const n = n1 + n2;
    const { ranks, tieTerm } = averageRanks([...treated, ...control]);
    let rankSum = 0;
    for (let i = 0; i < n1; i++) rankSum += ranks[i];
    const u = rankSum - (n1 * (n1 + 1)) / 2; // # of (treated > control) pairs
    sumU += u;
    sumEU += (n1 * n2) / 2;
    sumVar +=
      (n1 * n2 * (n + 1)) / 12 - (n1 * n2 * tieTerm) / (12 * n * (n - 1));
    sumPairs += n1 * n2;
  }
  if (sumPairs === 0) return null;
  return {
    strataUsed: used,
    pairs: sumPairs,
    effect: sumU / sumPairs,
    z: sumVar > 0 ? (sumU - sumEU) / Math.sqrt(sumVar) : 0,
  };
}

/** Bootstrap SE of log(median(treated) / median(control)). */
export function bootstrapLogRatioSe(treated, control, random, draws = 1500) {
  const values = [];
  for (let b = 0; b < draws; b++) {
    const t = Array.from(
      { length: treated.length },
      () => treated[Math.floor(random() * treated.length)],
    );
    const c = Array.from(
      { length: control.length },
      () => control[Math.floor(random() * control.length)],
    );
    const mt = median(t);
    const mc = median(c);
    if (mt > 0 && mc > 0) values.push(Math.log(mt / mc));
  }
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Cochran's Q on per-stratum log ratios. H0: every stratum is estimating ONE
 * common effect. Rejecting H0 means the pooled figure averages unlike things
 * and will not transfer forward -- the gate that killed `effort=xhigh`.
 */
export function heterogeneity(estimates) {
  if (estimates.length < 2) return { testable: false, cells: estimates.length };
  const weights = estimates.map((e) => 1 / e.se ** 2);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const pooled =
    estimates.reduce((s, e, i) => s + weights[i] * e.theta, 0) / totalWeight;
  const q = estimates.reduce(
    (s, e, i) => s + weights[i] * (e.theta - pooled) ** 2,
    0,
  );
  const df = estimates.length - 1;
  return {
    testable: true,
    cells: estimates.length,
    pooledRatio: Math.exp(pooled),
    q,
    df,
    p: chiSquareUpperTail(q, df),
    iSquared: Math.max(0, (q - df) / q),
  };
}

/** Gauss-Jordan inverse with partial pivoting. Returns null if rank-deficient. */
export function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Plain OLS. X includes its own intercept column if one is wanted. */
export function ols(X, y) {
  const n = X.length;
  const p = X[0].length;
  const xtx = Array.from({ length: p }, () => new Float64Array(p));
  const xty = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      if (X[i][a] === 0) continue;
      xty[a] += X[i][a] * y[i];
      for (let b = a; b < p; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];
  const inverse = invert(xtx.map((row) => [...row]));
  if (!inverse) return null;
  const beta = new Float64Array(p);
  for (let a = 0; a < p; a++) {
    let sum = 0;
    for (let b = 0; b < p; b++) sum += inverse[a][b] * xty[b];
    beta[a] = sum;
  }
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let a = 0; a < p; a++) fitted += X[i][a] * beta[a];
    ssRes += (y[i] - fitted) ** 2;
    ssTot += (y[i] - meanY) ** 2;
  }
  return { beta, rSquared: 1 - ssRes / ssTot, n };
}

/**
 * R^2 of a linear fit, computed by orthogonalising the design rather than by
 * inverting X'X.
 *
 * Normal equations are the wrong tool for a one-hot design built out of
 * categorical features that can be ABSENT. Two features that are unobserved on
 * exactly the same calls -- "previous action" and "previous output size" are
 * both missing precisely when a call has no parent -- contribute identical
 * indicator columns, X'X is singular, and `ols` correctly refuses to invert it.
 * Dropping those features to make the fit work would understate what the
 * feature set explains; regularising would change the quantity being reported.
 *
 * Modified Gram-Schmidt with a rank tolerance does neither: a column that adds
 * nothing beyond the ones already accepted contributes nothing and is skipped,
 * so this returns the R^2 of the design's COLUMN SPACE, which is the quantity
 * wanted, whether or not the parameterisation happens to be of full rank.
 *
 * `columns` are the non-intercept columns; the intercept is handled by
 * centring. Returns { rSquared, rank, n }.
 */
export function rSquaredOrthogonal(columns, y, tolerance = 1e-8) {
  const n = y.length;
  if (n === 0) return { rSquared: 0, rank: 0, n: 0 };
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  const centredY = Float64Array.from(y, (v) => v - meanY);
  let ssTot = 0;
  for (const value of centredY) ssTot += value * value;
  if (ssTot === 0) return { rSquared: 0, rank: 0, n };

  const basis = [];
  let explained = 0;
  for (const rawColumn of columns) {
    const column = Float64Array.from(rawColumn);
    // Centring is the projection onto the orthogonal complement of the
    // intercept, so the intercept never has to appear as a column.
    let columnMean = 0;
    for (const value of column) columnMean += value;
    columnMean /= n;
    let initialNorm = 0;
    for (let i = 0; i < n; i++) {
      column[i] -= columnMean;
      initialNorm += column[i] * column[i];
    }
    initialNorm = Math.sqrt(initialNorm);
    if (initialNorm === 0) continue; // constant column: no information
    for (const basisVector of basis) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += basisVector[i] * column[i];
      for (let i = 0; i < n; i++) column[i] -= dot * basisVector[i];
    }
    let norm = 0;
    for (const value of column) norm += value * value;
    norm = Math.sqrt(norm);
    // Collinear with what we already have, to within rounding.
    if (norm <= tolerance * initialNorm) continue;
    for (let i = 0; i < n; i++) column[i] /= norm;
    let projection = 0;
    for (let i = 0; i < n; i++) projection += column[i] * centredY[i];
    explained += projection * projection;
    basis.push(column);
  }
  return { rSquared: explained / ssTot, rank: basis.length, n };
}

/** Pinball (quantile) loss. Lower is better. */
export const pinball = (y, forecast, p) =>
  y >= forecast ? p * (y - forecast) : (1 - p) * (forecast - y);

/**
 * Seeded with a constant on purpose: the whole complaint about the 5-fold t was
 * that the verdict moved run to run, so a replacement that introduced its own
 * randomness would be no better. Same data in, same adopt/refuse decision out.
 */
export const BOOTSTRAP_SEED = 0x5eed_1234;
export const BOOTSTRAP_RESAMPLES = 2_000;

/**
 * Group a paired series into blocks that are resampled as units.
 *
 * Adjacent calls are not independent: they belong to the same session, the same
 * task and often the same file, so their forecast errors move together.
 * Resampling individual calls would treat 14,000 correlated observations as
 * 14,000 independent ones and understate the error bar. Session is the natural
 * block; where it is missing we fall back to circular blocks of length n^(1/3),
 * the standard moving-block choice.
 */
export function bootstrapBlocks(sessionIds) {
  const n = sessionIds.length;
  const covered = sessionIds.filter((id) => id !== null).length;
  if (covered / n >= 0.95) {
    const bySession = new Map();
    for (let index = 0; index < n; index++) {
      const key = sessionIds[index] ?? `__unknown_${index}`;
      const block = bySession.get(key);
      if (block === undefined) bySession.set(key, [index]);
      else block.push(index);
    }
    return { blocks: [...bySession.values()], kind: "session" };
  }
  const length = Math.max(1, Math.round(Math.cbrt(n)));
  const blocks = [];
  for (let start = 0; start < n; start += length) {
    const block = [];
    for (let offset = 0; offset < length; offset++) {
      block.push((start + offset) % n); // circular: every index gets equal weight
    }
    blocks.push(block);
  }
  return { blocks, kind: `circular(${length})` };
}

/**
 * Paired block bootstrap on the per-call difference (candidate - baseline).
 *
 * Returns the mean difference and a percentile 95% confidence interval. The
 * adoption rule is `ciUpper < 0`: the candidate must be better than the
 * incumbent across essentially every resampling of the held-out data, not
 * merely better on average.
 *
 * This is the repo's adoption statistic. It lives here rather than in one
 * script because a probe that graded with the 5-fold paired t while the eval
 * graded with this would report a different verdict on the same effect --
 * which is exactly the failure documented in STATE-OF-PLAY §7.1.
 */
export function blockBootstrapDifference(differences, sessionIds) {
  const n = differences.length;
  if (n === 0) {
    return {
      n: 0,
      meanDifference: 0,
      ciLower: 0,
      ciUpper: 0,
      blocks: 0,
      blockKind: "none",
    };
  }
  const observedMean = differences.reduce((sum, value) => sum + value, 0) / n;
  const { blocks, kind } = bootstrapBlocks(sessionIds);
  const random = mulberry32(BOOTSTRAP_SEED);
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let replicate = 0; replicate < BOOTSTRAP_RESAMPLES; replicate++) {
    let total = 0;
    let count = 0;
    // Resample as many blocks as there are, with replacement, so a replicate is
    // the same size as the original series up to block-length variation.
    for (let drawn = 0; drawn < blocks.length; drawn++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      for (const index of block) {
        total += differences[index];
        count++;
      }
    }
    means[replicate] = count === 0 ? 0 : total / count;
  }
  const sorted = Float64Array.from(means).sort();
  const at = (probability) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.round(probability * (sorted.length - 1))),
      )
    ];
  return {
    n,
    meanDifference: observedMean,
    ciLower: at(0.025),
    ciUpper: at(0.975),
    blocks: blocks.length,
    blockKind: kind,
    resamples: BOOTSTRAP_RESAMPLES,
  };
}

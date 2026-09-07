/**
 * The base text head: three quantile ensembles trained on public agent-chat
 * turns, reading a prompt through a hashed n-gram projection.
 *
 * `baseTextHead(text)` returns `[p50, p90, p99]` on the `log1p(tokens)` scale,
 * which is the scale the trainer fitted and the scale the boost feature vector
 * wants. It is a pure function of the string: nothing is stored, nothing is
 * logged, and the asset it walks contains no text — only a projection indexed
 * by hash bucket and trees that split on projected components.
 *
 * The feature form is defined once, in
 * `experiments/evaluation/semantic/text_hash.py`, and mirrored here:
 *
 *   1. first `truncateChars` UTF-16 code units, lowercased;
 *   2. tokens `[\p{L}\p{N}_][\p{L}\p{N}_./-]*`, the same pattern the ingest
 *      loader's `semanticHashFeatures` uses;
 *   3. terms `u:<w>` and `b:<w1> <w2>`;
 *   4. FNV-1a 32-bit over UTF-16 code units, exactly `fnv1a` in boosted.ts;
 *   5. bucket = hash % 2^bits, sign = -1 when bit 31 is set;
 *   6. feature = sign(count) * log1p(|count|).
 *
 * `base-text-head.test.ts` holds a committed fixture of synthetic prompts with
 * the Python evaluator's outputs; the two must agree to 1e-6.
 *
 * This module is the pure half: the feature form, the asset types and
 * `createBaseTextHead(asset)`, and NOTHING that imports the 1.2 MB asset. The
 * shipped head lives behind the package's `./text-head` subpath, so the main
 * entry — which every extension, companion and status-line build pulls — does
 * not carry an asset the turn-total correction never reads.
 */

export interface BaseTextHeadLeaf {
  value: number;
}

export interface BaseTextHeadSplit {
  feature: number;
  threshold: number;
  left: BaseTextHeadNode;
  right: BaseTextHeadNode;
}

export type BaseTextHeadNode = BaseTextHeadLeaf | BaseTextHeadSplit;

export interface BaseTextHeadQuantile {
  quantile: number;
  baseline: number;
  trees: BaseTextHeadNode[];
}

export interface BaseTextHeadProjection {
  /** `int16-base64-le` carries `data`; `int16-rows` carries `rows`. */
  encoding: "int16-base64-le" | "int16-rows";
  layout: "bucket-major";
  scale: number;
  data?: string;
  rows?: number[][];
}

export interface BaseTextHeadAsset {
  version: string;
  dataset: string;
  trainingRows: number;
  bits: number;
  dims: number;
  truncateChars: number;
  svd: BaseTextHeadProjection;
  heads: BaseTextHeadQuantile[];
}

/**
 * The feature form's own constants, mirroring `text_hash.py`: the truncation
 * limit is a property of the form, and 13 bits is the size the shipped asset
 * was trained at. They are literals rather than reads off the asset so this
 * module stays asset-free; `base-text-head.test.ts` holds both against the
 * shipped asset so a retrain at another size cannot drift silently.
 */
const DEFAULT_HASH_BITS = 13;
const DEFAULT_TRUNCATE_CHARS = 2000;

const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;
const CH_U = 0x75; // "u"
const CH_B = 0x62; // "b"
const CH_COLON = 0x3a; // ":"
const CH_SPACE = 0x20; // " "

const TOKEN_PATTERN = /[\p{L}\p{N}_][\p{L}\p{N}_./-]*/gu;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/** Little-endian int16 out of base64, without depending on `atob` or `Buffer`. */
function decodeInt16Base64(data: string): Int16Array {
  let length = data.length;
  while (length > 0 && data.charCodeAt(length - 1) === 0x3d) length--; // "="
  const bytes = Math.floor((length * 3) / 4);
  const out = new Int16Array(bytes >> 1);
  let accumulator = 0;
  let bits = 0;
  let byteIndex = 0;
  let pending = 0;
  for (let index = 0; index < length; index++) {
    const code = data.charCodeAt(index);
    const value = code < 128 ? BASE64_REVERSE[code] ?? -1 : -1;
    if (value < 0) throw new Error("base-text-head: malformed base64 projection");
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (accumulator >> bits) & 0xff;
      if ((byteIndex & 1) === 0) pending = byte;
      else {
        const word = pending | (byte << 8);
        out[byteIndex >> 1] = word >= 0x8000 ? word - 0x10000 : word;
      }
      byteIndex++;
    }
  }
  return out;
}

interface HeadBuffers {
  bits: number;
  dims: number;
  mask: number;
  truncateChars: number;
  /** Dequantised projection, bucket-major: bucket `j`, component `k` at `j*dims+k`. */
  projection: Float64Array;
  heads: BaseTextHeadQuantile[];
  counts: Float64Array;
  marks: Int32Array;
  touched: Int32Array;
  components: Float64Array;
  generation: number;
}

function compile(asset: BaseTextHeadAsset): HeadBuffers {
  const buckets = 1 << asset.bits;
  const dims = asset.dims;
  const scale = asset.svd.scale;
  let quantised: Int16Array;
  if (asset.svd.encoding === "int16-base64-le") {
    if (asset.svd.data === undefined) {
      throw new Error("base-text-head: base64 projection missing `data`");
    }
    quantised = decodeInt16Base64(asset.svd.data);
  } else {
    const rows = asset.svd.rows;
    if (rows === undefined) {
      throw new Error("base-text-head: row projection missing `rows`");
    }
    quantised = new Int16Array(buckets * dims);
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j] as number[];
      for (let k = 0; k < dims; k++) quantised[j * dims + k] = row[k] as number;
    }
  }
  if (quantised.length !== buckets * dims) {
    throw new Error(
      `base-text-head: projection is ${quantised.length} values, expected ${buckets * dims}`,
    );
  }
  const projection = new Float64Array(buckets * dims);
  for (let index = 0; index < projection.length; index++) {
    projection[index] = (quantised[index] as number) * scale;
  }
  return {
    bits: asset.bits,
    dims,
    mask: buckets - 1,
    truncateChars: asset.truncateChars,
    projection,
    heads: asset.heads,
    counts: new Float64Array(buckets),
    marks: new Int32Array(buckets),
    touched: new Int32Array(4096),
    components: new Float64Array(dims),
    generation: 0,
  };
}

function nodeValue(node: BaseTextHeadNode, features: Float64Array): number {
  let current = node;
  while ("feature" in current) {
    current =
      (features[current.feature] as number) <= current.threshold
        ? current.left
        : current.right;
  }
  return current.value;
}

/**
 * Walk the terms of one already-truncated, already-lowercased string, handing
 * each term's unsigned 32-bit FNV-1a hash to `visit`. Terms come out
 * interleaved — the unigram for word i, then the bigram (i-1, i) — and no
 * substring is ever cut: the hash runs straight over the source's code units.
 */
function forEachTermHash(source: string, visit: (hash: number) => void): void {
  TOKEN_PATTERN.lastIndex = 0;
  let previousStart = -1;
  let previousEnd = -1;
  for (;;) {
    const match = TOKEN_PATTERN.exec(source);
    if (match === null) break;
    const start = match.index;
    const end = start + match[0].length;

    let hash = FNV_OFFSET;
    hash = Math.imul(hash ^ CH_U, FNV_PRIME);
    hash = Math.imul(hash ^ CH_COLON, FNV_PRIME);
    for (let i = start; i < end; i++) {
      hash = Math.imul(hash ^ source.charCodeAt(i), FNV_PRIME);
    }
    visit(hash >>> 0);

    if (previousStart >= 0) {
      let bigram = FNV_OFFSET;
      bigram = Math.imul(bigram ^ CH_B, FNV_PRIME);
      bigram = Math.imul(bigram ^ CH_COLON, FNV_PRIME);
      for (let i = previousStart; i < previousEnd; i++) {
        bigram = Math.imul(bigram ^ source.charCodeAt(i), FNV_PRIME);
      }
      bigram = Math.imul(bigram ^ CH_SPACE, FNV_PRIME);
      for (let i = start; i < end; i++) {
        bigram = Math.imul(bigram ^ source.charCodeAt(i), FNV_PRIME);
      }
      visit(bigram >>> 0);
    }
    previousStart = start;
    previousEnd = end;
  }
}

/** `text.slice(0, limit).toLowerCase()`, the head's first step. */
function normalise(text: string, limit: number): string {
  return (text.length > limit ? text.slice(0, limit) : text).toLowerCase();
}

/**
 * The hasher on its own, for the parity test: one `{bucket, sign}` per term, in
 * the order `forEachTermHash` emits them.
 */
export function baseTextHashTerms(
  text: string,
  bits: number = DEFAULT_HASH_BITS,
  truncateChars: number = DEFAULT_TRUNCATE_CHARS,
): { bucket: number; sign: number }[] {
  const mask = (1 << bits) - 1;
  const out: { bucket: number; sign: number }[] = [];
  forEachTermHash(normalise(text, truncateChars), (hash) => {
    out.push({ bucket: hash & mask, sign: hash & 0x80000000 ? -1 : 1 });
  });
  return out;
}

/**
 * Bind an asset to its scratch buffers and return the evaluator over it. The
 * shipped head is one of these; tests build others to exercise the asset
 * contract without a 1 MB fixture.
 */
export function createBaseTextHead(
  asset: BaseTextHeadAsset,
): (text: string) => [number, number, number] {
  const head = compile(asset);
  return (text: string) => evaluate(head, text);
}

/**
 * Three `log1p(tokens)` quantiles for one prompt, clamped monotone.
 *
 * Allocation per call is the truncated lowercase copy of the string, one
 * closure and the three-number result; the hash buffers, the projection and
 * the scratch component vector are allocated once for the process.
 */
function evaluate(head: HeadBuffers, text: string): [number, number, number] {
  const source = normalise(text, head.truncateChars);

  // Generations let the count buffer be reused without clearing 2^bits doubles
  // on every call: a bucket whose mark is stale reads as zero.
  head.generation = head.generation === 0x7fffffff ? 1 : head.generation + 1;
  const generation = head.generation;
  if (generation === 1) head.marks.fill(0);

  const counts = head.counts;
  const marks = head.marks;
  const mask = head.mask;
  let touched = head.touched;
  let touchedCount = 0;

  forEachTermHash(source, (hash) => {
    const bucket = hash & mask;
    if (marks[bucket] !== generation) {
      marks[bucket] = generation;
      counts[bucket] = 0;
      if (touchedCount === touched.length) {
        const grown = new Int32Array(touched.length * 2);
        grown.set(touched);
        head.touched = touched = grown;
      }
      touched[touchedCount++] = bucket;
    }
    counts[bucket] = (counts[bucket] as number) + (hash & 0x80000000 ? -1 : 1);
  });

  // Ascending bucket order, so the accumulation sequence — and therefore the
  // floating-point result — is the one the Python reference produces.
  const order = touched.subarray(0, touchedCount);
  order.sort();

  const dims = head.dims;
  const components = head.components;
  components.fill(0);
  const projection = head.projection;
  for (let index = 0; index < touchedCount; index++) {
    const bucket = order[index] as number;
    const count = counts[bucket] as number;
    if (count === 0) continue;
    const value = count < 0 ? -Math.log1p(-count) : Math.log1p(count);
    const offset = bucket * dims;
    for (let k = 0; k < dims; k++) {
      components[k] =
        (components[k] as number) + value * (projection[offset + k] as number);
    }
  }

  const heads = head.heads;
  const out: [number, number, number] = [0, 0, 0];
  for (let q = 0; q < 3; q++) {
    const ensemble = heads[q] as BaseTextHeadQuantile;
    let total = ensemble.baseline;
    const trees = ensemble.trees;
    for (let t = 0; t < trees.length; t++) {
      total += nodeValue(trees[t] as BaseTextHeadNode, components);
    }
    out[q] = total;
  }
  // The three ensembles are fitted independently, so nothing in training makes
  // them ordered; the clamp is what guarantees p50 <= p90 <= p99, and the
  // Python reference clamps identically.
  if (out[1] < out[0]) out[1] = out[0];
  if (out[2] < out[1]) out[2] = out[1];
  return out;
}


/**
 * The shipped base text head, bound to its asset.
 *
 * This is the only module that imports `base-text-head-asset.ts` — 1.2 MB of
 * quantised projection and trees. It is deliberately NOT reachable from the
 * package's main entry: the turn-total correction that ships today is a schema
 * v2 profile whose trees never index past 37, so it reads no head column, and
 * every extension, companion and status-line bundle would otherwise carry the
 * asset for nothing. Callers that actually want the head import it explicitly:
 *
 *     import { baseTextHead } from "@token-forecaster/predictor/text-head";
 *
 * The pure half — the feature form, the asset types, `createBaseTextHead` —
 * lives in `../base-text-head.ts` and is re-exported here so a caller of this
 * subpath needs only one import.
 */

import { createBaseTextHead } from "../base-text-head.js";
import { BASE_TEXT_HEAD_ASSET } from "./base-text-head-asset.js";

export { BASE_TEXT_HEAD_ASSET };

/** The asset the shipped head evaluates, e.g. `...-b13k48-2026-09-02`. */
export const BASE_TEXT_HEAD_VERSION = BASE_TEXT_HEAD_ASSET.version;

let shipped: ((text: string) => [number, number, number]) | null = null;

/**
 * The shipped head: `[p50, p90, p99]` on the `log1p(tokens)` scale.
 *
 * Compilation of the asset — decoding the projection and dequantising it — is
 * deferred to the first call and then cached, so importing this module is cheap
 * even though evaluating it once is not.
 */
export function baseTextHead(text: string): [number, number, number] {
  return (shipped ??= createBaseTextHead(BASE_TEXT_HEAD_ASSET))(text);
}

export { baseTextHashTerms, createBaseTextHead } from "../base-text-head.js";
export type {
  BaseTextHeadAsset,
  BaseTextHeadLeaf,
  BaseTextHeadNode,
  BaseTextHeadProjection,
  BaseTextHeadQuantile,
  BaseTextHeadSplit,
} from "../base-text-head.js";

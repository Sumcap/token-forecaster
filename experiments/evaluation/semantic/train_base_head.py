#!/usr/bin/env python3
"""
Train the SHIPPED base text head and export it as a portable asset.

    python3 experiments/evaluation/semantic/train_base_head.py \\
        --public experiments/datasets/public/github-agent-chats/turns.jsonl \\
        --bits 13 --dims 48 \\
        --out packages/predictor/src/text-head/base-text-head.json

The head is text-only, because `baseTextHead(text)` in the predictor package
takes a string and nothing else:

    hashed unigrams+bigrams (text_hash.py)  ->  TruncatedSVD(dims)
      ->  three HistGradientBoostingRegressor(loss="quantile") on log1p(total)

trained on EVERY row of the public corpus (no folds -- the folds were Step 0's
job, this is the final fit).  Learner settings are copied verbatim from
probe_semantic_scale.py so the exported head is the head Step 0 graded.

The export carries no text: a quantised projection matrix and three ensembles of
`{feature, threshold, left, right}` / `{value}` nodes in the shape
packages/predictor/src/boosted.ts already walks, with sklearn's learning rate
already folded into the leaf values, so evaluation is `baseline + sum(tree(x))`.

`--ts-out` additionally writes the TypeScript module the package actually
imports; the repo's tsconfig has no `resolveJsonModule` and the published
package ships `dist` only, so the asset is inlined into a `.ts` file exactly the
way `bundled-profile.ts` is.
"""

import argparse
import base64
import json
import os
import sys
import time
import warnings

import numpy as np

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import text_hash  # noqa: E402
from sklearn.decomposition import TruncatedSVD  # noqa: E402
from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: E402

Q = [0.5, 0.9, 0.99]
INT16_MAX = 32767


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_rows(path):
    rows = [json.loads(line) for line in open(path)]
    rows = [r for r in rows if r.get("text")]
    y = np.array([r["total"] for r in rows], float)
    return [r["text"] for r in rows], y


# --------------------------------------------------------------------- export


def tree_from_nodes(nodes):
    """sklearn's flat node array -> the predictor's nested node shape."""

    def build(i):
        node = nodes[i]
        if node["is_leaf"]:
            return {"value": float(node["value"])}
        return {
            "feature": int(node["feature_idx"]),
            "threshold": float(node["num_threshold"]),
            "left": build(int(node["left"])),
            "right": build(int(node["right"])),
        }

    return build(0)


def walk(node, x):
    while "value" not in node:
        node = node["left"] if x[node["feature"]] <= node["threshold"] else node["right"]
    return node["value"]


def quantise(components):
    """
    components: (dims, 2**bits) from TruncatedSVD.  Stored BUCKET-MAJOR, i.e.
    the transpose flattened row by row, because the evaluator walks the handful
    of non-zero buckets in a document and adds `value * row` for each.
    """
    flat = np.ascontiguousarray(components.T, dtype=np.float64).ravel()
    peak = float(np.abs(flat).max())
    scale = peak / INT16_MAX if peak > 0 else 1.0
    q = np.rint(flat / scale).astype(np.int64)
    q = np.clip(q, -INT16_MAX, INT16_MAX).astype(np.int16)
    return q, scale


def encode_svd(q, scale, dims):
    """Both encodings the plan allows; the smaller valid JSON wins."""
    b64 = {
        "encoding": "int16-base64-le",
        "layout": "bucket-major",
        "scale": scale,
        "data": base64.b64encode(q.astype("<i2").tobytes()).decode("ascii"),
    }
    rows = {
        "encoding": "int16-rows",
        "layout": "bucket-major",
        "scale": scale,
        "rows": q.reshape(-1, dims).tolist(),
    }
    size_b64 = len(json.dumps(b64, separators=(",", ":")))
    size_rows = len(json.dumps(rows, separators=(",", ":")))
    log(f"  svd encoding: base64 {size_b64:,}B vs nested rows {size_rows:,}B")
    return (b64 if size_b64 <= size_rows else rows), min(size_b64, size_rows)


TS_HEADER = """// GENERATED FILE -- do not edit by hand.
//
// Regenerate with:
//   python3 experiments/evaluation/semantic/train_base_head.py \\
//     --public experiments/datasets/public/github-agent-chats/turns.jsonl \\
//     --bits {bits} --dims {dims} \\
//     --out packages/predictor/src/text-head/base-text-head.json
//
// A quantised SVD projection and three quantile tree ensembles trained on
// {rows} public agent-chat turns. No prompt text is present: the projection is
// indexed by hash bucket and the trees split on projected components.
//
// Inlined the way bundled-profile.ts is, because tsconfig.base.json has no
// `resolveJsonModule` and the package publishes `dist` only.
import type {{ BaseTextHeadAsset }} from "../base-text-head.js";

export const BASE_TEXT_HEAD_ASSET: BaseTextHeadAsset =
"""


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--public", required=True)
    ap.add_argument("--bits", type=int, required=True)
    ap.add_argument("--dims", type=int, required=True)
    ap.add_argument("--out", required=True, help="JSON asset path")
    ap.add_argument(
        "--ts-out",
        default=None,
        help="TypeScript module to inline the asset into "
        "(default: <out dir>/base-text-head-asset.ts)",
    )
    ap.add_argument("--max-iter", type=int, default=150)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--max-depth", type=int, default=3)
    ap.add_argument("--min-samples-leaf", type=int, default=40)
    ap.add_argument("--l2", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    dataset = os.path.basename(os.path.dirname(os.path.abspath(a.public)))
    texts, y = load_rows(a.public)
    log(f"{len(texts)} public turns from {dataset}")

    t0 = time.time()
    H = text_hash.hashed_matrix(text_hash.hash_documents(texts), a.bits)
    log(f"  hashed: {H.nnz / H.shape[0]:.0f} non-zero buckets/doc ({time.time() - t0:.0f}s)")

    svd = TruncatedSVD(a.dims, random_state=0).fit(H)
    S = svd.transform(H)
    assert np.isfinite(S).all(), "SVD features must never be NaN (no missing-value path)"
    log(f"  SVD({a.dims}) evr={svd.explained_variance_ratio_.sum():.3f} ({time.time() - t0:.0f}s)")

    q, scale = quantise(svd.components_)
    deq = (q.astype(np.float64) * scale).reshape(1 << a.bits, a.dims)

    heads = []
    target = np.log1p(y)
    for p in Q:
        model = HistGradientBoostingRegressor(
            loss="quantile",
            quantile=p,
            max_iter=a.max_iter,
            learning_rate=a.learning_rate,
            max_depth=a.max_depth,
            min_samples_leaf=a.min_samples_leaf,
            l2_regularization=a.l2,
            random_state=a.seed,
        ).fit(S, target)
        baseline = float(np.ravel(model._baseline_prediction)[0])
        trees = [tree_from_nodes(pr[0].nodes) for pr in model._predictors]
        # sklearn folds the learning rate into leaf values at fit time; prove it
        # rather than assume it, on a sample of the training rows.
        probe = S[:: max(1, len(S) // 500)]
        mine = np.array([baseline + sum(walk(t, x) for t in trees) for x in probe])
        gap = float(np.abs(mine - model.predict(probe)).max())
        assert gap < 1e-9, f"tree export does not reproduce sklearn (max gap {gap})"
        heads.append({"quantile": p, "baseline": baseline, "trees": trees})
        log(f"  q={p}: {len(trees)} trees, export gap {gap:.2e} ({time.time() - t0:.0f}s)")

    svd_block, svd_bytes = encode_svd(q, scale, a.dims)
    asset = {
        "version": f"base-text-head-{dataset}-b{a.bits}k{a.dims}-"
        f"{time.strftime('%Y-%m-%d', time.gmtime())}",
        "dataset": dataset,
        "trainingRows": len(texts),
        "bits": a.bits,
        "dims": a.dims,
        "truncateChars": text_hash.TRUNCATE_CHARS,
        "svd": svd_block,
        "heads": heads,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    text = json.dumps(asset, separators=(",", ":"))
    with open(a.out, "w") as fh:
        fh.write(text)
    log(f"wrote {a.out} ({len(text):,} bytes; svd block {svd_bytes:,})")

    ts_out = a.ts_out or os.path.join(
        os.path.dirname(os.path.abspath(a.out)), "base-text-head-asset.ts"
    )
    with open(ts_out, "w") as fh:
        fh.write(
            TS_HEADER.format(bits=a.bits, dims=a.dims, rows=f"{len(texts):,}")
            + text
            + ";\n"
        )
    log(f"wrote {ts_out} ({os.path.getsize(ts_out):,} bytes)")

    # What the quantisation costs, in log space, on a sample of training rows.
    from base_head_eval import evaluate  # noqa: E402  (sibling module)

    rng = np.random.default_rng(0)
    sample = rng.choice(len(texts), size=min(400, len(texts)), replace=False)
    worst = 0.0
    for i in sample:
        got = evaluate(asset, texts[i], _dequantised=deq)
        want = [h["baseline"] + sum(walk(t, S[i]) for t in h["trees"]) for h in heads]
        want[1] = max(want[0], want[1])
        want[2] = max(want[1], want[2])
        worst = max(worst, max(abs(g - w) for g, w in zip(got, want)))
    log(f"quantisation cost on {len(sample)} training rows: max |d log1p| = {worst:.2e}")


if __name__ == "__main__":
    main()

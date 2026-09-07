#!/usr/bin/env python3
"""
The Python reference evaluator for the exported base-text-head asset.

This is the other half of the parity contract: it reads the SAME quantised
asset the TypeScript evaluator reads and walks it in the SAME order, so the two
sides differ only by floating-point rounding -- and, because every step is a
plain IEEE multiply-add in the same sequence, in practice not even by that.

Used by train_base_head.py (to price the quantisation) and by
make_parity_fixture.py (to produce the committed expectations).
"""

import base64
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text_hash  # noqa: E402


def load_asset(path):
    with open(path) as fh:
        return json.load(fh)


def dequantise(asset):
    """(2**bits, dims) float64 projection rows, bucket-major."""
    svd = asset["svd"]
    dims = asset["dims"]
    if svd["encoding"] == "int16-base64-le":
        raw = np.frombuffer(base64.b64decode(svd["data"]), dtype="<i2")
    elif svd["encoding"] == "int16-rows":
        raw = np.asarray(svd["rows"], dtype=np.int16).ravel()
    else:
        raise ValueError(f"unknown svd encoding {svd['encoding']}")
    return raw.astype(np.float64).reshape(1 << asset["bits"], dims) * float(svd["scale"])


def project(asset, text, deq):
    hashes = text_hash.document_hashes(text, asset["truncateChars"])
    buckets, values = text_hash.document_features(hashes, asset["bits"])
    proj = np.zeros(asset["dims"], dtype=np.float64)
    for bucket, value in zip(buckets, values):
        proj += value * deq[bucket]
    return proj


def walk(node, x):
    while "value" not in node:
        node = node["left"] if x[node["feature"]] <= node["threshold"] else node["right"]
    return node["value"]


def evaluate(asset, text, _dequantised=None):
    """Three log1p quantiles, clamped monotone p50 <= p90 <= p99."""
    deq = dequantise(asset) if _dequantised is None else _dequantised
    x = project(asset, text, deq)
    out = []
    for head in asset["heads"]:
        value = head["baseline"]
        for tree in head["trees"]:
            value += walk(tree, x)
        out.append(value)
    out[1] = max(out[0], out[1])
    out[2] = max(out[1], out[2])
    return out

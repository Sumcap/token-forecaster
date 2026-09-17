#!/usr/bin/env python3
"""
The hashed text feature form, defined ONCE so the Python trainer and the
TypeScript evaluator (`packages/predictor/src/base-text-head.ts`) agree bit for
bit.  Nothing here reads or writes prompt text; callers pass strings in and get
numbers out.

The form, restated from docs/SEMANTIC-PLAN.md:

1. Truncate to the first 2,000 UTF-16 code units.  Step B truncated the same
   way for the embedding probes; the head does it too, so a 40 kB pasted log
   cannot dominate the projection and so the cost per call is bounded.
2. Lowercase, then tokenise with `[\\p{L}\\p{N}_][\\p{L}\\p{N}_./-]*`, the same
   pattern `semanticHashFeatures` uses in packages/ingest-claude/load-history.mjs.
3. Terms are unigrams `u:<w>` and bigrams `b:<w1> <w2>`.
4. FNV-1a, 32 bit, over UTF-16 CODE UNITS -- JavaScript's `charCodeAt`, which is
   why Python walks `term.encode("utf-16-le")` two bytes at a time rather than
   iterating code points.
5. bucket = hash % 2**bits; sign = -1 when bit 31 is set, else +1; signed counts
   accumulate per bucket.
6. The feature is `sign(count) * log1p(abs(count))`.

`document_hashes` returns the raw 32-bit term hashes for one document so a sweep
over several `bits` values tokenises and hashes only once.
"""

import numpy as np
import regex

TRUNCATE_CHARS = 2000
TOKEN_RE = regex.compile(r"[\p{L}\p{N}_][\p{L}\p{N}_./-]*")

_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193
_MASK = 0xFFFFFFFF


def fnv1a(term: str) -> int:
    """FNV-1a over UTF-16 code units, matching `charCodeAt` in boosted.ts."""
    h = _FNV_OFFSET
    for unit in memoryview(term.encode("utf-16-le", "surrogatepass")).cast("H"):
        h = ((h ^ unit) * _FNV_PRIME) & _MASK
    return h


def truncate_utf16(text: str, limit: int = TRUNCATE_CHARS) -> str:
    """`text.slice(0, limit)` in JavaScript terms: code UNITS, not code points."""
    raw = text.encode("utf-16-le", "surrogatepass")
    if len(raw) <= 2 * limit:
        return text
    head = raw[: 2 * limit]
    try:
        return head.decode("utf-16-le")
    except UnicodeDecodeError:
        # The cut landed between the halves of a surrogate pair; drop the half.
        return head[:-2].decode("utf-16-le")


def tokenize(text: str, truncate: int = TRUNCATE_CHARS):
    return TOKEN_RE.findall(truncate_utf16(text, truncate).lower())


_UNI_CACHE: dict = {}


def document_hashes(text: str, truncate: int = TRUNCATE_CHARS) -> np.ndarray:
    """Raw 32-bit FNV-1a hashes of every term in one document, unigrams first."""
    words = tokenize(text, truncate)
    n = len(words)
    if n == 0:
        return np.zeros(0, np.uint32)
    out = np.empty(2 * n - 1, np.uint32)
    cache = _UNI_CACHE
    for i, w in enumerate(words):
        h = cache.get(w)
        if h is None:
            h = cache[w] = fnv1a("u:" + w)
        out[i] = h
    prev = words[0]
    for i in range(1, n):
        w = words[i]
        out[n + i - 1] = fnv1a("b:" + prev + " " + w)
        prev = w
    return out


def buckets_and_signs(hashes: np.ndarray, bits: int):
    mask = np.uint32((1 << bits) - 1)
    idx = (hashes & mask).astype(np.int64)
    sign = np.where((hashes >> np.uint32(31)) != 0, -1.0, 1.0)
    return idx, sign


def document_features(hashes: np.ndarray, bits: int):
    """(bucket indices, values) for one document, sorted by bucket, zeros dropped."""
    if hashes.size == 0:
        return np.zeros(0, np.int64), np.zeros(0, np.float64)
    idx, sign = buckets_and_signs(hashes, bits)
    order = np.argsort(idx, kind="stable")
    idx, sign = idx[order], sign[order]
    starts = np.flatnonzero(np.concatenate(([True], idx[1:] != idx[:-1])))
    uniq = idx[starts]
    total = np.add.reduceat(sign, starts)
    keep = total != 0
    uniq, total = uniq[keep], total[keep]
    return uniq, np.sign(total) * np.log1p(np.abs(total))


def hashed_matrix(hash_lists, bits: int):
    """CSR matrix of the signed log1p counts for a list of documents."""
    from scipy import sparse

    indptr = np.zeros(len(hash_lists) + 1, np.int64)
    cols, vals = [], []
    for i, h in enumerate(hash_lists):
        c, v = document_features(h, bits)
        cols.append(c)
        vals.append(v)
        indptr[i + 1] = indptr[i] + c.size
    indices = np.concatenate(cols) if cols else np.zeros(0, np.int64)
    data = np.concatenate(vals) if vals else np.zeros(0, np.float64)
    return sparse.csr_matrix(
        (data.astype(np.float32), indices.astype(np.int32), indptr.astype(np.int64)),
        shape=(len(hash_lists), 1 << bits),
    )


def hash_documents(texts, truncate: int = TRUNCATE_CHARS):
    return [document_hashes(t, truncate) for t in texts]

#!/usr/bin/env python3
"""
Schema check and shape report for any turns.jsonl in the semantic-probe schema.

    python3 experiments/evaluation/semantic/validate.py <turns.jsonl>

Asserts the schema every probe in this directory assumes -- required fields,
non-empty text, positive totals, a 38-length feature vector -- and prints the
counts, the token source, the session-group count, the per-tool counts, and the
same length-bucket median/p90 table `inspect_terms.py` prints, so a public
corpus can be compared to the local one without either text leaving the box.

Exits non-zero on the first schema violation, listing up to 10 offending rows
by `turnRootId` only. It never prints prompt text.
"""
from __future__ import annotations

import json
import sys
from collections import Counter

import numpy as np

REQUIRED = {
    "turnRootId": str,
    "sessionId": str,
    "firstMs": int,
    "total": int,
    "calls": int,
    "openerTokens": int,
    "model": str,
    "thinking": str,
    "text": str,
}


def main(path: str) -> int:
    rows = []
    with open(path) as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as err:
                print(f"FAIL line {number}: not JSON ({err})")
                return 1
    if not rows:
        print("FAIL: no rows")
        return 1

    problems: list[str] = []

    def note(row, message):
        if len(problems) < 10:
            problems.append(f"{row.get('turnRootId', '?')}: {message}")

    for row in rows:
        for field, kind in REQUIRED.items():
            if field not in row:
                note(row, f"missing {field}")
            elif not isinstance(row[field], kind) or isinstance(row[field], bool):
                note(row, f"{field} is {type(row[field]).__name__}, want {kind.__name__}")
        if "command" not in row:
            note(row, "missing command")
        if isinstance(row.get("text"), str) and not row["text"].strip():
            note(row, "empty text")
        if isinstance(row.get("total"), int) and row["total"] <= 0:
            note(row, f"total={row['total']} is not positive")
        if isinstance(row.get("calls"), int) and row["calls"] <= 0:
            note(row, f"calls={row['calls']} is not positive")
        if isinstance(row.get("openerTokens"), int) and row["openerTokens"] < 0:
            note(row, "openerTokens negative")
        features = row.get("features")
        if not isinstance(features, list) or len(features) != 38:
            note(row, f"features length {len(features) if isinstance(features, list) else 'missing'}, want 38")
        elif not all(isinstance(value, (int, float)) for value in features):
            note(row, "features contains a non-number")
        if row.get("thinking") not in ("yes", "no"):
            note(row, f"thinking={row.get('thinking')!r}")

    ids = Counter(row.get("turnRootId") for row in rows)
    duplicate = [key for key, count in ids.items() if count > 1]
    if duplicate:
        problems.append(f"{len(duplicate)} duplicate turnRootId (first: {duplicate[0]})")
    stamps = [row.get("firstMs") for row in rows if isinstance(row.get("firstMs"), int)]
    if stamps != sorted(stamps):
        problems.append("firstMs is not monotone in file order")

    if problems:
        print(f"FAIL: {len(problems)} problem(s) (first 10 shown)")
        for line in problems:
            print("  " + line)
        return 1

    total = np.array([row["total"] for row in rows], float)
    opener = np.array([row["openerTokens"] for row in rows], float)
    calls = np.array([row["calls"] for row in rows], float)
    text = [row["text"] for row in rows]

    print(f"OK  {len(rows)} turns  {path}")
    print(f"    sessions (groups) : {len({row['sessionId'] for row in rows})}")
    print(f"    token source      : {dict(Counter(row.get('tokenSource', '(unset)') for row in rows))}")
    print(f"    dataset           : {dict(Counter(row.get('dataset', '(unset)') for row in rows))}")
    print(f"    per tool          : {dict(Counter(row.get('tool', '(unset)') for row in rows).most_common())}")
    print(f"    licenses          : {dict(Counter(str(row.get('license')) for row in rows).most_common(12))}")
    print(f"    models (top 8)    : {dict(Counter(row['model'] for row in rows).most_common(8))}")
    print(
        f"    total tokens      : sum={total.sum():,.0f} median={np.median(total):,.0f} "
        f"p90={np.quantile(total, 0.9):,.0f} max={total.max():,.0f}"
    )
    print(
        f"    opener tokens     : median={np.median(opener):,.0f} p90={np.quantile(opener, 0.9):,.0f}"
    )
    print(f"    calls per turn    : median={np.median(calls):.0f} p90={np.quantile(calls, 0.9):.0f} max={calls.max():.0f}")
    print(f"    prompt chars      : median={np.median([len(t) for t in text]):,.0f} p90={np.quantile([len(t) for t in text], 0.9):,.0f}")

    lengths = np.array([len(t) for t in text])
    newlines = np.array([t.count("\n") for t in text])
    question = np.array([t.rstrip().endswith("?") for t in text])
    print()
    print("    length buckets (same table as inspect_terms.py)")
    for name, mask in [
        ("question mark", question),
        ("multi-line", newlines >= 2),
        ("len<80", lengths < 80),
        ("len 80-400", (lengths >= 80) & (lengths < 400)),
        ("len>=400", lengths >= 400),
    ]:
        if mask.sum() == 0:
            print(f"    {name:14s} n=   0")
            continue
        print(
            f"    {name:14s} n={mask.sum():5d} median total={np.median(total[mask]):7.0f} "
            f"p90={np.quantile(total[mask], .9):8.0f}"
        )
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: validate.py <turns.jsonl>")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))

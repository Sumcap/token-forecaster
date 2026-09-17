#!/usr/bin/env python3
"""Build a CODING slice and a matched NON-CODING control from WildChat-1M.

Non-agentic control for docs/SEMANTIC-PLAN.md Step A, source 2. Real human
prompts typed into a chat assistant, first human turn and first assistant
reply only, normalized to the schema written by
`experiments/evaluation/export-turn-text.mjs` (minus `features`, which a
separate featurizer adds).

The dataset is STREAMED: parquet shards are read row group by row group over
HTTP range requests, with column projection down to the fields we keep, so
nothing is downloaded whole and nothing is cached on disk. `datasets`
`streaming=True` hung on data-file resolution in this environment, so the
same streaming is done directly against the parquet footer index.

Output text is PROMPT TEXT: the two turns.jsonl files are gitignored and must
never be committed. Only the MANIFEST.md aggregates are.

Usage:
    python3 experiments/evaluation/semantic/build_wildchat_slice.py --cap 50000
    python3 experiments/evaluation/semantic/build_wildchat_slice.py --calibrate 4000
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.request
from pathlib import Path

REPO = "allenai/WildChat-1M"
REVISION = "main"
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/{REVISION}/"
API_TREE = f"https://huggingface.co/api/datasets/{REPO}/tree/{REVISION}/data"

COLUMNS = [
    "conversation_hash",
    "model",
    "timestamp",
    "language",
    "toxic",
    "redacted",
    "hashed_ip",
    "conversation.list.element.content",
    "conversation.list.element.role",
]

# ---------------------------------------------------------------------------
# The coding rule. Documented verbatim in both MANIFEST.md files.
# ---------------------------------------------------------------------------

# Tier 1 -- "strong": one hit is enough. Names of languages, runtimes, tools,
# libraries and formats, plus phrases that only occur when someone is asking
# for software.
STRONG = [
    r"python", r"javascript", r"typescript", r"\bjava\b", r"\bc\+\+\b", r"\bc#",
    r"\bgolang\b", r"\brust lang", r"\bkotlin\b", r"\bphp\b",
    r"\bruby\b", r"\bperl\b", r"\bhaskell\b", r"\bmatlab\b", r"\bswiftui\b",
    r"\br programming", r"\bvba\b", r"\bassembly language\b", r"\bobjective-c\b",
    r"\bdart\b", r"\blua\b", r"\bsolidity\b", r"\bverilog\b", r"\bvhdl\b",
    r"\bsql\b", r"\bmysql\b", r"\bpostgres", r"\bsqlite\b", r"\bmongodb\b",
    r"\bhtml\b", r"\bcss\b", r"\bxaml\b", r"\bjson\b", r"\byaml\b",
    r"\bbash\b", r"\bshell script", r"\bpowershell\b", r"\bcommand line\b",
    r"\bterminal\b", r"\bregex\b", r"\bregular expression",
    r"\breact\.?js\b", r"\breact native\b", r"\breact (?:component|hook|app)\b",
    r"\bangular\.?js\b", r"\bvue\.?js\b", r"\bnode\.?js\b", r"\bnext\.?js\b",
    r"\bjquery\b", r"\bbootstrap\b", r"\btailwind\b", r"\bflutter\b",
    r"\bdjango\b", r"\bflask\b", r"\bfastapi\b", r"\bspring boot\b", r"\blaravel\b",
    r"\bpandas\b", r"\bnumpy\b", r"\bmatplotlib\b", r"\bscikit-?learn\b",
    r"\btensorflow\b", r"\bpytorch\b", r"\bopencv\b", r"\bunity ?3d\b",
    r"\bgodot\b", r"\bpygame\b", r"\btkinter\b",
    r"\bnpm\b", r"\byarn\b", r"\bpip install\b", r"\bmaven\b", r"\bgradle\b",
    r"\bwebpack\b", r"\bvite\b", r"\bdocker\b", r"\bkubernetes\b", r"\bnginx\b",
    r"\bgithub\b", r"\bgit (?:commit|push|pull|clone|merge|rebase|branch|repo)",
    r"\bvisual studio\b", r"\bvs ?code\b", r"\bintellij\b", r"\bxcode\b",
    r"\bapi (?:call|endpoint|key|request|response)", r"\brest api\b", r"\bgraphql\b",
    r"\bwrite (?:me )?(?:a |the |some )?(?:program|code|script|function|class|query)",
    r"\bsource code\b", r"\bcode snippet\b", r"\bpseudo-?code\b",
    r"\bdebug(?:ging)?\b", r"\bstack trace\b", r"\btraceback\b",
    r"\bsyntax error\b", r"\bruntime error\b", r"\bcompil(?:e|er|ing|ation)\b",
    r"\bsegmentation fault\b", r"\bnull ?pointer\b", r"\bunit test",
    r"\bdata ?frame\b", r"\bstd::", r"\bconsole\.log\b", r"\bprintf\b",
    r"\bdef \w+\(", r"\bimport \w+", r"#include\b", r"</\w+>",
]

# Tier 2 -- "generic": everyday English words that also occur in programming.
# Two DISTINCT hits are required, because WildChat is full of fiction,
# role-play and essays where any one of these appears innocently
# ("class", "script", "error", "function", "character").
GENERIC = [
    r"\bfunction\b", r"\bvariable\b", r"\barray\b", r"\bloop\b",
    r"\bscript\b", r"\bimport(?:s|ed|ing)?\b", r"\bstring\b",
    r"\binteger\b", r"\bboolean\b", r"\bdatabase\b", r"\bquery\b",
    r"\bserver\b", r"\bsyntax\b", r"\bcode\b", r"\bcoding\b",
    r"\bprogram(?:ming)?\b", r"\bdeveloper\b", r"\bcompiler?\b",
    r"\bfile path\b", r"\bdirectory\b", r"\bplugin\b", r"\bbackend\b",
    r"\bfrontend\b", r"\bdebugger\b", r"\bcallback\b", r"\brecursion\b",
    r"\bbug(?:s|gy)?\b", r"\bfix(?:es|ed)? (?:this|the|my) (?:code|error|bug|issue)",
]

# Tier 3 -- "soft": words too common in essays, fiction and persona prompts to
# be evidence FOR coding, but strong enough that their presence disqualifies a
# row from the clean NON-coding control.
SOFT = [
    r"\bclass(?:es)?\b", r"\bmethod\b", r"\balgorithm\b", r"\berror\b",
    r"\blibrar(?:y|ies)\b", r"\bframework\b", r"\bparameter\b",
    r"\bargument\b", r"\bexception\b", r"\bfolder\b", r"\bsoftware\b",
    r"\bapp\b", r"\bapi\b", r"\bwebsite\b", r"\bdata ?base\b",
    r"\bcommand\b", r"\bterminal\b", r"\bcomputer\b", r"\bexcel\b",
    r"\bspreadsheet\b", r"\bformula\b", r"\bconfig", r"\binstall",
]

STRONG_RE = re.compile("|".join(STRONG), re.IGNORECASE)
SOFT_RES = [re.compile(p, re.IGNORECASE) for p in SOFT]
GENERIC_RES = [re.compile(p, re.IGNORECASE) for p in GENERIC]
FENCE_RE = re.compile(r"```")

# distinct tier-2 words required when there is no fence and no tier-1 hit
GENERIC_MIN = 3

# Non-coding rows are ~9x more common than coding rows. Without thinning, the
# control would fill its cap inside the first two shards while the coding
# slice spans all fourteen, so the two files would cover different slices of
# the stream. Keeping a seeded 12% of eligible non-coding rows makes both
# slices accrue at roughly the same rate over the same scan.
GENERAL_KEEP = 0.20


def coding_signals(prompt: str, reply: str) -> tuple[bool, int, int, int]:
    """Return (fenced, strong_hits, distinct_generic_hits).

    `fenced` looks at the prompt AND the reply (a fenced block in the reply is
    the assistant answering with code). Keyword tiers look at the PROMPT ONLY,
    so the label never depends on wording the model chose.
    """
    fenced = bool(FENCE_RE.search(prompt)) or bool(FENCE_RE.search(reply))
    strong = len(STRONG_RE.findall(prompt))
    generic = sum(1 for r in GENERIC_RES if r.search(prompt))
    soft = sum(1 for r in SOFT_RES if r.search(prompt))
    return fenced, strong, generic, soft


def classify(prompt: str, reply: str) -> str:
    """'coding' | 'general' | 'ambiguous'."""
    fenced, strong, generic, soft = coding_signals(prompt, reply)
    if fenced or strong >= 1 or generic >= GENERIC_MIN:
        return "coding"
    if generic == 0 and soft == 0:
        return "general"
    return "ambiguous"  # some technical smell but not enough: dropped


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------

def shard_urls() -> list[str]:
    with urllib.request.urlopen(API_TREE) as r:
        tree = json.loads(r.read().decode())
    names = sorted(x["path"] for x in tree if x["path"].endswith(".parquet"))
    return [BASE + n for n in names]


def iter_shard(url: str, start_rowgroup: int, batch_rows: int):
    """Yield (rowgroup_index, list_of_rows) streaming one row group at a time."""
    import fsspec
    import pyarrow.parquet as pq

    handle = fsspec.open(url).open()
    pf = pq.ParquetFile(handle)
    try:
        for rg in range(start_rowgroup, pf.num_row_groups):
            table = pf.read_row_group(rg, columns=COLUMNS)
            for batch in table.to_batches(max_chunksize=batch_rows):
                yield rg, batch.to_pylist()
    finally:
        handle.close()


def extract(row: dict, index: int) -> dict | None:
    """Cheap projection of a raw parquet row -> candidate record, or None."""
    if row.get("language") != "English":
        return None
    if row.get("toxic") or row.get("redacted"):
        return None
    conv = row.get("conversation") or []
    if len(conv) < 2:
        return None
    first, second = conv[0], conv[1]
    if first.get("role") != "user" or second.get("role") != "assistant":
        return None
    prompt = (first.get("content") or "").strip()
    reply = (second.get("content") or "").strip()
    if not prompt or not reply:
        return None
    ts = row.get("timestamp")
    first_ms = int(ts.timestamp() * 1000) if ts is not None else index
    conv_hash = row.get("conversation_hash") or ""
    session = row.get("hashed_ip") or (conv_hash[:8] if conv_hash else f"row{index}")
    return {
        "turnRootId": conv_hash,
        "sessionId": session,
        "firstMs": first_ms,
        "prompt": prompt,
        "reply": reply,
        "model": row.get("model"),
        "language": row.get("language"),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", type=int, default=50_000, help="max rows per slice")
    ap.add_argument("--out-dir", default="experiments/datasets/public")
    ap.add_argument("--seed", type=int, default=20260902)
    ap.add_argument("--buffer", type=int, default=10_000, help="shuffle buffer rows")
    ap.add_argument("--batch-rows", type=int, default=1024)
    ap.add_argument("--restart", action="store_true", help="ignore saved progress")
    ap.add_argument("--shards", default="all",
                    help="comma-separated positions in the seeded shard order, "
                         "or 'all'. Each worker writes its own part files, so "
                         "several positions can be built in parallel.")
    ap.add_argument("--merge", action="store_true",
                    help="concatenate the part files in shard order, cap the "
                         "coding slice and match the control to it")
    ap.add_argument("--calibrate", type=int, default=0,
                    help="scan N candidates, print rates only, write nothing")
    args = ap.parse_args()

    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")

    urls = shard_urls()
    rng = random.Random(args.seed)
    order = list(range(len(urls)))
    rng.shuffle(order)

    # ---- calibration mode -------------------------------------------------
    if args.calibrate:
        seen = kept = 0
        counts = {"coding": 0, "general": 0, "ambiguous": 0}
        fence_only = 0
        for rg, rows in iter_shard(urls[order[0]], 0, args.batch_rows):
            for i, row in enumerate(rows):
                seen += 1
                rec = extract(row, seen)
                if rec is None:
                    continue
                kept += 1
                label = classify(rec["prompt"], rec["reply"])
                counts[label] += 1
                f, s, g, sf = coding_signals(rec["prompt"], rec["reply"])
                if f and s == 0 and g < GENERIC_MIN:
                    fence_only += 1
                if kept >= args.calibrate:
                    break
            if kept >= args.calibrate:
                break
        print(f"scanned={seen} eligible={kept}")
        for k, v in counts.items():
            print(f"  {k:10s} {v:6d}  {100*v/max(kept,1):5.1f}% of eligible")
        print(f"  fence-only coding hits: {fence_only}")
        print(f"  eligible rate: {100*kept/max(seen,1):.1f}% of scanned")
        return 0

    out_root = Path(args.out_dir)
    parts_dir = out_root / "_parts"
    if args.merge:
        return merge(out_root, parts_dir, order, args)

    paths = {
        "coding": out_root / "wildchat-coding" / "turns.jsonl",
        "general": out_root / "wildchat-general" / "turns.jsonl",
    }
    for p in paths.values():
        p.parent.mkdir(parents=True, exist_ok=True)
    parts_dir.mkdir(parents=True, exist_ok=True)

    positions = (list(range(len(order))) if args.shards == "all"
                 else [int(x) for x in args.shards.split(",") if x != ""])
    started = time.time()
    totals = {"scanned": 0, "eligible": 0, "coding": 0, "general": 0,
              "ambiguous": 0, "general_seen": 0}

    for pos in positions:
        url = urls[order[pos]]
        part = {label: parts_dir / f"{label}.{pos:02d}.jsonl" for label in
                ("coding", "general")}
        state_path = parts_dir / f"state.{pos:02d}.json"
        # resume: a finished part is skipped, an unfinished one restarts
        if state_path.exists() and not args.restart:
            st = json.loads(state_path.read_text())
            if st.get("done") and st.get("seed") == args.seed:
                for k in totals:
                    totals[k] += st["counts"].get(k, 0)
                print(f"shard pos {pos}: already complete, skipped",
                      file=sys.stderr)
                continue
        counts = {"scanned": 0, "eligible": 0, "coding": 0, "general": 0,
                  "ambiguous": 0, "general_seen": 0}
        handles = {k: open(v, "w", encoding="utf-8") for k, v in part.items()}
        brng = random.Random((args.seed * 1_000_003) + pos)
        keep_rng = random.Random((args.seed ^ 0x5EED) + pos)
        buf: list[dict] = []

        def emit(rec: dict, label: str) -> None:
            reply_tokens = len(enc.encode(rec["reply"]))
            if reply_tokens <= 0:
                return
            out = {
                "turnRootId": rec["turnRootId"],
                "sessionId": rec["sessionId"],
                "firstMs": rec["firstMs"],
                "total": reply_tokens,
                "calls": 1,
                "openerTokens": reply_tokens,
                "model": rec["model"],
                "thinking": "no",
                "command": None,
                "text": rec["prompt"],
                "tokenSource": "tiktoken:o200k_base",
                "dataset": f"wildchat-{label}",
                "language": rec["language"],
            }
            handles[label].write(json.dumps(out, ensure_ascii=False) + "\n")
            counts[label] += 1

        def drain(rec: dict) -> None:
            label = classify(rec["prompt"], rec["reply"])
            if label == "ambiguous":
                counts["ambiguous"] += 1
                return
            if label == "general":
                counts["general_seen"] += 1
                if keep_rng.random() >= GENERAL_KEEP:
                    return
            emit(rec, label)

        try:
            for rg, rows in iter_shard(url, 0, args.batch_rows):
                for row in rows:
                    counts["scanned"] += 1
                    rec = extract(row, counts["scanned"])
                    if rec is None:
                        continue
                    counts["eligible"] += 1
                    if len(buf) < args.buffer:
                        buf.append(rec)
                        continue
                    j = brng.randrange(len(buf))
                    buf[j], rec = rec, buf[j]
                    drain(rec)
                if counts["scanned"] % 20000 < args.batch_rows:
                    print(f"[{time.time()-started:6.0f}s] pos {pos} rg {rg} "
                          f"scanned={counts['scanned']} coding={counts['coding']} "
                          f"general={counts['general']}", file=sys.stderr)
            brng.shuffle(buf)
            for rec in buf:
                drain(rec)
        finally:
            for h in handles.values():
                h.close()
        state_path.write_text(json.dumps({"done": True, "seed": args.seed,
                                          "pos": pos, "counts": counts}))
        for k in totals:
            totals[k] += counts[k]
        print(f"shard pos {pos} done: {counts}", file=sys.stderr)

    print(json.dumps(totals))
    return 0


def read_lines(path: Path) -> list[str]:
    """Split on \n ONLY. str.splitlines() also splits on U+2028/U+0085, which
    occur unescaped inside prompt text written with ensure_ascii=False, and
    would cut records in half."""
    if not path.exists():
        return []
    return [l for l in path.read_text(encoding="utf-8").split("\n") if l]


def merge(out_root: Path, parts_dir: Path, order: list[int], args) -> int:
    paths = {
        "coding": out_root / "wildchat-coding" / "turns.jsonl",
        "general": out_root / "wildchat-general" / "turns.jsonl",
    }
    for p in paths.values():
        p.parent.mkdir(parents=True, exist_ok=True)

    coding: list[str] = []
    general: list[str] = []
    for pos in range(len(order)):
        coding += read_lines(parts_dir / f"coding.{pos:02d}.jsonl")
        general += read_lines(parts_dir / f"general.{pos:02d}.jsonl")
    print(f"parts: coding={len(coding)} general={len(general)}", file=sys.stderr)

    coding = coding[: args.cap]
    n = min(len(coding), len(general), args.cap)
    coding = coding[:n]
    # the control is over-collected on purpose, then thinned to exactly n by a
    # seeded uniform sample that keeps stream order, so both slices cover the
    # same span of the corpus
    if len(general) > n:
        idx = sorted(random.Random(args.seed ^ 0xC0FFEE).sample(range(len(general)), n))
        general = [general[i] for i in idx]

    for label, lines in (("coding", coding), ("general", general)):
        tmp = paths[label].with_suffix(".jsonl.tmp")
        tmp.write_text("".join(l + "\n" for l in lines), encoding="utf-8")
        tmp.replace(paths[label])  # atomic: no reader ever sees a partial file
        print(f"{label}: {len(lines)} rows -> {paths[label]}", file=sys.stderr)
    print(json.dumps({"coding": len(coding), "general": len(general)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

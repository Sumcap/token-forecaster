#!/usr/bin/env python3
"""
Harvest REAL developer prompts from coding-agent chat histories that people
committed to public GitHub repositories, and normalize them to the turn schema
that `experiments/evaluation/export-turn-text.mjs` writes.

    python3 experiments/evaluation/semantic/harvest_github_chats.py \
        --out experiments/datasets/public/github-agent-chats/turns.jsonl

Stages, each resumable and cached under --raw-dir (gitignored):

  1. search  GitHub code search for the three history formats below. The API
             caps a query at 1,000 results, so every query is partitioned by
             `size:` byte ranges to page past that cap.
  2. fetch   raw.githubusercontent download of each unique blob, cached by blob
             sha, files over --max-bytes skipped.
  3. repos   `gh api repos/{owner}/{repo}` once per repository, for the SPDX
             license id.
  4. parse   format-specific parsers -> turns -> tiktoken o200k_base totals.

Formats (verified against real files on 2 September 2026):

  aider      `.aider.chat.history.md`. `#### ` prefixes every line of a human
             message; `> ` prefixes aider's own console output (NOT model
             tokens); everything else between two `####` runs is assistant
             output. `# aider chat started at ...` starts a session.
  specstory  `.specstory/history/*.md` from the SpecStory extension, covering
             both Cursor and Claude Code. `_**User (ts)**_` and
             `_**Assistant (model)**_` / `_**Agent (model ts)**_` headers,
             `---` separators. Claude Code sessions inline TOOL RESULTS inside
             `<tool-use ...><details>` regions; those fenced results are
             stripped for read/shell tools and kept for write/edit tools,
             because only the latter are model-authored.
  cline      `cline_task*.md` / `roo_task*.md`. `**User:**` / `**Assistant:**`
             headers; only a user block carrying `<task>` or `<feedback>` is a
             human turn, the rest are tool results and `<environment_details>`.

A turn is one human message plus every assistant block until the next human
message. The session key is `owner/repo`. Turns with no human text or no
assistant output are dropped; identical (text, total) pairs are deduplicated.

NOTHING in the output may be committed: it carries other people's prompt text.
Only aggregates go into MANIFEST.md.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Stages 1-4 are shared with `harvest_sessions.py`; see that module's docstring
# for why they must stay identical between the two harvesters.
from harvest_common import (
    PARSERS,
    REPO_ROOT,
    SIZE_BUCKETS,
    aider_command,
    blob_path,
    build_index,
    fetch_all,
    file_sort_key,
    load_index,
    load_licenses,
)

DEFAULT_OUT = REPO_ROOT / "experiments/datasets/public/github-agent-chats/turns.jsonl"
DEFAULT_RAW = REPO_ROOT / "experiments/datasets/public/github-agent-chats/raw"


QUERIES = {
    "aider": [f"filename:.aider.chat.history.md {b}" for b in SIZE_BUCKETS],
    "specstory": [f"path:.specstory/history extension:md {b}" for b in SIZE_BUCKETS],
    "cline": [
        "filename:cline_task extension:md",
        "filename:roo_task extension:md",
        "filename:cline_tasks extension:md",
    ],
}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--raw-dir", default=str(DEFAULT_RAW))
    ap.add_argument("--tools", default="aider,specstory,cline")
    ap.add_argument("--pages", type=int, default=10, help="search pages per query")
    ap.add_argument("--max-files-per-tool", type=int, default=1600)
    ap.add_argument("--max-files-per-repo", type=int, default=25)
    ap.add_argument("--max-bytes", type=int, default=5_000_000)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--refresh-search", action="store_true")
    ap.add_argument("--skip-search", action="store_true")
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--seed", type=int, default=20260902)
    args = ap.parse_args()

    def log(message):
        print(message, flush=True)

    raw_dir = Path(args.raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    tools = [t for t in args.tools.split(",") if t]

    if args.skip_search:
        index = load_index(raw_dir / "index.jsonl")
    else:
        index = build_index(
            raw_dir / "index.jsonl", QUERIES, tools, args.pages, args.refresh_search, log
        )
    index = [row for row in index if row["tool"] in tools]
    log(f"[index] {len(index)} blobs, {len({r['repo'] for r in index})} repos")

    # pick files: cap per repo so one monorepo cannot dominate a session
    rng = random.Random(args.seed)
    picked: list[dict] = []
    for tool in tools:
        rows = [r for r in index if r["tool"] == tool]
        rng.shuffle(rows)
        per_repo: Counter = Counter()
        chosen = []
        for row in rows:
            if per_repo[row["repo"]] >= args.max_files_per_repo:
                continue
            per_repo[row["repo"]] += 1
            chosen.append(row)
            if len(chosen) >= args.max_files_per_tool:
                break
        log(f"[pick] {tool}: {len(chosen)} files across {len(per_repo)} repos")
        picked.extend(chosen)

    if not args.skip_fetch:
        fetch_all(raw_dir, picked, args.max_bytes, args.workers, log)

    present = [row for row in picked if blob_path(raw_dir, row).exists()]
    log(f"[fetch] {len(present)} blobs on disk")

    licenses = load_licenses(
        raw_dir / "repos.json", sorted({r["repo"] for r in present}), log
    )

    import tiktoken

    enc = tiktoken.get_encoding("o200k_base")

    present.sort(key=file_sort_key)
    raw_turns = []
    stats = Counter()
    for row in present:
        try:
            text = blob_path(raw_dir, row).read_text(errors="replace")
        except Exception:
            stats["unreadable"] += 1
            continue
        stats[f"files:{row['tool']}"] += 1
        try:
            parsed = list(PARSERS[row["tool"]](text))
        except Exception:
            stats["parse-error"] += 1
            continue
        for index_in_file, turn in enumerate(parsed):
            stats["turns:raw"] += 1
            human = turn["text"].strip()
            command = None
            if row["tool"] == "aider":
                human, command = aider_command(human)
                human = human.strip()
            if not human:
                stats["drop:no-human-text"] += 1
                continue
            blocks = [b for b in turn["blocks"] if b.strip()]
            if not blocks:
                stats["drop:no-assistant-output"] += 1
                continue
            raw_turns.append(
                {
                    "row": row,
                    "index": index_in_file,
                    "text": human,
                    "blocks": blocks,
                    "model": turn.get("model"),
                    "command": command,
                }
            )

    log(f"[parse] {len(raw_turns)} candidate turns; encoding")
    per_block = []
    owners = []
    for position, turn in enumerate(raw_turns):
        for block in turn["blocks"]:
            per_block.append(block)
            owners.append(position)
    encoded = enc.encode_ordinary_batch(per_block, num_threads=8)
    totals = defaultdict(int)
    openers = {}
    for owner, ids in zip(owners, encoded):
        totals[owner] += len(ids)
        if owner not in openers:
            openers[owner] = len(ids)

    out_rows = []
    seen: set[tuple[str, int]] = set()
    for position, turn in enumerate(raw_turns):
        total = totals[position]
        if total <= 0:
            stats["drop:zero-tokens"] += 1
            continue
        key = (turn["text"], total)
        if key in seen:
            stats["drop:duplicate"] += 1
            continue
        seen.add(key)
        row = turn["row"]
        out_rows.append(
            {
                "turnRootId": f"{row['sha']}:{turn['index']}",
                "sessionId": row["repo"],
                "firstMs": 0,
                "total": total,
                "calls": len(turn["blocks"]),
                "openerTokens": openers[position],
                "model": turn.get("model") or "unknown",
                "thinking": "no",
                "command": turn.get("command"),
                "text": turn["text"],
                "tokenSource": "tiktoken:o200k_base",
                "dataset": "github-agent-chats",
                "tool": row["tool"],
                "repo": row["repo"],
                "license": licenses.get(row["repo"]),
            }
        )

    for position, row in enumerate(out_rows, 1):
        row["firstMs"] = position

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as handle:
        for row in out_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    stats["turns:kept"] = len(out_rows)
    log(f"[write] {len(out_rows)} turns -> {out_path}")
    log("[stats] " + json.dumps(dict(sorted(stats.items()))))
    summary = {
        "stats": dict(stats),
        "queries": {t: QUERIES[t] for t in tools},
        "files_on_disk": len(present),
        "repos": len({r["repo"] for r in present}),
        "per_tool_files": dict(Counter(r["tool"] for r in present)),
        "per_tool_turns": dict(Counter(r["tool"] for r in out_rows)),
        "licenses": dict(
            Counter(str(r["license"]) for r in out_rows).most_common()
        ),
        "models": dict(Counter(r["model"] for r in out_rows).most_common(25)),
    }
    (raw_dir.parent / "harvest-summary.json").write_text(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

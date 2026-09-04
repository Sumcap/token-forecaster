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
import concurrent.futures as futures
import json
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO_ROOT / "experiments/datasets/public/github-agent-chats/turns.jsonl"
DEFAULT_RAW = REPO_ROOT / "experiments/datasets/public/github-agent-chats/raw"

# code search allows 10 requests/minute for an authenticated user
SEARCH_SLEEP = 6.5

# ---------------------------------------------------------------------------
# 1. search
# ---------------------------------------------------------------------------

# byte ranges partition each query so we can page past the 1,000-result cap.
SIZE_BUCKETS = [
    "size:<4000",
    "size:4000..12000",
    "size:12000..30000",
    "size:30000..60000",
    "size:60000..120000",
    "size:120000..250000",
    "size:>250000",
]

QUERIES = {
    "aider": [f"filename:.aider.chat.history.md {b}" for b in SIZE_BUCKETS],
    "specstory": [f"path:.specstory/history extension:md {b}" for b in SIZE_BUCKETS],
    "cline": [
        "filename:cline_task extension:md",
        "filename:roo_task extension:md",
        "filename:cline_tasks extension:md",
    ],
}


def gh_json(args: list[str]) -> dict:
    proc = subprocess.run(
        ["gh", "api", *args], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:400])
    return json.loads(proc.stdout)


def search(tool: str, query: str, pages: int, log) -> list[dict]:
    items: list[dict] = []
    for page in range(1, pages + 1):
        for attempt in range(4):
            try:
                body = gh_json(
                    [
                        "-X",
                        "GET",
                        "search/code",
                        "-f",
                        f"q={query}",
                        "-F",
                        "per_page=100",
                        "-F",
                        f"page={page}",
                    ]
                )
                break
            except RuntimeError as err:
                text = str(err)
                if "403" in text or "429" in text or "rate limit" in text.lower():
                    wait = 30 * (attempt + 1)
                    log(f"  rate limited, sleeping {wait}s")
                    time.sleep(wait)
                    continue
                if "422" in text:  # past the result cap for this query
                    return items
                raise
        else:
            return items
        got = body.get("items", [])
        for item in got:
            ref = re.search(r"[?&]ref=([0-9a-f]{40})", item.get("url", ""))
            items.append(
                {
                    "tool": tool,
                    "sha": item["sha"],
                    "repo": item["repository"]["full_name"],
                    "path": item["path"],
                    "ref": ref.group(1) if ref else None,
                }
            )
        log(f"  page {page}: +{len(got)} (total {body.get('total_count')})")
        if len(got) < 100:
            return items
        time.sleep(SEARCH_SLEEP)
    return items


def build_index(raw_dir: Path, tools: list[str], pages: int, refresh: bool, log):
    index_path = raw_dir / "index.jsonl"
    known: dict[str, dict] = {}
    if index_path.exists() and not refresh:
        for line in index_path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                known[row["sha"]] = row
    have_tools = {row["tool"] for row in known.values()}
    for tool in tools:
        if tool in have_tools and not refresh:
            log(f"[search] {tool}: cached ({sum(1 for r in known.values() if r['tool'] == tool)} blobs)")
            continue
        for query in QUERIES[tool]:
            log(f"[search] {tool}: {query}")
            for row in search(tool, query, pages, log):
                known.setdefault(row["sha"], row)
            time.sleep(SEARCH_SLEEP)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        "\n".join(json.dumps(row) for row in known.values()) + "\n"
    )
    return list(known.values())


# ---------------------------------------------------------------------------
# 2. fetch
# ---------------------------------------------------------------------------


def blob_path(raw_dir: Path, row: dict) -> Path:
    return raw_dir / row["tool"] / row["sha"][:2] / f"{row['sha']}.md"


def fetch_one(raw_dir: Path, row: dict, max_bytes: int) -> str | None:
    dest = blob_path(raw_dir, row)
    if dest.exists():
        return "cached"
    if not row.get("ref"):
        return None
    url = (
        "https://raw.githubusercontent.com/"
        f"{row['repo']}/{row['ref']}/"
        + urllib.parse.quote(row["path"])
    )
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "token-forecaster-corpus/1"}
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                length = response.headers.get("Content-Length")
                if length and int(length) > max_bytes:
                    return "toobig"
                data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                return "toobig"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return "fetched"
        except urllib.error.HTTPError as err:
            if err.code in (403, 429):
                time.sleep(10 * (attempt + 1))
                continue
            return None
        except Exception:
            time.sleep(2 * (attempt + 1))
    return None


def fetch_all(raw_dir: Path, rows: list[dict], max_bytes: int, workers: int, log):
    stats = Counter()
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(fetch_one, raw_dir, row, max_bytes): row for row in rows}
        for done, job in enumerate(futures.as_completed(jobs), 1):
            stats[job.result() or "failed"] += 1
            if done % 200 == 0:
                log(f"[fetch] {done}/{len(rows)} {dict(stats)}")
    log(f"[fetch] done {dict(stats)}")
    return stats


# ---------------------------------------------------------------------------
# 3. repository licenses
# ---------------------------------------------------------------------------


def load_licenses(raw_dir: Path, repos: list[str], log) -> dict[str, str | None]:
    cache_path = raw_dir / "repos.json"
    cache: dict[str, str | None] = {}
    if cache_path.exists():
        cache = json.loads(cache_path.read_text())
    missing = [r for r in repos if r not in cache]
    for done, repo in enumerate(missing, 1):
        try:
            body = gh_json([f"repos/{repo}"])
            cache[repo] = (body.get("license") or {}).get("spdx_id")
        except RuntimeError:
            cache[repo] = None
        if done % 100 == 0:
            log(f"[repos] {done}/{len(missing)}")
            cache_path.write_text(json.dumps(cache))
    cache_path.write_text(json.dumps(cache))
    return cache


# ---------------------------------------------------------------------------
# 4. parsers
# ---------------------------------------------------------------------------

AIDER_SESSION = re.compile(r"^# aider chat started at ")
AIDER_MODEL = re.compile(r"^>\s*(?:Main model|Model):\s*(\S+)")
# aider slash commands that are chat, not harness control
AIDER_CHAT_COMMANDS = {"ask", "code", "architect", "chat"}


def parse_aider(text: str):
    """Yield {'text', 'blocks': [str], 'model'} per turn."""
    model = None
    human: list[str] | None = None
    blocks: list[list[str]] = []
    current: list[str] | None = None

    def flush():
        nonlocal human, blocks, current
        if human is not None:
            if current:
                blocks.append(current)
            done = {
                "text": "\n".join(human).strip(),
                "blocks": ["\n".join(b).strip() for b in blocks if "\n".join(b).strip()],
                "model": model,
            }
        else:
            done = None
        human, blocks, current = None, [], None
        return done

    in_fence = False
    for line in text.split("\n"):
        # Inside a fenced block everything is model output, including the
        # `>>>>>>> REPLACE` marker of aider's SEARCH/REPLACE edit format, which
        # would otherwise look like an aider console line.
        if in_fence and not (
            line.startswith("####") and (len(line) == 4 or line[4] == " ")
        ):
            if line.startswith("```"):
                in_fence = False
            current.append(line.rstrip())
            continue
        in_fence = False
        if AIDER_SESSION.match(line):
            out = flush()
            if out:
                yield out
            continue
        if line.startswith("####") and (len(line) == 4 or line[4] == " "):
            if human is None or blocks or current:
                out = flush()
                if out:
                    yield out
                human = []
            human.append(line[5:].rstrip())
            continue
        if line.startswith("> ") or line.rstrip() == ">":
            found = AIDER_MODEL.match(line)
            if found:
                model = found.group(1).strip(",")
            if current:
                blocks.append(current)
                current = None
            continue
        if human is None:
            continue  # session preamble before the first human message
        if current is None:
            current = []
        current.append(line.rstrip())
        if line.startswith("```"):
            in_fence = True
    out = flush()
    if out:
        yield out


SPEC_HEADER = re.compile(r"^_\*\*\s*([A-Za-z][A-Za-z ]*?)\s*((?:\([^)]*\)\s*)*)\*\*_\s*$")
SPEC_STRIP_TAGS = (
    "ide_selection",
    "environment_details",
    "additional_data",
    "attached_files",
    "user_rules",
    "custom_instructions",
    "system-reminder",
    "local-command-stdout",
    "command-message",
    "command-name",
    "command-args",
    "function_results",
)
TOOL_USE_REGION = re.compile(r"<tool-use\b.*?</tool-use>", re.S)
TOOL_NAME = re.compile(r'data-tool-name="([^"]+)"')
FENCE = re.compile(r"^```", re.M)
WRITE_TOOLS = {
    "write",
    "edit",
    "multiedit",
    "notebookedit",
    "create_file",
    "write_to_file",
    "apply_diff",
    "edit_file",
    "search_replace",
    "str_replace_editor",
    "str_replace_based_edit_tool",
}
DATEISH = re.compile(r"^\d{4}-\d{2}-\d{2}")


def drop_fences(body: str) -> str:
    """Remove fenced blocks, which inside a read/shell tool-use are RESULTS."""
    out, keep = [], True
    for line in body.split("\n"):
        if line.lstrip().startswith("```"):
            keep = not keep
            continue
        if keep:
            out.append(line)
    return "\n".join(out)


def clean_tool_use(body: str) -> str:
    name = TOOL_NAME.search(body)
    summary = re.search(r"Tool use:\s*\*\*([^*]+)\*\*", body)
    tool = (name.group(1) if name else summary.group(1) if summary else "").strip().lower()
    inner = re.sub(r"</?(?:tool-use|details|summary)[^>]*>", " ", body)
    if tool not in WRITE_TOOLS:
        inner = drop_fences(inner)
    return inner


def strip_tags(text: str) -> str:
    for tag in SPEC_STRIP_TAGS:
        text = re.sub(rf"<{tag}\b.*?</{tag}>", " ", text, flags=re.S)
        text = re.sub(rf"</?{tag}\b[^>]*>", " ", text)
    return text


SPEC_META_GROUP = re.compile(r"\(([^)]*)\)")
# SpecStory writes the model in the block header, but the same slot also carries
# placeholders ("default", "mode Agent", "<synthetic>"), a bare timestamp, and a
# trailing "(sidechain)" marker. Only a real name becomes `model`.
SPEC_NON_MODELS = {"default", "mode", "sidechain", "auto", "unknown", "agent", "ask"}


def spec_model(meta: str) -> str | None:
    for group in SPEC_META_GROUP.findall(meta or ""):
        piece = group.strip()
        if piece.lower().startswith("model "):
            piece = piece[6:]
        piece = piece.split(",")[0].strip()
        token = piece.split()[0] if piece else ""
        token = token.strip("(),;")
        if not token or len(token) >= 60:
            continue
        if DATEISH.match(token) or token.startswith("<"):
            continue
        if token.lower() in SPEC_NON_MODELS:
            continue
        return token
    return None


def parse_specstory(text: str):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    lines = text.split("\n")
    turns = []
    human: str | None = None
    blocks: list[str] = []
    model = None
    role = None
    buffer: list[str] = []

    def close_block():
        nonlocal buffer, human, blocks, role
        body = "\n".join(buffer).strip()
        buffer = []
        if role is None:
            return
        if role == "human":
            body = strip_tags(body)
            body = re.sub(r"<details\b.*?</details>", " ", body, flags=re.S)
            body = "\n".join(
                l for l in body.split("\n") if not l.lstrip().startswith("⎿")
            ).strip()
            if not body:
                return  # tool-result / injected-context-only user block
            if human is not None:
                turns.append({"text": human, "blocks": blocks, "model": model})
            human, blocks = body, []
        elif role == "assistant":
            if human is None:
                return  # assistant preamble before any human message
            body = TOOL_USE_REGION.sub(lambda m: clean_tool_use(m.group(0)), body)
            body = body.strip()
            if body:
                blocks.append(body)

    for line in lines:
        found = SPEC_HEADER.match(line)
        if found:
            close_block()
            who = found.group(1).strip().lower()
            meta = found.group(2) or ""
            if who in ("user", "human"):
                role = "human"
            elif who in ("assistant", "agent", "ai", "model"):
                role = "assistant"
                named = spec_model(meta)
                if named:
                    model = named
            else:
                role = None
            continue
        if line.strip() == "---":
            continue
        buffer.append(line)
    close_block()
    if human is not None:
        turns.append({"text": human, "blocks": blocks, "model": model})
    return turns


CLINE_HEADER = re.compile(r"^\*\*(User|Assistant|Human|AI):\*\*\s*$")
CLINE_TASK = re.compile(r"<(task|feedback|user_message)>(.*?)</\1>", re.S)


def parse_cline(text: str):
    lines = text.split("\n")
    turns = []
    human: str | None = None
    blocks: list[str] = []
    role = None
    buffer: list[str] = []

    def close_block():
        nonlocal buffer, human, blocks
        body = "\n".join(buffer).strip()
        buffer = []
        if role is None:
            return
        if role == "human":
            parts = [m.group(2).strip() for m in CLINE_TASK.finditer(body)]
            joined = "\n".join(p for p in parts if p).strip()
            if not joined:
                return  # tool result / environment_details only
            if human is not None:
                turns.append({"text": human, "blocks": blocks, "model": None})
            human, blocks = joined, []
        else:
            if human is None:
                return
            if body:
                blocks.append(body)

    for line in lines:
        found = CLINE_HEADER.match(line)
        if found:
            close_block()
            role = "human" if found.group(1) in ("User", "Human") else "assistant"
            continue
        buffer.append(line)
    close_block()
    if human is not None:
        turns.append({"text": human, "blocks": blocks, "model": None})
    return turns


PARSERS = {"aider": parse_aider, "specstory": parse_specstory, "cline": parse_cline}

FILE_TS = re.compile(r"(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-:](\d{2})")


def file_sort_key(row: dict) -> tuple:
    found = FILE_TS.search(row["path"])
    stamp = "".join(found.groups()) if found else ""
    return (stamp, row["repo"], row["path"])


def aider_command(text: str):
    """Return (kept_text, command) for a slash-prefixed aider message."""
    if not text.startswith("/"):
        return text, None
    head = text.split(None, 1)
    name = head[0][1:].lower()
    if name in AIDER_CHAT_COMMANDS:
        return (head[1] if len(head) > 1 else ""), name
    return "", name


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
        index = [
            json.loads(l)
            for l in (raw_dir / "index.jsonl").read_text().splitlines()
            if l.strip()
        ]
    else:
        index = build_index(raw_dir, tools, args.pages, args.refresh_search, log)
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

    licenses = load_licenses(raw_dir, sorted({r["repo"] for r in present}), log)

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

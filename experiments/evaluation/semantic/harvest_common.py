#!/usr/bin/env python3
"""
Shared stages for the public-corpus harvesters.

`harvest_github_chats.py` (flat prompt->reply turns, `docs/SEMANTIC-PLAN.md`
Step A) and `harvest_sessions.py` (per-call rows with session structure and
native usage, `docs/PLAN-OF-ATTACK.md` Track 2 Tier A) both need the same four
stages, and they must stay identical so the two corpora describe the same
population of files:

  1. search  GitHub code search, partitioned by `size:` byte ranges to page
             past the API's 1,000-result cap, 10 requests/minute.
  2. fetch   raw.githubusercontent download, cached by blob sha under a
             gitignored `raw/` directory, so a rerun refetches nothing.
  3. repos   `gh api repos/{owner}/{repo}` once per repository, for the SPDX id.
  4. parse   the three markdown chat-history formats (aider, specstory,
             cline/roo). `harvest_sessions.py` adds the JSON/JSONL formats that
             carry native usage; those live in that script.

This module holds no queries of its own: each harvester passes its own.

NOTHING harvested may be committed: it carries other people's prompt text.
"""
from __future__ import annotations

import concurrent.futures as futures
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

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

def build_index(
    index_path: Path,
    queries: dict[str, list[str]],
    tools: list[str],
    pages: int,
    refresh: bool,
    log,
) -> list[dict]:
    """Search for every tool's queries, merged into a sha-keyed index on disk.

    A tool already present in the index is skipped unless `refresh`, so a rerun
    spends no search budget on sources that were harvested before. `queries` is
    the caller's own map; extra keys in an index row (`ext`, for instance) are
    preserved on the ones that were already there.
    """
    known: dict[str, dict] = {}
    if index_path.exists() and not refresh:
        for line in index_path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                known[row["sha"]] = row
    have_tools = {row["tool"] for row in known.values()}
    for tool in tools:
        if tool in have_tools and not refresh:
            log(
                f"[search] {tool}: cached "
                f"({sum(1 for r in known.values() if r['tool'] == tool)} blobs)"
            )
            continue
        for query in queries[tool]:
            log(f"[search] {tool}: {query}")
            for row in search(tool, query, pages, log):
                known.setdefault(row["sha"], row)
            time.sleep(SEARCH_SLEEP)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text("\n".join(json.dumps(row) for row in known.values()) + "\n")
    return list(known.values())


def load_index(index_path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in index_path.read_text().splitlines()
        if line.strip()
    ]


# ---------------------------------------------------------------------------
# 2. fetch
# ---------------------------------------------------------------------------


def blob_path(raw_dir: Path, row: dict) -> Path:
    """Cache location for one blob.

    The extension is part of the cache key so the JSON/JSONL formats can share
    a raw directory with the markdown ones without colliding. Rows written by
    the original markdown harvester carry no `ext` and keep their `.md` path.
    """
    ext = row.get("ext") or ".md"
    return raw_dir / row["tool"] / row["sha"][:2] / f"{row['sha']}{ext}"


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


def load_licenses(cache_path: Path, repos: list[str], log) -> dict[str, str | None]:
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
    """Yield {'text', 'blocks': [str], 'model', 'console': [str]} per turn.

    `console` is aider's own `> ` output for the turn. It is NOT model output
    and never enters `blocks`, but it carries the one thing this format records
    that a tiktoken count cannot recover -- `> Tokens: 3.2k sent, 1.1k
    received.`, the model's real output-token count for the exchange. The flat
    harvester ignores the key; `harvest_sessions.py` reads it.
    """
    model = None
    human: list[str] | None = None
    blocks: list[list[str]] = []
    current: list[str] | None = None
    console: list[str] = []
    # One `.aider.chat.history.md` accumulates every session ever run in that
    # repository. `session` counts the `# aider chat started at` markers, so a
    # per-call harvester can treat each run as its own session instead of
    # pretending a file spanning months is one conversation.
    session = 0

    def flush():
        nonlocal human, blocks, current, console
        if human is not None:
            if current:
                blocks.append(current)
            done = {
                "text": "\n".join(human).strip(),
                "blocks": ["\n".join(b).strip() for b in blocks if "\n".join(b).strip()],
                "model": model,
                "console": console,
                "session": session,
            }
        else:
            done = None
        human, blocks, current, console = None, [], None, []
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
            session += 1
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
            console.append(line[2:].rstrip() if line.startswith("> ") else "")
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

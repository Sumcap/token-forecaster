#!/usr/bin/env python3
"""
Tier A of `docs/PLAN-OF-ATTACK.md` Track 2: harvest coding-agent sessions from
public GitHub repositories as PER-CALL rows with session structure and, where
the format records it, NATIVE output-token usage.

This is the successor to `harvest_github_chats.py`, which flattens every
session to prompt->reply pairs with tiktoken counts. That flattening threw away
the two things the multi-source base needs most: the agent loop (a turn is a
prompt plus N model calls, and 86% of the flat corpus reads as one call) and a
real label (a tiktoken count of visible text misses the hidden thinking, which
is about two thirds of the local corpus's output tokens). The flat harvester
stays, unchanged in behaviour, for the semantic probes that were graded on it.

    python3 experiments/evaluation/semantic/harvest_sessions.py

Structure, identical for every source:

    user     the repository, `owner/repo` -- the fold key, since public data has
             no installation id and no timestamps to fold on
    session  one history file (or one Cline task folder). An aider history file
             holds several sessions, split on `# aider chat started at`.
    turn     one human message plus every model call until the next one
    call     one model API call

Sources and where the label comes from:

  claude-code  `.claude/projects/**/*.jsonl` transcripts people committed.
               `message.usage.output_tokens` per call; turns and calls are cut
               by the SHIPPED loader (`packages/ingest-claude/load-history.mjs`,
               driven through `claude_calls.mjs`) so the public rows and the
               local rows mean the same thing.   usage_source native:claude-code
  cline-task   Cline / Roo `<task>/api_conversation_history.json` plus
               `ui_messages.json`; the `api_req_started` events carry `tokensOut`
               per request, aligned index-for-index with the assistant messages.
                                                  usage_source native:cline
  aider        `.aider.chat.history.md`; aider prints `> Tokens: 3.2k sent, 1.1k
               received.` after each exchange, which is the model's own output
               count.                             usage_source native:aider
  codex        `~/.codex/sessions/*.jsonl` rollouts; `token_count` events carry
               `last_token_usage.output_tokens` and `reasoning_output_tokens`,
               deduplicated the way `packages/ingest-codex/src/parse.ts` does.
                                                  usage_source native:codex
  specstory    `.specstory/history/*.md` and `cline_task*.md` / `roo_task*.md`
  cline        exports. These are RENDERED markdown with no usage anywhere, so
               the label is a tiktoken `o200k_base` count of the visible model
               text.                              usage_source estimated

Every estimated row carries `visible_text_only: true`. It is a floor, not a
label: reasoning tokens the transcript never rendered are missing from it, and
`docs/PLAN-OF-ATTACK.md` "Risks, named" requires that correction to be measured
against Tier A's native rows rather than assumed.

Output (both gitignored; only MANIFEST.md is committed):

    experiments/datasets/public/agent-sessions/calls.jsonl
    experiments/datasets/public/agent-sessions/turns.jsonl

NOTHING in either file may be committed, printed in a report, or quoted: they
carry other people's prompt text. Only aggregates leave this directory.
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import hashlib
import json
import random
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harvest_common import (  # noqa: E402
    REPO_ROOT,
    SIZE_BUCKETS,
    blob_path,
    build_index,
    fetch_all,
    load_index,
    load_licenses,
    parse_aider,
    parse_cline,
    parse_specstory,
)

DATASET = "agent-sessions"
DEFAULT_DIR = REPO_ROOT / "experiments/datasets/public/agent-sessions"
# The markdown blobs the flat harvester already downloaded. Read only: this
# script reparses them into the per-call schema and never refetches.
MD_DIR = REPO_ROOT / "experiments/datasets/public/github-agent-chats/raw"

QUERIES = {
    # `path:.claude/projects` finds only the people who committed the transcript
    # directory verbatim -- 1,648 blobs across 54 repositories, which is far too
    # few USERS to fold on. `"parentUuid"` is the one field every Claude Code
    # transcript row carries and nothing else writes, so the content query finds
    # the same transcripts wherever they were committed (60k blobs). Both are
    # partitioned by size to page past the 1,000-result cap.
    "claude-code": [f"path:.claude/projects extension:jsonl {b}" for b in SIZE_BUCKETS]
    + [f'"parentUuid" "requestId" extension:jsonl {b}' for b in SIZE_BUCKETS],
    # Both halves of a Cline task folder are searched: whichever one a query
    # finds, the sibling is fetched by path, so a folder indexed through only
    # one of them is still complete.
    "cline-task": [
        "filename:api_conversation_history.json",
        "filename:ui_messages.json",
    ],
    "codex": ["path:.codex/sessions extension:jsonl"],
}
EXT = {"claude-code": ".jsonl", "cline-task": ".json", "codex": ".jsonl"}
NATIVE_SOURCES = {"claude-code", "cline-task", "aider", "codex"}
MD_SOURCES = {"aider", "specstory", "cline"}

# ---------------------------------------------------------------------------
# token estimation
# ---------------------------------------------------------------------------


class Estimator:
    """tiktoken `o200k_base` over visible model text, batched."""

    def __init__(self) -> None:
        import tiktoken

        self.enc = tiktoken.get_encoding("o200k_base")

    def count_many(self, texts: list[str]) -> list[int]:
        if not texts:
            return []
        return [len(ids) for ids in self.enc.encode_ordinary_batch(texts, num_threads=8)]


# ---------------------------------------------------------------------------
# claude-code: driven through the shipped loader
# ---------------------------------------------------------------------------


def stage_claude(raw_dir: Path, rows: list[dict], staging: Path, log) -> int:
    """Hardlink each cached blob into `<staging>/<sha>/<sha>.jsonl`.

    The loader keys a call's origin by the FIRST path segment under its root, so
    one directory per blob is what makes a call attributable to a repository.
    """
    # Prune blobs left over from a previous, differently-sized pick: the loader
    # walks the whole staging tree, and a stale directory would contribute calls
    # this run cannot attribute to a repository.
    wanted = {row["sha"] for row in rows}
    if staging.exists():
        for existing in staging.iterdir():
            if existing.is_dir() and existing.name not in wanted:
                for child in existing.iterdir():
                    child.unlink()
                existing.rmdir()
    staged = 0
    for row in rows:
        source = blob_path(raw_dir, row)
        if not source.exists():
            continue
        dest_dir = staging / row["sha"]
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{row['sha']}.jsonl"
        if not dest.exists():
            try:
                dest.hardlink_to(source)
            except OSError:
                dest.write_bytes(source.read_bytes())
        staged += 1
    log(f"[claude-code] staged {staged} blobs")
    return staged


def run_claude_loader(staging: Path, out: Path, log) -> list[dict]:
    script = Path(__file__).resolve().parent / "claude_calls.mjs"
    proc = subprocess.run(
        ["node", str(script), "--staging", str(staging), "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude_calls.mjs failed: {proc.stderr.strip()[:800]}")
    log(f"[claude-code] loader {proc.stderr.strip()}")
    return [json.loads(line) for line in out.read_text().splitlines() if line.strip()]


def claude_sessions(calls: list[dict], sha_to_repo: dict[str, str], stats: Counter):
    """Group loader rows into sessions -> turns -> calls."""
    by_session: dict[str, list[dict]] = defaultdict(list)
    for call in calls:
        if call["turnRootId"] is None:
            # The transcript's ancestry does not reach a human message
            # (compaction, or a session committed without its history). Such a
            # call has no turn and cannot be held out by turn, so it is dropped.
            stats["drop:claude-no-turn-root"] += 1
            continue
        by_session[call["sha"]].append(call)

    for sha, session_calls in by_session.items():
        repo = sha_to_repo.get(sha)
        if repo is None:
            stats["drop:claude-no-repo"] += 1
            continue
        session_calls.sort(key=lambda c: (c["timestampMs"] or 0, c["requestId"]))
        turns: dict[str, list[dict]] = defaultdict(list)
        for call in session_calls:
            turns[call["turnRootId"]].append(call)
        ordered = sorted(
            turns.items(), key=lambda item: (item[1][0]["timestampMs"] or 0, item[0])
        )
        for turn_index, (root, turn_calls) in enumerate(ordered):
            opener = turn_calls[0]
            yield {
                "source": "claude-code",
                "user": repo,
                "session": f"claude-code:{sha}",
                "turn_index": turn_index,
                "turn_root_id": f"{sha}:{root}",
                "exact": all(c["loopDepthExact"] for c in turn_calls),
                "text": opener["turnPromptText"],
                "calls": [
                    {
                        "model": call["model"],
                        "output_tokens": call["outputTokens"],
                        "usage_source": "native:claude-code",
                        "visible_text_only": False,
                        "tool_names": call["tools"],
                        "largest_tool_input_chars": call["largestToolInputChars"],
                        "stop_reason": call["stopReason"],
                        "visible_chars": call["textChars"]
                        + call["toolChars"]
                        + call["thinkingChars"],
                        "loop_depth": call["loopDepth"],
                        "thinking": call["thinking"],
                    }
                    for call in turn_calls
                ],
            }


# ---------------------------------------------------------------------------
# cline-task: api_conversation_history.json + ui_messages.json
# ---------------------------------------------------------------------------

CLINE_XML_TOOL = re.compile(
    r"<(read_file|write_to_file|replace_in_file|apply_diff|search_files|list_files|"
    r"execute_command|browser_action|use_mcp_tool|access_mcp_resource|ask_followup_question|"
    r"attempt_completion|new_task|list_code_definition_names|insert_content|"
    r"search_and_replace|update_todo_list|codebase_search)>(.*?)</\1>",
    re.S,
)
CLINE_TASK_TAG = re.compile(r"<(task|feedback|user_message)>(.*?)</\1>", re.S)


def block_text(content) -> str:
    """The text an Anthropic-shaped message carries, whatever its block form."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            value = block.get("text")
            if isinstance(value, str):
                parts.append(value)
    return "\n".join(parts)


def cline_tokens_out(ui: list) -> list[int | None]:
    """`tokensOut` per API request, in request order, `None` where unusable.

    Cline writes one `api_req_started` "say" per request whose `text` is a JSON
    string; the token counts are filled in when the request finishes. Entries
    that never got one (`usageMissing`, a cancelled or failed stream) MUST still
    occupy their slot: dropping them shifts every later count onto the wrong
    call, which is worse than having no count at all.
    """
    out: list[int | None] = []
    for row in ui:
        if not isinstance(row, dict) or row.get("say") != "api_req_started":
            continue
        raw = row.get("text")
        if not isinstance(raw, str):
            out.append(None)
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            out.append(None)
            continue
        value = payload.get("tokensOut")
        if payload.get("usageMissing") or not isinstance(value, (int, float)) or value <= 0:
            out.append(None)
            continue
        out.append(int(value))
    return out


def parse_cline_task(history: list, ui: list | None, stats: Counter):
    """Yield turns for one Cline/Roo task folder."""
    turns: list[dict] = []
    assistants: list[dict] = []
    current: dict | None = None
    for message in history:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "user":
            text = block_text(content)
            asked = "\n".join(
                m.group(2).strip() for m in CLINE_TASK_TAG.finditer(text)
            ).strip()
            if not asked:
                continue  # tool results and <environment_details> continue the turn
            current = {"text": asked, "calls": []}
            turns.append(current)
        elif role == "assistant":
            if current is None:
                # A task folder whose first user message carries no <task> tag
                # (a resumed or Roo-flavoured export). The calls are real and
                # they must stay counted, or the index alignment against
                # `ui_messages.json` below silently shifts by one and every
                # native token count in the folder lands on the wrong call.
                current = {"text": None, "calls": []}
                turns.append(current)
                stats["cline:implicit-turn"] += 1
            tools: list[str] = []
            largest = 0
            visible = 0
            blocks = content if isinstance(content, list) else []
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = block.get("name")
                    if isinstance(name, str):
                        tools.append(name)
                    chars = len(json.dumps(block.get("input") or {}))
                    largest = max(largest, chars)
                    visible += chars
                elif block.get("type") == "text":
                    visible += len(block.get("text") or "")
            text = block_text(content)
            for found in CLINE_XML_TOOL.finditer(text):
                # Older Cline and every Roo version put the tool call in the
                # assistant's TEXT as XML rather than a tool_use block.
                tools.append(found.group(1))
                largest = max(largest, len(found.group(2)))
            if isinstance(content, str):
                visible = len(content)
            call = {"tools": tools, "largest": largest, "visible": visible, "text": text}
            current["calls"].append(call)
            assistants.append(call)

    tokens = cline_tokens_out(ui) if ui else []
    # The last request in a folder is often still in flight when the task was
    # committed, so one extra `api_req_started` with no assistant message after
    # it is the normal shape, not a mismatch.
    if len(tokens) == len(assistants) + 1:
        tokens = tokens[: len(assistants)]
    aligned = len(tokens) == len(assistants) and len(assistants) > 0
    if ui and assistants and not aligned:
        stats["cline:usage-misaligned"] += 1
    for index, call in enumerate(assistants):
        call["output_tokens"] = tokens[index] if aligned else None
    return turns, aligned


# ---------------------------------------------------------------------------
# codex rollouts
# ---------------------------------------------------------------------------


def parse_codex(text: str, stats: Counter):
    """Yield turns from a Codex rollout.

    Faithful to `packages/ingest-codex/src/parse.ts`: turn roots are
    `event_msg/user_message` (or, on legacy rollouts with no such events, a
    `response_item` message with role user), calls are `token_count` events, and
    the CLI's UI-refresh re-emissions are deduplicated on
    (cumulative total, input, output, reasoning).
    """
    lines = text.split("\n")
    has_user_events = '"user_message"' in text
    turns: list[dict] = []
    current: dict | None = None
    model = None
    seen: set[str] = set()
    pending_tools: list[str] = []

    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        payload = row.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        kind = row.get("type")
        payload_type = payload.get("type")

        if kind == "turn_context":
            if isinstance(payload.get("model"), str):
                model = payload["model"]
            continue
        if kind == "response_item":
            if payload_type == "function_call":
                name = payload.get("name")
                if isinstance(name, str):
                    pending_tools.append(name)
                continue
            if has_user_events or payload_type != "message":
                continue
            if payload.get("role") != "user":
                continue
            body = "".join(
                part.get("text", "")
                for part in (payload.get("content") or [])
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            )
            if not body:
                continue
            current = {"text": body, "calls": [], "model": model}
            turns.append(current)
            pending_tools = []
            continue
        if kind != "event_msg":
            continue
        if payload_type == "user_message":
            message = payload.get("message")
            current = {
                "text": message if isinstance(message, str) else None,
                "calls": [],
                "model": model,
            }
            turns.append(current)
            pending_tools = []
            continue
        if payload_type != "token_count":
            continue
        info = payload.get("info")
        if not isinstance(info, dict):
            continue
        last = info.get("last_token_usage")
        total = info.get("total_token_usage")
        if not isinstance(last, dict):
            continue
        output = last.get("output_tokens")
        reasoning = last.get("reasoning_output_tokens")
        cumulative = total.get("total_tokens") if isinstance(total, dict) else None
        key = f"{cumulative}|{last.get('input_tokens')}|{output}|{reasoning}"
        if key in seen:
            continue
        seen.add(key)
        if not isinstance(output, (int, float)) or output <= 0:
            continue
        if current is None:
            current = {"text": None, "calls": [], "model": model}
            turns.append(current)
            stats["codex:call-before-turn-root"] += 1
        current["calls"].append(
            {
                "output_tokens": int(output),
                "reasoning_tokens": int(reasoning)
                if isinstance(reasoning, (int, float))
                else None,
                "tools": pending_tools,
                "model": model,
            }
        )
        pending_tools = []
    return turns


# ---------------------------------------------------------------------------
# markdown reparse (aider / specstory / cline exports)
# ---------------------------------------------------------------------------

AIDER_TOKENS = re.compile(
    r"Tokens:\s*[\d.,]+\s*[kKmM]?\s*sent,\s*([\d.,]+)\s*([kKmM]?)\s*received", re.I
)
SPEC_TOOL_NAME = re.compile(r'data-tool-name="([^"]+)"')


def aider_received(console: list[str]) -> int | None:
    """aider's own report of the model's output tokens for one exchange."""
    for line in console:
        found = AIDER_TOKENS.search(line)
        if not found:
            continue
        raw = found.group(1).replace(",", "")
        try:
            value = float(raw)
        except ValueError:
            continue
        scale = found.group(2).lower()
        if scale == "k":
            value *= 1_000
        elif scale == "m":
            value *= 1_000_000
        if value > 0:
            return int(round(value))
    return None


def markdown_turns(tool: str, text: str):
    """Normalise the three markdown parsers to one shape."""
    if tool == "aider":
        for turn in parse_aider(text):
            yield {
                "session_part": turn.get("session", 0),
                "text": turn["text"],
                "blocks": turn["blocks"],
                "model": turn.get("model"),
                "native": aider_received(turn.get("console") or []),
            }
    elif tool == "specstory":
        for turn in parse_specstory(text):
            yield {
                "session_part": 0,
                "text": turn["text"],
                "blocks": turn["blocks"],
                "model": turn.get("model"),
                "native": None,
            }
    else:
        for turn in parse_cline(text):
            yield {
                "session_part": 0,
                "text": turn["text"],
                "blocks": turn["blocks"],
                "model": None,
                "native": None,
            }


# ---------------------------------------------------------------------------
# fetch: Cline task folders come in pairs
# ---------------------------------------------------------------------------

CLINE_FILES = ("api_conversation_history.json", "ui_messages.json")


def task_key(repo: str, ref: str, folder: str) -> str:
    return hashlib.sha1(f"{repo}|{ref}|{folder}".encode()).hexdigest()


def cline_task_dirs(index: list[dict]) -> list[dict]:
    """Collapse the two search queries into one row per task folder."""
    folders: dict[str, dict] = {}
    for row in index:
        if row["tool"] != "cline-task":
            continue
        if not row.get("ref"):
            continue
        folder = row["path"].rsplit("/", 1)[0] if "/" in row["path"] else ""
        key = task_key(row["repo"], row["ref"], folder)
        folders.setdefault(
            key,
            {
                "key": key,
                "repo": row["repo"],
                "ref": row["ref"],
                "folder": folder,
                "tool": "cline-task",
            },
        )
    return list(folders.values())


def cline_cache(raw_dir: Path, task: dict, name: str) -> Path:
    return raw_dir / "cline-task" / task["key"][:2] / f"{task['key']}-{name}"


def fetch_cline_task(raw_dir: Path, task: dict, max_bytes: int) -> str:
    got = 0
    for name in CLINE_FILES:
        dest = cline_cache(raw_dir, task, name)
        marker = dest.with_suffix(dest.suffix + ".missing")
        if dest.exists():
            got += 1
            continue
        if marker.exists():
            continue
        path = f"{task['folder']}/{name}" if task["folder"] else name
        url = (
            "https://raw.githubusercontent.com/"
            f"{task['repo']}/{task['ref']}/" + urllib.parse.quote(path)
        )
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "token-forecaster-corpus/1"}
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text("toobig")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            got += 1
        except urllib.error.HTTPError:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("404")
        except Exception:
            pass
    return "both" if got == 2 else "partial" if got == 1 else "none"


def fetch_cline_tasks(raw_dir: Path, tasks: list[dict], max_bytes: int, workers: int, log):
    stats: Counter = Counter()
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = [pool.submit(fetch_cline_task, raw_dir, task, max_bytes) for task in tasks]
        for done, job in enumerate(futures.as_completed(jobs), 1):
            stats[job.result()] += 1
            if done % 100 == 0:
                log(f"[fetch cline-task] {done}/{len(tasks)} {dict(stats)}")
    log(f"[fetch cline-task] done {dict(stats)}")
    return stats


# ---------------------------------------------------------------------------
# row emission
# ---------------------------------------------------------------------------


def emit(turn: dict, licenses: dict, calls_out: list, turns_out: list, estimator, stats):
    """Write one turn's call rows and its turn-table row.

    `turn` is the normalised shape every source produces:
      source, user, session, turn_index, turn_root_id, text, exact, calls[]
    Each call carries at least output_tokens/usage_source; estimated ones arrive
    with `text` instead and are counted here.
    """
    pending = [call for call in turn["calls"] if call.get("output_tokens") is None]
    if pending:
        counts = estimator.count_many([call.get("visible_text") or "" for call in pending])
        for call, count in zip(pending, counts):
            call["output_tokens"] = count
            call["usage_source"] = "estimated"
            call["visible_text_only"] = True
            call["visible_chars"] = len(call.get("visible_text") or "")
    total = sum(call["output_tokens"] for call in turn["calls"])
    if total <= 0 or not turn["calls"]:
        stats["drop:zero-output"] += 1
        return
    text = turn.get("text")
    text = text.strip() if isinstance(text, str) else None
    license_id = licenses.get(turn["user"])
    sources = {call["usage_source"] for call in turn["calls"]}
    turn_usage = sources.pop() if len(sources) == 1 else "mixed"
    for call_index, call in enumerate(turn["calls"]):
        row = {
            "dataset": DATASET,
            "source": turn["source"],
            "user": turn["user"],
            "session": turn["session"],
            "turn_index": turn["turn_index"],
            "call_index": call_index,
            "turn_root_id": turn["turn_root_id"],
            "model": call.get("model"),
            "output_tokens": call["output_tokens"],
            "usage_source": call["usage_source"],
            "visible_text_only": call.get("visible_text_only", False),
            "visible_chars": call.get("visible_chars"),
            "reasoning_tokens": call.get("reasoning_tokens"),
            "tool_names": call.get("tool_names"),
            "largest_tool_input_chars": call.get("largest_tool_input_chars"),
            "stop_reason": call.get("stop_reason"),
            "loop_depth": call.get("loop_depth", call_index),
            "prompt_chars": len(text) if (call_index == 0 and text) else None,
            "text": text if call_index == 0 else None,
            "license": license_id,
        }
        calls_out.append(row)
        stats[f"calls:{turn['source']}"] += 1
    turns_out.append(
        {
            "dataset": DATASET,
            "source": turn["source"],
            "user": turn["user"],
            "session": turn["session"],
            "turn_index": turn["turn_index"],
            "turn_root_id": turn["turn_root_id"],
            "calls": len(turn["calls"]),
            "output_tokens": total,
            "opener_tokens": turn["calls"][0]["output_tokens"],
            "usage_source": turn_usage,
            "visible_text_only": all(
                call.get("visible_text_only", False) for call in turn["calls"]
            ),
            "model": turn["calls"][0].get("model"),
            "exact": turn.get("exact", True),
            "prompt_chars": len(text) if text else None,
            "text": text,
            "license": license_id,
        }
    )
    stats[f"turns:{turn['source']}"] += 1


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(DEFAULT_DIR))
    ap.add_argument("--md-raw-dir", default=str(MD_DIR))
    ap.add_argument(
        "--sources",
        default="claude-code,cline-task,codex,aider,specstory,cline",
        help="comma separated; the first three are fetched, the last three are "
        "reparsed from the flat harvester's cache",
    )
    ap.add_argument("--pages", type=int, default=10)
    ap.add_argument("--max-files-per-repo", type=int, default=25)
    ap.add_argument("--max-files-per-source", type=int, default=4000)
    ap.add_argument("--max-bytes", type=int, default=20_000_000)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--refresh-search", action="store_true")
    ap.add_argument("--skip-search", action="store_true")
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--seed", type=int, default=20260904)
    args = ap.parse_args()

    def log(message):
        print(message, flush=True)

    out_dir = Path(args.dir)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    sources = [s for s in args.sources.split(",") if s]
    fetched = [s for s in sources if s in QUERIES]
    reparsed = [s for s in sources if s in MD_SOURCES]

    index: list[dict] = []
    index_path = raw_dir / "index.jsonl"
    if fetched:
        if args.skip_search:
            index = load_index(index_path) if index_path.exists() else []
        else:
            index = build_index(
                index_path, QUERIES, fetched, args.pages, args.refresh_search, log
            )
        for row in index:
            row.setdefault("ext", EXT.get(row["tool"], ".md"))
        index = [row for row in index if row["tool"] in fetched]
        log(f"[index] {len(index)} blobs, {len({r['repo'] for r in index})} repos")

    rng = random.Random(args.seed)
    stats: Counter = Counter()

    # --- pick and fetch -----------------------------------------------------
    picked: list[dict] = []
    for tool in ("claude-code", "codex"):
        if tool not in fetched:
            continue
        rows = [r for r in index if r["tool"] == tool]
        rng.shuffle(rows)
        per_repo: Counter = Counter()
        chosen = []
        for row in rows:
            if per_repo[row["repo"]] >= args.max_files_per_repo:
                continue
            per_repo[row["repo"]] += 1
            chosen.append(row)
            if len(chosen) >= args.max_files_per_source:
                break
        log(f"[pick] {tool}: {len(chosen)} files across {len(per_repo)} repos")
        picked.extend(chosen)

    tasks: list[dict] = []
    if "cline-task" in fetched:
        tasks = cline_task_dirs(index)
        rng.shuffle(tasks)
        per_repo = Counter()
        kept = []
        for task in tasks:
            if per_repo[task["repo"]] >= args.max_files_per_repo:
                continue
            per_repo[task["repo"]] += 1
            kept.append(task)
        tasks = kept
        log(f"[pick] cline-task: {len(tasks)} task folders across {len(per_repo)} repos")

    if not args.skip_fetch:
        if picked:
            fetch_all(raw_dir, picked, args.max_bytes, args.workers, log)
        if tasks:
            fetch_cline_tasks(raw_dir, tasks, args.max_bytes, args.workers, log)

    # --- markdown cache (no refetch) ---------------------------------------
    md_raw = Path(args.md_raw_dir)
    md_index: list[dict] = []
    if reparsed and (md_raw / "index.jsonl").exists():
        md_index = [
            row
            for row in load_index(md_raw / "index.jsonl")
            if row["tool"] in reparsed and blob_path(md_raw, row).exists()
        ]
        log(f"[markdown] {len(md_index)} cached blobs to reparse")

    repos = sorted(
        {r["repo"] for r in picked}
        | {t["repo"] for t in tasks}
        | {r["repo"] for r in md_index}
    )
    # The flat harvester already resolved every markdown repository. Seed this
    # dataset's cache from its answers BEFORE asking GitHub, or a rerun spends
    # ~1,600 REST calls re-learning licenses that are already on disk.
    repos_cache = raw_dir / "repos.json"
    md_repos_cache = md_raw / "repos.json"
    if md_repos_cache.exists():
        seeded = json.loads(md_repos_cache.read_text())
        if repos_cache.exists():
            seeded.update(json.loads(repos_cache.read_text()))
        repos_cache.write_text(json.dumps(seeded))
    licenses = load_licenses(repos_cache, repos, log)

    estimator = Estimator()
    calls_out: list[dict] = []
    turns_out: list[dict] = []

    # --- claude-code --------------------------------------------------------
    if "claude-code" in fetched:
        staging = raw_dir / "staging-claude"
        claude_rows = [r for r in picked if r["tool"] == "claude-code"]
        stage_claude(raw_dir, claude_rows, staging, log)
        loader_out = raw_dir / "claude-calls.jsonl"
        try:
            loaded = run_claude_loader(staging, loader_out, log)
        except RuntimeError as err:
            log(f"[claude-code] SKIPPED: {err}")
            loaded = []
        sha_to_repo = {r["sha"]: r["repo"] for r in claude_rows}
        for turn in claude_sessions(loaded, sha_to_repo, stats):
            emit(turn, licenses, calls_out, turns_out, estimator, stats)

    # --- cline-task ---------------------------------------------------------
    if "cline-task" in fetched:
        for task in tasks:
            history_path = cline_cache(raw_dir, task, CLINE_FILES[0])
            if not history_path.exists():
                continue
            try:
                history = json.loads(history_path.read_text(errors="replace"))
            except Exception:
                stats["drop:cline-unparseable"] += 1
                continue
            if not isinstance(history, list):
                stats["drop:cline-unparseable"] += 1
                continue
            ui = None
            ui_path = cline_cache(raw_dir, task, CLINE_FILES[1])
            if ui_path.exists():
                try:
                    loaded_ui = json.loads(ui_path.read_text(errors="replace"))
                    ui = loaded_ui if isinstance(loaded_ui, list) else None
                except Exception:
                    ui = None
            parsed, aligned = parse_cline_task(history, ui, stats)
            session = f"cline-task:{task['key']}"
            for turn_index, turn in enumerate(parsed):
                if not turn["calls"]:
                    continue
                emit(
                    {
                        "source": "cline-task",
                        "user": task["repo"],
                        "session": session,
                        "turn_index": turn_index,
                        "turn_root_id": f"{task['key']}:{turn_index}",
                        "text": turn["text"],
                        "calls": [
                            {
                                "model": None,
                                "output_tokens": call.get("output_tokens"),
                                "usage_source": "native:cline"
                                if call.get("output_tokens") is not None
                                else None,
                                "visible_text_only": False,
                                "visible_text": call["text"],
                                "visible_chars": call["visible"],
                                "tool_names": call["tools"],
                                "largest_tool_input_chars": call["largest"],
                                "stop_reason": None,
                            }
                            for call in turn["calls"]
                        ],
                    },
                    licenses,
                    calls_out,
                    turns_out,
                    estimator,
                    stats,
                )
            stats["cline:tasks"] += 1
            stats["cline:tasks-with-usage"] += 1 if aligned else 0

    # --- codex --------------------------------------------------------------
    if "codex" in fetched:
        for row in [r for r in picked if r["tool"] == "codex"]:
            path = blob_path(raw_dir, row)
            if not path.exists():
                continue
            try:
                text = path.read_text(errors="replace")
            except Exception:
                continue
            parsed = parse_codex(text, stats)
            session = f"codex:{row['sha']}"
            for turn_index, turn in enumerate(parsed):
                if not turn["calls"]:
                    continue
                emit(
                    {
                        "source": "codex",
                        "user": row["repo"],
                        "session": session,
                        "turn_index": turn_index,
                        "turn_root_id": f"{row['sha']}:{turn_index}",
                        "text": turn["text"],
                        "calls": [
                            {
                                "model": call["model"],
                                "output_tokens": call["output_tokens"],
                                "reasoning_tokens": call.get("reasoning_tokens"),
                                "usage_source": "native:codex",
                                "visible_text_only": False,
                                "tool_names": call["tools"],
                                "largest_tool_input_chars": None,
                                "stop_reason": None,
                            }
                            for call in turn["calls"]
                        ],
                    },
                    licenses,
                    calls_out,
                    turns_out,
                    estimator,
                    stats,
                )

    # --- markdown reparse ---------------------------------------------------
    for row in md_index:
        try:
            text = blob_path(md_raw, row).read_text(errors="replace")
        except Exception:
            stats["drop:unreadable"] += 1
            continue
        tool = row["tool"]
        try:
            parsed = list(markdown_turns(tool, text))
        except Exception:
            stats["drop:parse-error"] += 1
            continue
        per_part: Counter = Counter()
        for turn in parsed:
            human = (turn["text"] or "").strip()
            if tool == "aider":
                from harvest_common import aider_command

                human, _command = aider_command(human)
                human = human.strip()
            blocks = [b for b in turn["blocks"] if b.strip()]
            if not human or not blocks:
                stats[f"drop:{tool}-empty"] += 1
                continue
            part = turn["session_part"]
            session = f"{tool}:{row['sha']}"
            if tool == "aider":
                session = f"aider:{row['sha']}:{part}"
            turn_index = per_part[session]
            per_part[session] += 1
            native = turn.get("native")
            if native is not None and len(blocks) == 1:
                calls = [
                    {
                        "model": turn.get("model"),
                        "output_tokens": native,
                        "usage_source": "native:aider",
                        "visible_text_only": False,
                        "visible_chars": len(blocks[0]),
                        "tool_names": None,
                        "largest_tool_input_chars": None,
                        "stop_reason": None,
                    }
                ]
            else:
                calls = [
                    {
                        "model": turn.get("model"),
                        "output_tokens": None,
                        "usage_source": None,
                        "visible_text": block,
                        "tool_names": SPEC_TOOL_NAME.findall(block) or None
                        if tool == "specstory"
                        else [m.group(1) for m in CLINE_XML_TOOL.finditer(block)] or None,
                        "largest_tool_input_chars": None,
                        "stop_reason": None,
                    }
                    for block in blocks
                ]
            emit(
                {
                    "source": tool,
                    "user": row["repo"],
                    "session": session,
                    "turn_index": turn_index,
                    "turn_root_id": f"{row['sha']}:{part}:{turn_index}",
                    "text": human,
                    "calls": calls,
                },
                licenses,
                calls_out,
                turns_out,
                estimator,
                stats,
            )

    # --- write --------------------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    calls_path = out_dir / "calls.jsonl"
    turns_path = out_dir / "turns.jsonl"
    with calls_path.open("w") as handle:
        for row in calls_out:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with turns_path.open("w") as handle:
        for row in turns_out:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    log(f"[write] {len(calls_out)} calls, {len(turns_out)} turns -> {out_dir}")
    log("[stats] " + json.dumps(dict(sorted(stats.items()))))

    summary = {
        "stats": dict(sorted(stats.items())),
        "queries": QUERIES,
        "sources": sources,
        "calls": len(calls_out),
        "turns": len(turns_out),
        "sessions": len({r["session"] for r in turns_out}),
        "users": len({r["user"] for r in turns_out}),
        "per_source_calls": dict(Counter(r["source"] for r in calls_out)),
        "per_source_turns": dict(Counter(r["source"] for r in turns_out)),
        "usage_source": dict(Counter(r["usage_source"] for r in calls_out)),
    }
    (out_dir / "harvest-summary.json").write_text(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

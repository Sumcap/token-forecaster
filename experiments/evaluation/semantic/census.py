#!/usr/bin/env python3
"""
The corpus census `docs/PLAN-OF-ATTACK.md` Track 2 asks for before any model is
fitted: turns, sessions, users and calls per source, in one artifact.

    node experiments/evaluation/export-turn-text.mjs --out "$SCRATCH/turns.jsonl"
    python3 experiments/evaluation/semantic/census.py --local "$SCRATCH/turns.jsonl"

Writes `experiments/artifacts/census.json` and prints the markdown table that
`docs/CORPUS.md` carries. NUMBERS ONLY: no prompt text, no example, no quote
leaves this script, and every input it reads is a gitignored research file.

Three structural flags are declared per source rather than measured, because
they are properties of the FORMAT, not of the sample:

  loop    the source records more than one model call per human turn -- a real
          agent ladder rather than one prompt and one reply.
  cycle   a session holds several human turns in sequence.
  row_ts  the emitted rows carry a wall clock. This is false for every public
          source even where the underlying file has timestamps (Claude Code
          transcripts do), because the harvester deliberately does not emit
          them: folds on public data are leave-user-out and leave-source-out,
          never chronological.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PUBLIC = REPO_ROOT / "experiments/datasets/public"
DEFAULT_OUT = REPO_ROOT / "experiments/artifacts/census.json"

DECLARED = {
    "github-agent-chats": {
        "loop": False,
        "cycle": True,
        "row_ts": False,
        "note": "rendered markdown flattened to prompt->reply; `calls` is a "
        "rendering artifact for aider and Cursor exports",
    },
    "claude-code": {
        "loop": True,
        "cycle": True,
        "row_ts": False,
        "note": "cut by the shipped loader; native per-call usage",
    },
    "cline-task": {
        "loop": True,
        "cycle": True,
        "row_ts": False,
        "note": "native tokensOut per request where ui_messages.json aligns",
    },
    "codex": {
        "loop": True,
        "cycle": True,
        "row_ts": False,
        "note": "native output and reasoning tokens per call",
    },
    "aider": {
        "loop": False,
        "cycle": True,
        "row_ts": False,
        "note": "one model response per turn; native tokens from aider's own "
        "`Tokens: ... received` line where present",
    },
    "specstory": {
        "loop": False,
        "cycle": True,
        "row_ts": False,
        "note": "rendered markdown; estimated labels only",
    },
    "cline": {
        "loop": True,
        "cycle": True,
        "row_ts": False,
        "note": "rendered markdown export of a Cline task; estimated labels",
    },
    "agent-sessions": {
        "loop": True,
        "cycle": True,
        "row_ts": False,
        "note": "all Tier A sources pooled",
    },
    "wildchat": {
        "loop": False,
        "cycle": True,
        "row_ts": False,
        "note": "Tier C. The source conversations are multi-turn, but the built "
        "slice keeps only the first turn of each, so turns per session is 1 "
        "until the multi-turn extraction of PLAN-OF-ATTACK Tier C is done",
    },
    "swebench-trajs": {
        "loop": True,
        "cycle": False,
        "row_ts": False,
        "note": "Tier B. One task per session, no per-step usage in the file",
    },
    "local": {
        "loop": True,
        "cycle": True,
        "row_ts": True,
        "note": "the owner's own Claude Code corpus; native usage, real "
        "timestamps, the only chronological folds in the project",
    },
}


def quantile(values: list[float], q: float):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))
    return ordered[index]


def summarise(
    name: str,
    turns: list[dict],
    calls_by_usage: Counter | None,
    extra: dict | None = None,
) -> dict:
    """One census row.

    `turns` rows must carry: user, session, calls, total, prompt_chars, license.
    `calls_by_usage` is the per-call usage-source histogram where per-call rows
    exist; where they do not, it is derived from the turn rows.
    """
    per_turn_calls = [t["calls"] for t in turns]
    totals = [t["total"] for t in turns]
    prompts = [t["prompt_chars"] for t in turns if t["prompt_chars"]]
    per_session = Counter(t["session"] for t in turns)
    calls = calls_by_usage or Counter()
    total_calls = sum(calls.values()) or sum(per_turn_calls)
    native = sum(count for source, count in calls.items() if str(source).startswith("native"))
    declared = DECLARED.get(name, {})
    row = {
        "source": name,
        "turns": len(turns),
        "sessions": len(per_session),
        "users": len({t["user"] for t in turns}),
        "calls": total_calls,
        "calls_per_turn_median": quantile(per_turn_calls, 0.5),
        "calls_per_turn_p90": quantile(per_turn_calls, 0.9),
        "turn_total_median": quantile(totals, 0.5),
        "turn_total_p90": quantile(totals, 0.9),
        "turn_total_sum": sum(totals),
        "turns_per_session_median": quantile(list(per_session.values()), 0.5),
        "native_usage_fraction": round(native / total_calls, 4) if total_calls else 0.0,
        "usage_sources": dict(calls.most_common()) if calls else None,
        "prompt_chars_median": quantile(prompts, 0.5),
        "prompt_chars_p90": quantile(prompts, 0.9),
        "prompt_present_fraction": round(len(prompts) / len(turns), 4) if turns else 0.0,
        "licenses": dict(Counter(str(t["license"]) for t in turns).most_common()),
        "loop": declared.get("loop"),
        "cycle": declared.get("cycle"),
        "row_timestamps": declared.get("row_ts"),
        "note": declared.get("note"),
    }
    if extra:
        row.update(extra)
    return row


def read_jsonl(path: Path):
    with path.open() as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def flat_rows(path: Path, kind: str):
    """`github-agent-chats` and the WildChat slices share the flat turn schema.

    They do NOT share what its two id columns mean, and reading them the same
    way would report nonsense. In `github-agent-chats`, `sessionId` is the
    repository -- the fold key, one per user -- and the session is the history
    FILE, which is the prefix of `turnRootId`. In the WildChat slices,
    `sessionId` is the submitter's hashed IP (the user) and `turnRootId` is the
    conversation hash (the session).
    """
    for row in read_jsonl(path):
        text = row.get("text") or ""
        root = str(row.get("turnRootId") or "")
        if kind == "github-agent-chats":
            user = row.get("repo") or row.get("sessionId")
            session = root.split(":")[0] or user
        else:
            user = row.get("sessionId")
            session = root or user
        yield {
            "user": user,
            "session": session,
            "calls": row.get("calls", 1),
            "total": row.get("total", 0),
            "prompt_chars": len(text),
            "license": row.get("license"),
            "tool": row.get("tool"),
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--public", default=str(PUBLIC))
    ap.add_argument("--local", default=None, help="export-turn-text.mjs output")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()
    public = Path(args.public)
    rows: list[dict] = []

    # --- Tier A flat (the corpus the semantic probes were graded on) --------
    flat_path = public / "github-agent-chats/turns.jsonl"
    if flat_path.exists():
        flat = list(flat_rows(flat_path, "github-agent-chats"))
        rows.append(
            summarise(
                "github-agent-chats",
                flat,
                Counter({"estimated": sum(t["calls"] for t in flat)}),
                {"per_tool_turns": dict(Counter(t["tool"] for t in flat).most_common())},
            )
        )

    # --- Tier A per-call ----------------------------------------------------
    sessions_dir = public / "agent-sessions"
    turns_path = sessions_dir / "turns.jsonl"
    calls_path = sessions_dir / "calls.jsonl"
    if turns_path.exists():
        by_source: dict[str, list[dict]] = defaultdict(list)
        pooled: list[dict] = []
        for row in read_jsonl(turns_path):
            shaped = {
                "user": row["user"],
                "session": row["session"],
                "calls": row["calls"],
                "total": row["output_tokens"],
                "prompt_chars": row.get("prompt_chars") or 0,
                "license": row.get("license"),
            }
            by_source[row["source"]].append(shaped)
            pooled.append(shaped)
        usage: dict[str, Counter] = defaultdict(Counter)
        pooled_usage: Counter = Counter()
        tools: dict[str, Counter] = defaultdict(Counter)
        if calls_path.exists():
            for row in read_jsonl(calls_path):
                usage[row["source"]][row["usage_source"]] += 1
                pooled_usage[row["usage_source"]] += 1
                for name in row.get("tool_names") or []:
                    tools[row["source"]][name] += 1
        for name in sorted(by_source):
            rows.append(
                summarise(
                    name,
                    by_source[name],
                    usage.get(name),
                    {"top_tools": dict(tools[name].most_common(10)) or None},
                )
            )
        rows.append(summarise("agent-sessions", pooled, pooled_usage))

    # --- Tier B -------------------------------------------------------------
    steps_path = public / "swebench-trajs/steps.jsonl"
    if steps_path.exists():
        per_task: dict[tuple, dict] = {}
        usage: Counter = Counter()
        for row in read_jsonl(steps_path):
            key = (row["submission"], row["task"])
            entry = per_task.setdefault(
                key,
                {
                    "user": row["submission"],
                    "session": f"{row['submission']}:{row['task']}",
                    "calls": 0,
                    "total": 0,
                    "prompt_chars": 0,
                    "license": "MIT",
                },
            )
            entry["calls"] += 1
            entry["total"] += row["output_tokens"]
            usage[row["usage_source"]] += 1
        rows.append(summarise("swebench-trajs", list(per_task.values()), usage))

    # --- Tier C -------------------------------------------------------------
    wild = []
    slices = {}
    for name in ("wildchat-coding", "wildchat-general"):
        path = public / name / "turns.jsonl"
        if not path.exists():
            continue
        part = list(flat_rows(path, "wildchat"))
        slices[name] = len(part)
        wild.extend(part)
    if wild:
        rows.append(
            summarise(
                "wildchat",
                wild,
                Counter({"estimated": sum(t["calls"] for t in wild)}),
                {"slices": slices},
            )
        )

    # --- the local corpus ---------------------------------------------------
    if args.local:
        local_path = Path(args.local)
        if Path(local_path).resolve().is_relative_to(REPO_ROOT):
            raise SystemExit(
                f"refusing to read a prompt-text export from inside the repository: {local_path}"
            )
        local = []
        for row in read_jsonl(local_path):
            local.append(
                {
                    "user": "owner",
                    "session": row.get("sessionId") or "unknown",
                    "calls": row.get("calls", 1),
                    "total": row.get("total", 0),
                    "prompt_chars": len(row.get("text") or ""),
                    "license": "private",
                }
            )
        rows.append(
            summarise(
                "local",
                local,
                Counter({"native:claude-code": sum(t["calls"] for t in local)}),
            )
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    artifact = {
        "generated_by": "experiments/evaluation/semantic/census.py",
        "purpose": "docs/PLAN-OF-ATTACK.md Track 2: census before modelling",
        "fold_rules": {
            "public": ["leave-user-out (repository)", "leave-source-out"],
            "forbidden": [
                "chronological folds on public data: the rows carry no wall "
                "clock and harvest order is not time order"
            ],
            "local": ["chronological session folds"],
        },
        "sources": rows,
    }
    out.write_text(json.dumps(artifact, indent=2) + "\n")

    header = (
        "| source | turns | sessions | users | calls | calls/turn med | calls/turn p90 "
        "| turn total med | turn total p90 | native usage | prompt chars med | prompt chars p90 "
        "| loop | cycle | timestamps |"
    )
    print(header)
    print("|" + "---|" * 15)
    for row in rows:
        print(
            "| {source} | {turns:,} | {sessions:,} | {users:,} | {calls:,} | {cm} | {cp} "
            "| {tm} | {tp} | {native:.0%} | {pm} | {pp} | {loop} | {cycle} | {ts} |".format(
                source=row["source"],
                turns=row["turns"],
                sessions=row["sessions"],
                users=row["users"],
                calls=row["calls"],
                cm=row["calls_per_turn_median"],
                cp=row["calls_per_turn_p90"],
                tm=f"{row['turn_total_median']:,}" if row["turn_total_median"] else "-",
                tp=f"{row['turn_total_p90']:,}" if row["turn_total_p90"] else "-",
                native=row["native_usage_fraction"],
                pm=f"{row['prompt_chars_median']:,}" if row["prompt_chars_median"] else "-",
                pp=f"{row['prompt_chars_p90']:,}" if row["prompt_chars_p90"] else "-",
                loop="yes" if row["loop"] else "no",
                cycle="yes" if row["cycle"] else "no",
                ts="yes" if row["row_timestamps"] else "no",
            )
        )
    print(f"\nwrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

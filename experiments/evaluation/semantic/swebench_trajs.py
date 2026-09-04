#!/usr/bin/env python3
"""
Tier B of `docs/PLAN-OF-ATTACK.md` Track 2: the mini-SWE-agent trajectories
published alongside the SWE-bench leaderboard.

The plan wants Tier B for three things -- the loop-dynamics prior, the
re-forecast-at-k question on true per-step tokens, and the ratio of hidden
thinking to visible text by effort level. The first is answerable from these
files; the last two are NOT, and this script is what establishes that. See
`docs/CORPUS.md` and the MANIFEST for the finding.

Where the data lives
--------------------
`SWE-bench/experiments` on GitHub holds one directory per submission under
`evaluation/<split>/<submission>/`, each with a `metadata.yaml` whose `assets`
block points at the trajectories. Two eras:

    assets.trajs: s3://swe-bench-submissions/<prefix>/<submission>/trajs   (older)
    assets.trajs: https://github.com/<owner>/<submission>/tree/main/trajs  (newer)

The bucket is `swe-bench-submissions`, us-east-1, and it is readable ANONYMOUSLY
(`--no-sign-request`) -- but only for a non-empty prefix that the bucket policy
allows. `aws s3 ls s3://swe-bench-submissions/` at the root returns AccessDenied,
so keys have to be built from `metadata.yaml`, never discovered by listing.

Layout under a submission:

    <prefix>/<submission>/trajs/<instance_id>/<instance_id>.traj.json
    <prefix>/<submission>/logs/<instance_id>/...

Usage:

    python3 experiments/evaluation/semantic/swebench_trajs.py keys
    python3 experiments/evaluation/semantic/swebench_trajs.py probe
    python3 experiments/evaluation/semantic/swebench_trajs.py pull \\
        --submission 20260219_mini-v2.0.0_gpt-5-2-codex --limit 60
    python3 experiments/evaluation/semantic/swebench_trajs.py parse

Output goes to `experiments/datasets/public/swebench-trajs/` (gitignored; only
MANIFEST.md is committed).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DIR = REPO_ROOT / "experiments/datasets/public/swebench-trajs"
EXPERIMENTS_REPO = "SWE-bench/experiments"
SPLITS = ("verified", "lite", "test", "multimodal", "multilingual")
BUCKET = "swe-bench-submissions"
# `20250214_agentless_lite_o3_mini` is not a mini-SWE-agent run -- `o3-mini` is
# the MODEL. Submissions are therefore classified on `metadata.yaml`
# (`tags.agent` / `info.mini-swe-agent_version`), never on the directory name,
# which costs one REST call per submission and is cached on disk.
MINI_AGENT = re.compile(r"mini[-_ ]?swe[-_ ]?agent", re.I)


def quantile(values: list[float], q: float):
    """Nearest-rank quantile over 0..n-1, matching `census.py`."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def gh_json(args: list[str]):
    proc = subprocess.run(["gh", "api", *args], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:400])
    return json.loads(proc.stdout)


def gh_text(path: str) -> str:
    proc = subprocess.run(
        ["gh", "api", "-H", "Accept: application/vnd.github.raw", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:400])
    return proc.stdout


# ---------------------------------------------------------------------------
# 1. key list
# ---------------------------------------------------------------------------


def load_metadata(out_dir: Path, split: str, name: str):
    """`metadata.yaml` for one submission, cached under the dataset's raw dir."""
    import yaml

    cache = out_dir / "raw" / "metadata" / split / f"{name}.yaml"
    if not cache.exists():
        path = (
            f"repos/{EXPERIMENTS_REPO}/contents/evaluation/{split}/{name}/metadata.yaml"
        )
        try:
            body = gh_text(path)
        except RuntimeError:
            body = ""
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(body)
    try:
        return yaml.safe_load(cache.read_text()) or {}
    except Exception:
        return {}


def is_mini(meta: dict) -> bool:
    tags = meta.get("tags") or {}
    info = meta.get("info") or {}
    if info.get("mini-swe-agent_version"):
        return True
    for field in ("agent", "agent_org", "system_display", "model_display"):
        value = tags.get(field)
        if isinstance(value, str) and MINI_AGENT.search(value):
            return True
    return False


def build_keys(out_dir: Path, log) -> list[dict]:
    rows: list[dict] = []
    for split in SPLITS:
        try:
            entries = gh_json([f"repos/{EXPERIMENTS_REPO}/contents/evaluation/{split}"])
        except RuntimeError as err:
            log(f"[keys] {split}: {err}")
            continue
        names = sorted(e["name"] for e in entries if e.get("type") == "dir")
        found = 0
        for name in names:
            meta = load_metadata(out_dir, split, name)
            if not is_mini(meta):
                continue
            found += 1
            assets = meta.get("assets") or {}
            trajs = assets.get("trajs")
            tags = meta.get("tags") or {}
            info = meta.get("info") or {}
            kind = (
                "s3"
                if isinstance(trajs, str) and trajs.startswith("s3://")
                else "github"
                if isinstance(trajs, str) and trajs.startswith("http")
                else "none"
            )
            prefix = None
            if kind == "s3":
                # s3://<bucket>/<prefix>/<submission>/trajs
                rest = trajs[len("s3://") :]
                _bucket, _, key = rest.partition("/")
                prefix = key.rstrip("/")
            model = tags.get("model")
            rows.append(
                {
                    "split": split,
                    "submission": name,
                    "trajs": trajs,
                    "trajs_kind": kind,
                    "s3_prefix": prefix,
                    "model": model[0] if isinstance(model, list) and model else model,
                    "reasoning_effort": tags.get("reasoning_effort"),
                    "agent_version": info.get("mini-swe-agent_version"),
                    "resolved": info.get("resolved"),
                    "instance_calls": info.get("instance_calls"),
                }
            )
        log(f"[keys] {split}: {found} mini-SWE-agent of {len(names)} submissions")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "keys.json").write_text(json.dumps(rows, indent=2))
    log(
        f"[keys] {len(rows)} mini-SWE-agent submissions; "
        + json.dumps(dict(Counter(r["trajs_kind"] for r in rows)))
    )
    return rows


# ---------------------------------------------------------------------------
# 2. one-submission smoke pull
# ---------------------------------------------------------------------------


def list_trajectories(prefix: str) -> list[tuple[str, str]]:
    """(instance_id, key) for one submission's `trajs` prefix.

    Two layouts are in the bucket and neither is documented:

        <prefix>/<instance_id>/<instance_id>.traj.json   (nested)
        <prefix>/<instance_id>.traj.json                 (flat)

    Listing only the `PRE` lines finds the first and silently reports the
    second as empty, which is what 16 of the 62 submissions looked like before
    this handled both.
    """
    listing = subprocess.run(
        ["aws", "s3", "ls", f"s3://{BUCKET}/{prefix}/", "--no-sign-request"],
        capture_output=True,
        text=True,
        check=False,
    )
    if listing.returncode != 0:
        return []
    nested = [
        line.split("PRE ")[1].strip().rstrip("/")
        for line in listing.stdout.splitlines()
        if "PRE " in line
    ]
    if nested:
        return [(name, f"{prefix}/{name}/{name}.traj.json") for name in nested]
    flat = []
    for line in listing.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        name = parts[-1]
        if not name.endswith(".json"):
            continue
        flat.append((name.split(".")[0], f"{prefix}/{name}"))
    return flat


def pull(out_dir: Path, submission: str, limit: int, log) -> Path:
    keys_path = out_dir / "keys.json"
    if not keys_path.exists():
        raise SystemExit("run `keys` first")
    rows = json.loads(keys_path.read_text())
    match = [r for r in rows if r["submission"] == submission]
    if not match:
        raise SystemExit(f"no such submission in keys.json: {submission}")
    row = match[0]
    if row["trajs_kind"] != "s3":
        raise SystemExit(
            f"{submission} points at {row['trajs']}, not S3; the S3 path is the "
            "one this smoke pull covers"
        )
    dest = out_dir / "raw" / submission
    dest.mkdir(parents=True, exist_ok=True)
    # `aws s3 sync` on the whole prefix would pull every instance; the smoke
    # pull only needs enough steps to establish the schema, so instances are
    # listed first and copied one at a time up to --limit.
    entries = list_trajectories(row["s3_prefix"])
    if not entries:
        raise SystemExit(f"anonymous list returned nothing for {row['s3_prefix']}")
    entries = entries[:limit]
    log(f"[pull] {submission}: {len(entries)} instances")
    got = 0
    for instance, key in entries:
        target = dest / f"{instance}.traj.json"
        if target.exists():
            got += 1
            continue
        proc = subprocess.run(
            ["aws", "s3", "cp", f"s3://{BUCKET}/{key}", str(target), "--no-sign-request"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            got += 1
        elif got == 0:
            log(f"[pull] {instance}: {proc.stderr.strip()[:200]}")
    log(f"[pull] {got} trajectories -> {dest}")
    return dest


# ---------------------------------------------------------------------------
# 3. per-step rows
# ---------------------------------------------------------------------------

BASH_BLOCK = re.compile(r"```bash\n(.*?)```", re.S)
FIRST_WORD = re.compile(r"\s*([A-Za-z0-9_./-]+)")

# Two eras of the same file name, and only one of them can answer the plan's
# Tier B questions:
#
#   legacy   {info, messages: [{role, content}], instance_id}
#            A message has role and content and NOTHING else -- no usage, no
#            completion_tokens, no reasoning split. `info.model_stats` gives
#            `api_calls` and `instance_cost` for the WHOLE trajectory. A label
#            here is a tiktoken count of visible text, which is the same
#            estimated label Tier A already has and is not worth the download.
#   1.1      {info, messages: [...raw provider responses...], trajectory_format:
#            "mini-swe-agent-1.1", instance_id}
#            Each model step is the provider's response object, so it carries
#            `usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens`
#            and `reasoning.effort`. THIS is the per-step, reasoning-split usage
#            the plan asked for.
FORMAT_WITH_USAGE = "mini-swe-agent-1.1"


def step_action(text: str) -> str | None:
    """The command a mini-SWE-agent step ran, from its fenced bash block."""
    block = BASH_BLOCK.search(text or "")
    if not block:
        return None
    found = FIRST_WORD.match(block.group(1))
    return found.group(1) if found else None


def response_text(message: dict) -> str:
    """The visible assistant text of a raw provider response."""
    parts = []
    for item in message.get("output") or []:
        if not isinstance(item, dict):
            continue
        for block in item.get("content") or []:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
    return "\n".join(parts)


def response_action(message: dict) -> str | None:
    """The command a `mini-swe-agent-1.1` step ran.

    Under this format the step is a raw provider response, so the command is in
    a `function_call` item's JSON arguments, not in a fenced bash block; reading
    only the fence reported no tool on 60% of steps.
    """
    for item in message.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "function_call":
            continue
        try:
            arguments = json.loads(item.get("arguments") or "{}")
        except Exception:
            arguments = {}
        command = arguments.get("command")
        if isinstance(command, str):
            found = FIRST_WORD.match(command)
            if found:
                return found.group(1)
        name = item.get("name")
        if isinstance(name, str):
            return name
    return None


def parse_trajectory(path: Path, submission: str, model: str | None, encoder):
    """One row per model step of one instance, in whichever era's format."""
    body = json.loads(path.read_text(errors="replace"))
    messages = body.get("messages") or []
    info = body.get("info") or {}
    stats = info.get("model_stats") or {}
    instance = body.get("instance_id") or path.name.split(".")[0]
    fmt = body.get("trajectory_format") or "legacy"
    common = {
        "dataset": "swebench-trajs",
        "submission": submission,
        "task": instance,
        "trajectory_format": fmt,
        "instance_api_calls": stats.get("api_calls"),
        "instance_cost": stats.get("instance_cost"),
        "exit_status": info.get("exit_status"),
    }
    rows = []
    if fmt == FORMAT_WITH_USAGE:
        for message in messages:
            if not isinstance(message, dict):
                continue
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue
            details = usage.get("output_tokens_details") or {}
            output = usage.get("output_tokens")
            reasoning = details.get("reasoning_tokens")
            text = response_text(message)
            visible = len(encoder.encode_ordinary(text)) if text else 0
            text_tokens = details.get("text_tokens")
            if text_tokens is None and isinstance(output, int) and isinstance(reasoning, int):
                # The provider reports the reasoning share and leaves the text
                # share null; the difference is exact, not an estimate.
                text_tokens = output - reasoning
            rows.append(
                {
                    **common,
                    "step": len(rows),
                    "model": message.get("model") or model,
                    "effort": (message.get("reasoning") or {}).get("effort"),
                    "output_tokens": output,
                    "reasoning_tokens": reasoning,
                    "text_tokens": text_tokens,
                    "input_tokens": usage.get("input_tokens"),
                    "usage_source": "native:openai-responses",
                    "visible_text_only": False,
                    "visible_tokens": visible,
                    "visible_chars": len(text),
                    "tool": response_action(message) or step_action(text),
                    "stop_reason": message.get("status"),
                }
            )
        return rows

    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        text = content if isinstance(content, str) else json.dumps(content)
        visible = len(encoder.encode_ordinary(text))
        rows.append(
            {
                **common,
                "step": len(rows),
                "model": model,
                "effort": None,
                "output_tokens": visible,
                "reasoning_tokens": None,
                "text_tokens": visible,
                "input_tokens": None,
                "usage_source": "estimated",
                "visible_text_only": True,
                "visible_tokens": visible,
                "visible_chars": len(text),
                "tool": step_action(text),
                "stop_reason": None,
            }
        )
    return rows


def probe_formats(out_dir: Path, log) -> dict:
    """Download ONE trajectory per submission and record which era it is in.

    Which submissions carry per-step usage decides how much of Tier B is worth
    downloading at all, and it costs 60 small objects to find out rather than
    30,000.
    """
    rows = json.loads((out_dir / "keys.json").read_text())
    probe_dir = out_dir / "raw" / "_format-probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for row in rows:
        name = row["submission"]
        if row["trajs_kind"] != "s3":
            result[name] = {"format": None, "reason": row["trajs_kind"]}
            continue
        cached = probe_dir / f"{name}.json"
        if not cached.exists():
            entries = list_trajectories(row["s3_prefix"])
            if not entries:
                result[name] = {"format": None, "reason": "no instances listed"}
                continue
            instance, key = entries[0]
            proc = subprocess.run(
                ["aws", "s3", "cp", f"s3://{BUCKET}/{key}", str(cached), "--no-sign-request"],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                result[name] = {"format": None, "reason": proc.stderr.strip()[:120]}
                continue
        try:
            body = json.loads(cached.read_text(errors="replace"))
        except Exception as err:
            result[name] = {"format": None, "reason": str(err)[:120]}
            continue
        messages = body.get("messages") or []
        result[name] = {
            "format": body.get("trajectory_format") or "legacy",
            "steps_with_usage": sum(
                1 for m in messages if isinstance(m, dict) and isinstance(m.get("usage"), dict)
            ),
            "steps_with_reasoning_text": sum(
                1
                for m in messages
                if isinstance(m, dict)
                and (m.get("reasoning_content") or m.get("thinking_blocks"))
            ),
            "messages": len(messages),
            "agent_version": row.get("agent_version"),
            "effort": row.get("reasoning_effort"),
            "model": row.get("model"),
            "split": row.get("split"),
        }
        log(f"[probe] {name}: {result[name]['format']}")
    (out_dir / "format-probe.json").write_text(json.dumps(result, indent=2))
    have = sum(1 for v in result.values() if v.get("steps_with_usage"))
    log(f"[probe] {have} of {len(result)} submissions carry per-step usage")
    return result


def parse_all(out_dir: Path, log) -> int:
    import tiktoken

    encoder = tiktoken.get_encoding("o200k_base")
    keys = {
        r["submission"]: r
        for r in json.loads((out_dir / "keys.json").read_text())
    }
    raw = out_dir / "raw"
    rows: list[dict] = []
    for submission_dir in sorted(p for p in raw.glob("*") if p.is_dir()):
        model = (keys.get(submission_dir.name) or {}).get("model")
        for path in sorted(submission_dir.glob("*.traj.json")):
            try:
                rows.extend(parse_trajectory(path, submission_dir.name, model, encoder))
            except Exception as err:
                log(f"[parse] {path.name}: {err}")
    steps_path = out_dir / "steps.jsonl"
    with steps_path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tasks = len({(r["submission"], r["task"]) for r in rows})
    log(f"[parse] {len(rows)} steps over {tasks} tasks -> {steps_path}")
    per_task = Counter((r["submission"], r["task"]) for r in rows)
    lengths = sorted(per_task.values())
    with_reasoning = [r for r in rows if r.get("reasoning_tokens") is not None]
    ratios = [
        r["reasoning_tokens"] / r["output_tokens"]
        for r in with_reasoning
        if r.get("output_tokens")
    ]
    summary = {
        "steps": len(rows),
        "tasks": tasks,
        "submissions": len({r["submission"] for r in rows}),
        "usage_source": dict(Counter(r["usage_source"] for r in rows)),
        "trajectory_format": dict(Counter(r.get("trajectory_format") for r in rows)),
        "reasoning_share_median": round(sorted(ratios)[len(ratios) // 2], 4)
        if ratios
        else None,
        "steps_with_reasoning_split": len(with_reasoning),
        # Same quantile rule as census.py, so the two artifacts agree.
        "steps_per_task_median": quantile(lengths, 0.5),
        "steps_per_task_p90": quantile(lengths, 0.9),
        "steps_per_task_max": max(lengths) if lengths else None,
        "api_calls_vs_parsed_steps": {
            "declared_median": None,
            "note": "info.model_stats.api_calls counts every request; parsed "
            "steps count assistant messages that survived into the transcript",
        },
        "tools": dict(Counter(r["tool"] for r in rows).most_common(20)),
    }
    (out_dir / "parse-summary.json").write_text(json.dumps(summary, indent=2))
    log("[parse] " + json.dumps({k: summary[k] for k in ("steps", "tasks", "submissions")}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=("keys", "probe", "pull", "parse"))
    ap.add_argument("--dir", default=str(DEFAULT_DIR))
    ap.add_argument("--submission", default="20250726_mini-v1.0.0_o3-2025-04-16")
    ap.add_argument("--limit", type=int, default=60)
    args = ap.parse_args()

    def log(message):
        print(message, flush=True)

    out_dir = Path(args.dir)
    if args.command == "keys":
        build_keys(out_dir, log)
    elif args.command == "probe":
        probe_formats(out_dir, log)
    elif args.command == "pull":
        pull(out_dir, args.submission, args.limit, log)
    else:
        return parse_all(out_dir, log)
    return 0


if __name__ == "__main__":
    sys.exit(main())

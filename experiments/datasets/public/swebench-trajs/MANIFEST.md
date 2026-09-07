# swebench-trajs

Tier B of `docs/PLAN-OF-ATTACK.md` Track 2: the mini-SWE-agent trajectories
published alongside the SWE-bench leaderboard. Built 4 September 2026 by
`experiments/evaluation/semantic/swebench_trajs.py`.

`raw/`, `steps.jsonl`, `keys.json`, `format-probe.json` and `parse-summary.json`
are gitignored. Only this manifest is committed. Everything below is an
aggregate.

## Headline

**Per-step usage exists, but only for 3 of the 62 mini-SWE-agent submissions.**
The plan assumed Tier B would give ~30,000 trajectories with `completion_tokens`
split into reasoning and text. What is actually in the bucket is four different
file formats across three eras, and only the newest one — mini-SWE-agent v2.0.0
runs against the OpenAI Responses API — records a token count per step.

| what the plan wanted from Tier B | answerable? |
|---|---|
| loop-dynamics prior (calls per turn, survival curve) | **yes**, from every submission: step counts are exact in every format |
| re-forecast-at-k on true per-step tokens | **only** on the 3 usage-bearing submissions |
| hidden-thinking to visible-text ratio by effort | **only** on those 3, and only for OpenAI models |

## Access

| | |
|---|---|
| Bucket | `s3://swe-bench-submissions` (us-east-1) |
| Credentials | **none.** `--no-sign-request` reads objects and lists non-empty prefixes |
| Root listing | **denied.** `aws s3 ls s3://swe-bench-submissions/ --no-sign-request` → `AccessDenied` on `ListObjectsV2` |
| Consequence | keys must be BUILT from `metadata.yaml`, never discovered by listing |
| Key source | `SWE-bench/experiments` on GitHub, `evaluation/<split>/<submission>/metadata.yaml`, field `assets.trajs` |

Two key layouts are in use and both are handled:

```
<prefix>/<submission>/trajs/<instance_id>/<instance_id>.traj.json   nested
<prefix>/<submission>/trajs/<instance_id>.traj.json                 flat
```

`<prefix>` is whatever `assets.trajs` says; for mini submissions it is usually
`bash-only/`, `verified/` or `multilingual/`, and it does NOT always match the
`evaluation/<split>/` directory the submission lives in on GitHub. Newer
submissions (from mid-2026) point `assets.trajs` at a GitHub repository of the
submitter's instead of at S3.

## The submissions

Classified on `metadata.yaml` (`tags.agent` / `info.mini-swe-agent_version`),
never on the directory name — `20250214_agentless_lite_o3_mini` is an Agentless
run whose MODEL is `o3-mini`.

| | |
|---|---|
| submissions scanned | 326 across `verified`, `lite`, `test`, `multimodal`, `multilingual` |
| mini-SWE-agent submissions | **62** (48 verified, 14 multilingual) |
| distinct models | 47 |
| `assets.trajs` on S3 | 60 |
| `assets.trajs` on GitHub | 2 |
| declared reasoning effort | 12 high, 8 medium, 42 unset |

## What is actually downloadable, one probe trajectory per submission

| trajectory format | submissions | per-step token usage | visible reasoning text |
|---|---|---|---|
| `mini-swe-agent-1.1` (OpenAI Responses objects) | 3 | **yes** — `usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens` | in `output[].type == "reasoning"` |
| `mini-swe-agent-1.1` (LiteLLM-normalised messages) | 10 | no | yes — `reasoning_content` / `thinking_blocks` |
| `mini-swe-agent-1` | 18 | no | no |
| legacy (`{role, content}` only) | 7 | no | no |
| advertised but absent from the bucket | 16 | — | — |
| instance directory holds logs and a patch but no `.traj.json` | 6 | — | — |
| trajectories on GitHub, not S3 | 2 | — | — |

The 16 "absent" submissions declare `assets.trajs` in `metadata.yaml`, but the
prefix holds no objects at all (`.../<submission>/` contains only `logs/` and
`all_preds.jsonl`). That is a property of the bucket, not of this script.

Legacy files carry `info.model_stats` = `{instance_cost, api_calls}` for the
WHOLE trajectory and nothing per step, so a label there is a tiktoken count of
visible text — the same estimated label Tier A already has, and not worth
30,000 downloads.

## The smoke pull

Two submissions, 60 instances each, chosen to cover both eras.

| submission | format | tasks | steps | usage |
|---|---|---|---|---|
| `20250726_mini-v1.0.0_o3-2025-04-16` | legacy | 60 | 1,299 | estimated (tiktoken `o200k_base`) |
| `20260219_mini-v2.0.0_gpt-5-2-codex` | `mini-swe-agent-1.1` | 60 | 1,940 | **native**, `native:openai-responses` |
| total | | 120 | 3,239 | 60% native |

Loop shape over the 120 tasks: **median 23 steps, p90 49, max 73.** One task is
one session and one cycle: mini-SWE-agent gets a single problem statement and
never hears from a human again, so the corpus has loop structure and no cycles.

**Reasoning share of output tokens, median 0.416** over the 1,940 native steps
(one submission, `gpt-5.2`, effort unset). That is the first direct measurement
of the quantity `docs/PLAN-OF-ATTACK.md` "Risks, named" calls out — locally the
implied hidden share is about two thirds — but it is one model on one agent and
must not be applied as a correction anywhere until it is measured across the
other two usage-bearing submissions and graded.

Most-run commands over the native steps: `cd` (the harness prefixes almost every
command with `cd /testbed &&`), then `nl`, `grep`, `python`, `sed`, `ls`.

## Per-step row schema (`steps.jsonl`)

| field | value |
|---|---|
| `task` | SWE-bench instance id, e.g. `astropy__astropy-12907` |
| `step` | 0-based index of the model call within the trajectory |
| `submission`, `model`, `effort` | from `keys.json` / the response object |
| `output_tokens` | native where the format has it, else a tiktoken count of visible text |
| `reasoning_tokens` | native, `null` on every non-Responses format |
| `text_tokens` | `output_tokens - reasoning_tokens` where both are native |
| `input_tokens` | native where present |
| `usage_source` | `native:openai-responses` or `estimated` |
| `visible_text_only` | `true` on every estimated row |
| `visible_tokens`, `visible_chars` | tiktoken/character size of the rendered response |
| `tool` | first word of the bash command the step ran |
| `stop_reason` | the response `status` where present |
| `trajectory_format`, `instance_api_calls`, `instance_cost`, `exit_status` | trajectory-level context |

## Licensing

**The trajectories carry no stated licence.** `SWE-bench/experiments` is MIT,
but the trajectories are not in that repository: they are third-party
submissions under `s3://swe-bench-submissions/<prefix>/<submission>/trajs`,
each produced by a different submitting organisation, and neither the bucket
nor the submissions state terms. The census records them as `unstated` rather
than borrowing the neighbouring repository's MIT.

What is true regardless: the content is model output over public GitHub issues
from the SWE-bench task set, so no human prompt text is involved beyond the
issue statements, which are already public. Use here is research input only,
nothing is redistributed, and no derived model trained on this data should be
published without settling terms with the submitters first.

## Reproduce

```sh
python3 experiments/evaluation/semantic/swebench_trajs.py keys
python3 experiments/evaluation/semantic/swebench_trajs.py probe
python3 experiments/evaluation/semantic/swebench_trajs.py pull \
    --submission 20260219_mini-v2.0.0_gpt-5-2-codex --limit 60
python3 experiments/evaluation/semantic/swebench_trajs.py parse
```

## Left for week 2

1. Pull all three usage-bearing submissions in full (500 tasks each, ~1,500
   trajectories) — that is the whole per-step-token population Tier B has.
2. Pull the 10 LiteLLM-normalised `1.1` submissions for the loop-length prior
   and for reasoning TEXT length by model, even though they carry no counts.
3. Fit the loop-length prior as a survival curve; mini-SWE-agent caps its own
   step count, so the tail is censored (`docs/PLAN-OF-ATTACK.md` "Risks,
   named").
4. Decide whether the 2 GitHub-hosted submissions are worth a separate fetch
   path.

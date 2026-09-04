# agent-sessions

Tier A of `docs/PLAN-OF-ATTACK.md` Track 2: coding-agent sessions harvested from
public GitHub repositories as PER-CALL rows, with session structure and native
output-token usage where the format records it. Built 4 September 2026 by
`experiments/evaluation/semantic/harvest_sessions.py`.

This is the successor to `../github-agent-chats`, which flattens the same files
to prompt->reply pairs. Both stand: the flat corpus is what the semantic probes
of `docs/SEMANTIC-PLAN.md` were graded on, and its numbers must stay
reproducible.

`calls.jsonl`, `turns.jsonl`, `raw/` and `harvest-summary.json` are gitignored
and carry other people's prompt text. They are research input only: never
committed, never redistributed, never quoted. Everything below is an aggregate.

## What is in it

| | |
|---|---|
| calls | 111,891 |
| turns | 39,140 |
| sessions | 6,712 |
| users (repositories) | 1,693 |
| users with 20 or more sessions | 93 |
| users with 5 or more sessions | 350 |
| calls with NATIVE usage | 20,864 (18.6%) |
| turns whose every call is native | 4,619 |
| turn roots with prompt text after cleaning | 39,023 of 39,140 |
| raw cache on disk | 514 MB |

| source | turns | sessions | users | calls | calls/turn med, p90 | turn total med, p90 | native | users >=20 sessions |
|---|---|---|---|---|---|---|---|---|
| claude-code | 2,706 | 1,619 | 351 | 16,133 | 3, 16 | 273, 6,080 | 100% | 30 |
| aider | 2,437 | 730 | 243 | 3,382 | 1, 2 | 445, 2,600 | 43% | 4 |
| specstory | 32,843 | 3,918 | 970 | 84,697 | 1, 3 | 679, 4,378 | 0% | 53 |
| cline (markdown) | 595 | 190 | 66 | 4,175 | 4, 17 | 1,209, 6,000 | 0% | 2 |
| cline-task (JSON) | 210 | 133 | 43 | 1,384 | 3, 19 | 843, 8,416 | 84% | 1 |
| codex | 349 | 122 | 28 | 2,120 | 3, 15 | 923, 6,757 | 100% | 2 |
| **pooled** | **39,140** | **6,712** | **1,693** | **111,891** | **1, 5** | **652, 4,459** | **19%** | **93** |

## Structure

| level | key | note |
|---|---|---|
| user | `owner/repo` | the fold key. Public data has no installation id, so the repository is the closest thing to a person |
| session | one history file, or one Cline task folder | an aider history file holds many sessions and is split on `# aider chat started at` |
| turn | one human message plus every model call until the next one | `turn_root_id` |
| call | one model API call | `call_index` within the turn |

## Sources, and where the label comes from

**claude-code** — `.jsonl` transcripts people committed. Turns and calls are cut
by the SHIPPED loader, `packages/ingest-claude/load-history.mjs`, driven through
`claude_calls.mjs`: the harvester hardlinks each blob into its own staging
directory, runs `loadRequests`, and maps the loader's `workloadId` back to the
repository. Re-implementing `parentUuid` ancestry in Python would have produced
a second, silently different definition of a call and a turn, and the point of a
multi-source base is that rows from different sources are comparable.
`message.usage.output_tokens` is the label, verbatim. Every one of the 16,133
calls is a Claude model.

Two queries feed it. `path:.claude/projects extension:jsonl` finds only the
people who committed the transcript directory verbatim — 1,648 blobs across 54
repositories, far too few USERS to fold on. `"parentUuid" "requestId"
extension:jsonl` finds the same transcripts wherever they were committed, and is
what took the source from 54 repositories to 531.

**cline-task** — Cline / Roo task folders. `api_conversation_history.json` holds
Anthropic-shaped messages; `ui_messages.json` holds one `api_req_started` event
per request whose JSON `text` carries `tokensOut`. The two are aligned index for
index against the assistant messages, with two rules that matter: an event with
no usable count (`usageMissing`, a cancelled stream) KEEPS its slot, because
dropping it shifts every later count onto the wrong call; and a single trailing
event with no assistant message after it is the normal shape of a folder
committed mid-request. Where the counts still do not align, the whole folder
falls back to estimated rather than guessing an offset. 77 of 182 folders
aligned, which is 84% of the calls (the folders that do not align are mostly the
small ones).

**codex** — `~/.codex/sessions` rollouts. Parsed faithfully to
`packages/ingest-codex/src/parse.ts`: turn roots are `event_msg/user_message`
(or, on legacy rollouts, a `response_item` message with role user), calls are
`token_count` events, and the CLI's UI-refresh re-emissions are deduplicated on
(cumulative total, input, output, reasoning). `reasoning_output_tokens` is kept
where present.

**aider** — `.aider.chat.history.md`. aider prints `> Tokens: 3.2k sent, 1.1k
received.` after each exchange, which is the model's own output count; 1,449 of
3,382 calls have one. Console `> ` lines are aider's output, not the model's,
and never enter the label.

**specstory**, **cline (markdown)** — rendered markdown exports with no usage
anywhere. The label is a tiktoken `o200k_base` count of the visible model text,
`usage_source: "estimated"`, `visible_text_only: true`.

## The estimated label is a floor, not a label

Every estimated row is flagged `visible_text_only: true`. Reasoning the
transcript never rendered is missing from it. On the native `claude-code` rows
the visible content of a call is a median **2.24 characters per output token**;
the local corpus sits at 1.45, and `docs/PLAN-OF-ATTACK.md` "Risks, named" reads
that gap as hidden thinking. Public committed transcripts are thinner in
thinking than the owner's, so the two numbers are not the same measurement —
which is exactly why the correction has to be fitted against the native rows
here and in Tier B rather than assumed.

## Per-call row schema (`calls.jsonl`)

| field | value |
|---|---|
| `source` | `claude-code` \| `cline-task` \| `codex` \| `aider` \| `specstory` \| `cline` |
| `user` | `owner/repo` |
| `session` | `<source>:<blob sha>` (aider adds `:<session index in file>`; a Cline task folder is keyed by a hash of repo, ref and folder) |
| `turn_index` | 0-based index of the turn within the session |
| `call_index` | 0-based index of the call within the turn |
| `turn_root_id` | stable id of the human message the turn hangs off |
| `model` | where the format records it, else `null` (Cline never does) |
| `output_tokens` | native or estimated per `usage_source` |
| `usage_source` | `native:claude-code` \| `native:cline` \| `native:codex` \| `native:aider` \| `estimated` |
| `visible_text_only` | `true` on every estimated row |
| `visible_chars` | characters of model-authored content in the call |
| `reasoning_tokens` | Codex only |
| `tool_names` | tool names the call issued, `null` where the format does not name them |
| `largest_tool_input_chars` | biggest single tool input, `null` for the markdown formats (rendering does not preserve the input) |
| `stop_reason` | Claude Code only |
| `loop_depth` | Claude Code: the loader's depth; elsewhere the call index |
| `prompt_chars`, `text` | the cleaned turn-root prompt, on `call_index == 0` only |
| `license` | SPDX id of the repository, or `null` |

`turns.jsonl` is one row per turn root with the same ids plus `calls`,
`output_tokens`, `opener_tokens`, `usage_source` (`mixed` when a turn holds both
kinds), `visible_text_only` and `exact`.

## Loop shape, for the first time on public data

The flat corpus reads as one call per turn on 86% of rows, which is a rendering
artifact. Here the loop is real where the format records it:

| source | calls/turn median | p90 | most-issued tools |
|---|---|---|---|
| claude-code | 3 | 16 | Bash 7,366; Read 4,892; Edit 1,211; TodoWrite 999; Grep 848; Write 813 |
| cline-task | 3 | 19 | read_file, write_to_file, execute_command |
| codex | 3 | 15 | shell, apply_patch |
| local corpus, for scale | 7 | 37 | |

Claude Code `stop_reason` over the 8,516 calls that record one: 7,378
`tool_use`, 1,134 `end_turn`, 3 `max_tokens`, 1 `error`. Three censored calls in
16,133 — the same near-zero censoring rate the local corpus has.

## Licenses

Per turn, by the SPDX id of the repository the file came from.

| license | turns |
|---|---|
| none declared | 30,627 |
| MIT | 6,049 |
| NOASSERTION | 1,025 |
| Apache-2.0 | 748 |
| GPL-3.0 | 276 |
| AGPL-3.0 | 124 |
| BSD-2-Clause | 70 |
| LGPL-3.0 | 41 |
| Unlicense | 34 |
| GPL-2.0 | 31 |
| MPL-2.0 | 27 |
| BSD-3-Clause | 20 |
| LGPL-2.1 | 16 |
| BSL-1.0 | 13 |

78% of turns come from repositories with no declared license. Nothing is
redistributed and no text is committed, so this is a research-input record, not
a redistribution claim. Any use beyond in-repo aggregates has to revisit it.

## Rows dropped, and why

| stage | rows |
|---|---|
| Claude Code calls whose ancestry never reaches a human message | 705 |
| Claude Code calls whose requestId appears under two blob shas | 258 |
| aider / specstory / cline turns with no human text or no model output | 5,206 |
| Cline task folders that would not parse as JSON | 10 |
| turns whose calls summed to zero output | 4 |

A call with no turn root cannot be held out by turn and is dropped rather than
assigned to a guessed one. A duplicated requestId cannot be attributed to a
repository and so cannot be held out by user either.

## Known biases and caveats

- **specstory still dominates the turn count** (84% of turns) and contributes no
  native usage and no real loop. Read every pooled number per source as well.
- **Native usage is 19% of calls and 12% of turns.** The stranger gate of
  `docs/PLAN-OF-ATTACK.md` Track 3 should be run on the native subset first.
- **351 claude-code users, 30 with 20 or more sessions.** That is the real
  ceiling on leave-user-out for the flagship source right now.
- **Committed transcripts are a selected population**: people who did not
  gitignore `.claude/projects` or a Cline task folder. Treat every number as
  descriptive of this corpus.
- **No wall clock is emitted**, even though Claude Code and Codex transcripts
  have one. Folds are leave-user-out and leave-source-out; see `docs/CORPUS.md`.
- **Not a holdout.** Public rows pretrain and grade transfer; the local corpus
  stays the realism target.

## Reproduce

```sh
# search + fetch + parse. Reparses the flat harvester's markdown cache in place
# and never refetches it.
python3 experiments/evaluation/semantic/harvest_sessions.py
# without spending search budget again
python3 experiments/evaluation/semantic/harvest_sessions.py --skip-search
```

The blob index this build used is pinned in `raw/index.jsonl`: 7,429 blobs
(6,766 claude-code, 362 cline-task, 301 codex) across 652 repositories. Files
are picked at a cap of 25 per repository per source, which is what limits the
claude-code harvest to 2,398 files. Search results move, so a rerun will not
reproduce the row count exactly.

## Left for week 2

1. Finish the claude-code search: only `size:<4000` and `size:60000..250000` of
   the seven `"parentUuid"` byte ranges were paged. The remaining four are

   ```sh
   python3 experiments/evaluation/semantic/harvest_sessions.py \
       --sources claude-code --refresh-search
   ```

   which should roughly double the 6,766 indexed blobs, and with the 25-per-repo
   cap the user count more than the call count.
2. Raise `--max-files-per-repo` for the native sources only. The cap protects
   the fold structure of a 35,000-turn markdown corpus; on claude-code, where
   there are 351 users and 16,133 calls, it is now the binding constraint.
3. Cline/Roo: 271 + 301 search hits is the whole public population of task
   folders. Widening needs a content query on the `api_req_started` string.
4. Fit the visible-chars-per-output-token correction against the native rows and
   grade it, rather than carrying estimated rows at face value.

# github-agent-chats

Real developer prompts typed to coding agents, harvested from chat histories
that people committed to public GitHub repositories. Built 2 September 2026 for
`docs/SEMANTIC-PLAN.md` Step A, source 1.

Produced by `experiments/evaluation/semantic/harvest_github_chats.py`, then
`experiments/evaluation/semantic/featurize.mjs`, then checked by
`experiments/evaluation/semantic/validate.py`.

`turns.jsonl` and `raw/` are gitignored and carry other people's prompt text.
They are research input only: never committed, never redistributed, never
quoted. Everything below is an aggregate.

## What is in it

| | |
|---|---|
| turns | 35,006 |
| sessions (groups) | 1,277 repositories |
| source repositories searched | 1,520 |
| source files fetched | 4,835 |
| assistant output tokens, summed | 69,015,299 |
| token source | `tiktoken:o200k_base` (every row) |
| `dataset` | `github-agent-chats` |

| tool | files | turns | repos | median turn total | median calls |
|---|---|---|---|---|---|
| specstory | 4,122 | 31,990 | 968 | 690 | 1 |
| aider | 483 | 2,426 | 243 | 443 | 1 |
| cline / roo | 230 | 590 | 66 | 1,197 | 4 |

Distribution of the turn total: median 675, p90 4,338, max 130,897. Opening
call: median 542, p90 3,668. Prompt length: median 72 chars, p90 718.

## Sources and queries

GitHub code search (`gh api -X GET search/code`, 10 requests/minute,
authenticated). Code search caps a query at 1,000 results, so each query is
partitioned into seven byte ranges with `size:` and each partition paged to 10
pages of 100.

| tool | queries |
|---|---|
| aider | `filename:.aider.chat.history.md {size:<4000, 4000..12000, 12000..30000, 30000..60000, 60000..120000, 120000..250000, >250000}` |
| specstory | `path:.specstory/history extension:md {same seven size ranges}` |
| cline / roo | `filename:cline_task extension:md`, `filename:roo_task extension:md`, `filename:cline_tasks extension:md` |

Search returned 10,009 distinct blobs (5,740 specstory, 3,928 aider, 341
cline/roo) across 1,520 repositories. Files are then picked with a cap of 25
files per repository per tool, so a single repository that has committed
thousands of history files cannot dominate a session. That cap is what limits
aider to 483 files: one repository (`paraemsi/Reducing-violations-paper-data`)
accounts for 3,470 of the 3,928 aider blobs. Files larger than 5 MB are
skipped; none were. Raw blobs are cached under `raw/<tool>/<sha[:2]>/<sha>.md`
so a rerun refetches nothing.

## File formats and how a turn is cut

A turn is **one human message plus every assistant block until the next human
message**. `sessionId` is `owner/repo`. `turnRootId` is `<blob sha>:<turn index
in file>`. `firstMs` is a monotone integer assigned after sorting the corpus by
the timestamp in the file path (SpecStory names files
`YYYY-MM-DD_HH-MM…`), then repository, then path, then turn index — it is an
ordering, not a wall clock.

**aider** — `.aider.chat.history.md`, written at the repository root by
default. `#### ` prefixes every line of a human message; `> ` prefixes aider's
own console output, which is NOT model output and is excluded; everything else
between two `####` runs is assistant output. `# aider chat started at …` ends
the previous turn. The parser tracks code fences so that the `>>>>>>> REPLACE`
marker of aider's SEARCH/REPLACE edit format is not mistaken for a console
line. Slash-command messages are handled: `/ask`, `/code`, `/architect`,
`/chat` keep their argument as the human text and record the command name in
`command`; every other slash command (`/add`, `/commit`, `/undo`, …) is dropped
because it is harness control, not a prompt. aider emits one model response per
turn, so nearly every aider row has `calls = 1` and `openerTokens = total`.

**specstory** — `.specstory/history/*.md` written by the SpecStory extension,
covering both Cursor and Claude Code sessions. Blocks are delimited by
`_**User (ts)**_`, `_**Assistant (model)**_` and `_**Agent (model ts)**_`
headers with `---` separators. Injected context is stripped from the human
message: `<ide_selection>`, `<environment_details>`, `<additional_data>`,
`<attached_files>`, `<user_rules>`, `<custom_instructions>`,
`<system-reminder>`, `<local-command-stdout>`, `<command-*>`, any `<details>`
block, and CLI tool-result echo lines starting with `⎿`. A user block that is
empty after stripping is a tool result, not a turn root, and is skipped.
Claude Code sessions inline TOOL RESULTS inside `<tool-use …><details>`
regions; inside such a region fenced blocks are dropped for read/search/shell
tools and kept for write/edit tools, because only the latter are
model-authored. Model reasoning (`<think>` blocks in Cursor sessions) is kept
as assistant output.

**cline / roo** — `cline_task*.md` and `roo_task*.md` exports. `**User:**` and
`**Assistant:**` headers. Only a user block carrying `<task>`, `<feedback>` or
`<user_message>` is a human turn; every other user block is a tool result plus
`<environment_details>` and is skipped. Assistant blocks include the XML tool
calls, which are model output.

## Field mapping

| field | value |
|---|---|
| `turnRootId` | `<blob sha>:<turn index in file>` |
| `sessionId` | `owner/repo` |
| `firstMs` | monotone integer, corpus order (see above) |
| `total` | tiktoken `o200k_base` tokens over every assistant block in the turn, including code blocks and tool calls |
| `openerTokens` | tiktoken tokens of the first assistant block |
| `calls` | number of assistant blocks in the turn |
| `model` | the model named in the file, else `"unknown"` (72% — aider files older than the `Model:` banner, Cursor headers that say only `default`/`mode Agent`) |
| `thinking` | `"no"` for every row; these formats do not record an extended-thinking flag, and reasoning text that IS present is counted into `total` |
| `command` | the aider slash command when the message was `/ask`, `/code`, `/architect` or `/chat`, else `null` |
| `text` | the human message with harness wrappers and injected context removed |
| `features[38]` | `portableBoostFeatures` over `derivePromptFeatures(text)`, added by `featurize.mjs` with the turn-root constants (`sessionPosition` 0, `loopDepth` 0, `priorCalls` 0, `prior*` null, `promptImage` "no", `promptPath` from `mentionsPath`) |
| `tokenSource` | `tiktoken:o200k_base` |
| `dataset` | `github-agent-chats` |
| `tool` | `aider` \| `specstory` \| `cline` |
| `repo` | `owner/repo`, same as `sessionId` |
| `license` | SPDX id from `gh api repos/{owner}/{repo}`, or `null` |

## Rows before and after filtering

| stage | rows |
|---|---|
| turns parsed out of 4,835 files | 41,081 |
| dropped: no human text after stripping wrappers and harness commands | 1,530 |
| dropped: no assistant output | 3,676 |
| dropped: identical `(text, total)` pair already seen | 860 |
| written by the harvester | 35,015 |
| dropped by `featurize.mjs`: `derivePromptFeatures` returned null | 9 |
| **final** | **35,006** |

## Licenses

Per turn, by the SPDX id of the repository the history file came from.

| license | turns |
|---|---|
| none declared | 27,586 |
| MIT | 5,509 |
| NOASSERTION | 845 |
| Apache-2.0 | 565 |
| GPL-3.0 | 267 |
| BSD-2-Clause | 67 |
| MPL-2.0 | 26 |
| LGPL-3.0 | 24 |
| AGPL-3.0 | 23 |
| BSD-3-Clause | 20 |
| LGPL-2.1 | 16 |
| BSL-1.0 | 13 |
| CC-BY-SA-4.0 | 11 |
| Unlicense | 9 |
| ISC | 8 |
| CC-BY-4.0 | 7 |
| CC0-1.0 | 6 |
| GPL-2.0 | 4 |

79% of turns come from repositories with no declared license. Nothing is
redistributed and no text is committed, so this is a research-input record, not
a redistribution claim. Any future use beyond in-repo aggregates has to revisit
this table.

## Known biases and caveats

- **SpecStory dominates** (91% of turns). Any per-corpus result should also be
  read per tool.
- **`total` is a tiktoken count over rendered markdown**, not billed output
  tokens. It includes reasoning text where the format records it, and it
  excludes tool results, which the parsers strip. Rendering is lossy in both
  directions; the count is consistent within this corpus, not comparable in
  absolute terms with the local `usage`-based corpus.
- **`calls` is a rendering artifact for two of the three tools.** aider writes
  one assistant block per turn and Cursor's SpecStory export collapses a reply
  into one block, so 86% of rows have `calls = 1`; only Claude Code sessions
  and cline exports show the real agent ladder.
- **Turns are much shorter than the local corpus** (median 675 output tokens
  against several thousand locally). Different tools, different models,
  different work.
- **Prompt language is mixed** (English, German, Chinese, Portuguese, Spanish
  and others), which is closer to the local corpus than an English-only public
  set would be.
- **Committed chat histories are a selected population**: people who commit
  `.specstory/history` or `.aider.chat.history.md` are people who did not
  gitignore them. Treat every number as descriptive of this corpus.
- **Not a holdout.** Per `docs/SEMANTIC-PLAN.md`, public data pretrains and
  grades transfer; the local corpus stays the calibration and holdout target.

## Reproduce

```sh
python3 experiments/evaluation/semantic/harvest_github_chats.py \
  --max-files-per-tool 6000
node experiments/evaluation/semantic/featurize.mjs \
  experiments/datasets/public/github-agent-chats/turns.jsonl
python3 experiments/evaluation/semantic/validate.py \
  experiments/datasets/public/github-agent-chats/turns.jsonl
```

Search results move, so a rerun will not reproduce the row count exactly. The
`raw/` cache and `raw/index.jsonl` pin this build.

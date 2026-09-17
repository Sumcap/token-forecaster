# wildchat-coding

A CODING slice of real human chat prompts, used as the NON-AGENTIC control in
`docs/SEMANTIC-PLAN.md` Step A (source 2). One row is one conversation: the
first human turn and the first assistant reply, nothing else. The label is a
single reply, so this corpus tests prompt semantics against REPLY length, not
against agentic turn length.

## Source

| | |
|---|---|
| Dataset | `allenai/WildChat-1M` on Hugging Face |
| Revision | `main`, read 2 September 2026 |
| Files | `data/train-000{00..13}-of-00014.parquet` (14 shards, 3.36 GB on the hub) |
| Rows on the hub | 1,039,785 conversations |
| License | **ODC-BY 1.0** (the hub `license:` field). AI2 additionally applies its [Impact License / responsible-use terms](https://huggingface.co/datasets/allenai/WildChat-1M) to the underlying conversations. |
| Gating | **Not gated.** `GET /api/datasets/allenai/WildChat-1M` returns `gated: false`; the shards were read anonymously with no Hugging Face token and no accepted terms. (`allenai/WildChat-1M-Full`, which carries the unhashed IPs, IS `gated: manual`, and `lmsys/lmsys-chat-1m` is `gated: auto` — neither was needed.) |
| Citation | Zhao et al., *WildChat: 1M ChatGPT Interaction Logs in the Wild*, ICLR 2024 |

Use here is **research input only**: aggregates in this repository, no
redistribution. `turns.jsonl` contains prompt text, is gitignored, and must
never be committed. Only this manifest is.

## How it was read

`experiments/evaluation/semantic/build_wildchat_slice.py`.

The dataset is **streamed**, never downloaded whole: each parquet shard is
opened over HTTP through `fsspec`, only the footer is fetched, and row groups
are pulled one at a time with column projection down to
`conversation_hash, model, timestamp, language, toxic, redacted, hashed_ip`
and the nested `conversation.list.element.{content,role}`. Projection drops
`openai_moderation` and `detoxify_moderation`, which are 29% of the bytes.
Nothing is cached to disk.

(`datasets.load_dataset(..., streaming=True)` was tried first and hung on
data-file resolution in this environment for over 10 minutes with no output,
so the same row-group streaming is done directly against parquet.)

## Eligibility filter, applied to every scanned row

1. top-level `language == "English"`;
2. top-level `toxic == false` and `redacted == false`;
3. `conversation[0].role == "user"` and `conversation[1].role == "assistant"`;
4. both of those contents non-empty after `strip()`.

## The coding rule (three tiers, prompt-only for keywords)

A row is **coding** when ANY of:

- **fence** — the first human message OR the first assistant reply contains
  a ``` fence;
- **tier 1 (strong), >= 1 hit in the PROMPT** — 108 regexes naming languages,
  runtimes, tools, libraries, formats and unambiguous phrases: `python`,
  `javascript`, `typescript`, `\bjava\b`, `c++`, `c#`, `sql`, `html`, `css`,
  `bash`, `powershell`, `regex`, `react.js`, `node.js`, `django`, `pandas`,
  `pytorch`, `npm`, `docker`, `kubernetes`, `github`, `git commit|push|...`,
  `rest api`, `graphql`, `write (a) program|code|script|function|class|query`,
  `source code`, `code snippet`, `debug`, `stack trace`, `traceback`,
  `syntax error`, `compile`, `unit test`, `def \w+\(`, `import \w+`,
  `#include`, `</tag>`, ... (full list in the script);
- **tier 2 (generic), >= 3 DISTINCT hits in the PROMPT** — 28 everyday words
  that are also programming words: `function`, `variable`, `array`, `loop`,
  `script`, `import`, `string`, `integer`, `database`, `query`, `server`,
  `syntax`, `code`, `program`, `developer`, `compiler`, `directory`,
  `plugin`, `backend`, `frontend`, `debugger`, `callback`, `recursion`,
  `bug`, ...

Keyword tiers read the PROMPT ONLY, so the label never depends on wording the
model chose. The fence test is the one signal that also reads the reply.

Tier 2 needs three distinct words because WildChat is mostly fiction,
role-play, essays and jailbreak personas, where any single one of these words
appears innocently. A first pass used a two-word threshold and a looser tier-1
list; hand-checking 100 rows put its precision at 64%, with the losses
concentrated in `\bswift\b` matching *Taylor Swift*, `\bunity\b` matching the
English word, and worldbuilding/essay prompts hitting two of
`code / class / program / algorithm / method / framework`. Those patterns were
tightened (`swiftui`, `unity 3d`, `react.js`, `angular.js` only) and the six
worst generic words were demoted to tier 3 below.

## Precision estimate

**94% (94/100)**, hand-checked on the first 100 rows classified `coding` in
shard `train-00000`, judged from the first ~110 characters of each prompt.
The 6 misses were a video-advertisement script, an APA-citation question, a
"summarize this AI news article" request, a research-report outline, a
release-note question, and a persona prompt about learning data science.

A stricter reading that also rejects the 8 rows which are systems/infra rather
than programming (an AutoGPT command-spec prompt seen 4x, a TrueNAS disk
layout, an `iptables` rule, a shadowsocks PAC config, a TensorFlow-Model-
Analysis guide) puts the floor at **86%**. The same sample contained a large
number of duplicate prompts, which is a property of WildChat (users resubmit),
not of the rule.

## Sampling rule

Shards are visited in a permutation drawn from `random.Random(20260902)`.
Within a shard, row groups are read in file order, and every ELIGIBLE row goes
through a 10,000-row reservoir shuffle buffer seeded with
`Random(20260902 * 1_000_003 + shard_position)`; the row evicted from the
buffer is the one classified and written. The slice is the **first 50,000
matching rows** produced that way; the scan stops as soon as both slices are
full. The remainder of a shard's buffer is drained (shuffled) before moving to
the next shard.

The run is resumable: `experiments/datasets/public/.wildchat-progress.json`
records the shard permutation, shard position, row-group position, and the row
counts, and a resume truncates both JSONL files to those counts before
appending. A resume restarts the shuffle buffer for the current shard; the
scan position and shard order are unchanged.

## Row counts

<!--COUNTS-->

## Schema

Exactly what `experiments/evaluation/export-turn-text.mjs` writes, minus
`features` (a separate featurizer adds those by calling the shipped
`derivePromptFeatures` / `portableBoostFeatures` code path), plus
`tokenSource`, `dataset` and `language`.

| field | value |
|---|---|
| `turnRootId` | `conversation_hash` (32 hex chars, unique per conversation) |
| `sessionId` | `hashed_ip` (SHA-256 of the client IP, as published) — never null in this slice; the fallback `conversation_hash[:8]` was not needed |
| `firstMs` | `int(timestamp * 1000)`, UTC epoch milliseconds; monotone in real time. Row index is the documented fallback and was not needed |
| `total` | tiktoken `o200k_base` token count of the FIRST assistant reply |
| `openerTokens` | identical to `total` (one call per turn) |
| `calls` | `1` |
| `model` | the dataset's `model` field verbatim |
| `thinking` | `"no"` (no reasoning traces in WildChat) |
| `command` | `null` |
| `text` | the FIRST human message, `strip()`ed, otherwise verbatim |
| `tokenSource` | `"tiktoken:o200k_base"` |
| `dataset` | `"wildchat-coding"` |
| `language` | the dataset's `language` field (always `"English"` here) |

## Token source

`tiktoken:o200k_base`. WildChat records no usage counters, so output tokens are
COUNTED, not measured: `len(tiktoken.get_encoding("o200k_base").encode(reply))`
over the assistant's first reply text. `o200k_base` is the GPT-4o encoding;
most of this corpus was generated by `gpt-3.5-turbo` and `gpt-4`, which used
`cl100k_base`, so these counts are a consistent proxy rather than the provider's
own billing numbers. Rows with a zero-token reply are dropped.

## As published, 2 September 2026

The builder was stopped before its 50k cap, at 28,267 rows per slice
(progress file: 837,989 conversations scanned, 471,814 eligible). The
published file was then repaired in place: JSON lines corrupted by a
concurrent featurize run were dropped, duplicate `turnRootId` rows removed,
rows sorted by timestamp and `firstMs` rewritten as the row index. Final
count: **28148 rows**, all with the 38-float `features` column from
`featurize.mjs`. `validate.py` passes.

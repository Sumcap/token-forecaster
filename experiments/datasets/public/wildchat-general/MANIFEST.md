# wildchat-general

The matched NON-CODING control for `wildchat-coding`. Same source, same
stream, same schema, same token source; the only difference is the label side
of the coding rule. It exists so that Step B of `docs/SEMANTIC-PLAN.md` can
tell "text predicts reply length" from "coding text predicts reply length".

Everything under **Source**, **How it was read**, **Eligibility filter**,
**Sampling rule**, **Schema** and **Token source** in
`../wildchat-coding/MANIFEST.md` applies here verbatim, including the ODC-BY
license, the ungated (`gated: false`, no token) access, and the research-input-
only restriction. `turns.jsonl` contains prompt text, is gitignored and must
never be committed.

## The non-coding rule

A row is **general** when the prompt contains ZERO hits from tier 2 (the 28
generic programming words) AND zero hits from tier 3 below. A `coding` row is
never eligible, and neither is anything in between: rows with some technical
smell but not enough to be called coding are labelled `ambiguous` and DROPPED
from both files rather than being dumped into the control.

**Tier 3 (soft)** — 23 regexes that are too common in essays, fiction and
persona prompts to be evidence FOR coding, but whose presence disqualifies a
row from a clean control: `class(es)`, `method`, `algorithm`, `error`,
`librar(y|ies)`, `framework`, `parameter`, `argument`, `exception`, `folder`,
`software`, `app`, `api`, `website`, `database`, `command`, `terminal`,
`computer`, `excel`, `spreadsheet`, `formula`, `config...`, `install...`.

Six of these (`class`, `method`, `algorithm`, `error`, `library`, `framework`)
began as tier-2 words. Hand-checking showed them driving most of the coding
slice's false positives, so they were demoted: they no longer argue FOR
coding, but they still keep a row out of the control.

## Purity estimate

**49/50** on a hand-checked sample of the first 50 rows labelled `general` in
shard `train-00000`. No row in the sample was a programming request; the one
debatable row asked for app recommendations to convert MP3 to MIDI. Sample
content: boss-fight design, medical exam questions, probability homework,
fan fiction, wrestling trivia, blog posts, "hi"/"test" openers, and
model-identity questions.

## Size matching

The control is thinned during the scan: an eligible non-coding row is written
with probability 0.12, drawn from `random.Random(20260902 ^ 0x5EED)`. Without
this the control would fill its 50,000-row cap inside the first two shards
while the coding slice needs all fourteen, and the two files would cover
different slices of the stream. After the scan the control is TRUNCATED from
the front-of-file order to exactly the coding slice's row count, so the two
files have identical n.

## Row counts

<!--COUNTS-->

## Schema

Identical to `../wildchat-coding/MANIFEST.md`, with `dataset` =
`"wildchat-general"`.

## As published, 2 September 2026

The builder was stopped before its 50k cap, at 28,267 rows per slice
(progress file: 837,989 conversations scanned, 471,814 eligible). The
published file was then repaired in place: JSON lines corrupted by a
concurrent featurize run were dropped, duplicate `turnRootId` rows removed,
rows sorted by timestamp and `firstMs` rewritten as the row index. Final
count: **28170 rows**, all with the 38-float `features` column from
`featurize.mjs`. `validate.py` passes.

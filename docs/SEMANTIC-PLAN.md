# Semantic forecasting plan: reading the prompt, not just its features

Date: 2026-09-02
Status: proposed. The evidence section is measured; everything under
"The plan" is future work and has not been built.

## Why this document exists

The shipped predictor reduces the human message to a fixed set of booleans
and buckets (`derivePromptFeatures`): length bucket, verb class, has-limit,
has-expansive, path bit, requirement count, deliverable type. That is a
feature model, not a semantic one. The hypothesis behind this plan is that
the words themselves, and how the message is structured, carry information
about how many output tokens the turn will produce that those buckets do not
capture.

The corpus already told us where that information lives (STATE-OF-PLAY §7.3,
§6.28): the prompt predicts the TURN TOTAL, not the opening call, and its
signal is gone a few calls into the loop. So every model in this plan targets
the whole-turn total conditioned on the turn-root message, and leaves the
per-call ladder alone for descendants.

## What we measured on 2 September 2026

`experiments/evaluation/export-turn-text.mjs` plus the Python probes in
`experiments/evaluation/semantic/` (see its README for the exact learners).
Corpus: 2,132 exact turns, 1,777 (83%) carrying human text. The control is a
quantile GBM on the shipped 38-feature vector, trained with the same learner
and the same rows as every text model, so the comparison isolates the text.

### Single chronological split (the way the JS probes grade)

Holdout: 316 turns in 136 sessions. Loss is summed pinball at p50/p90/p99 per
turn, on turns that carry text.

| model | loss | vs metadata GBM, 95% block-bootstrap CI |
|---|---|---|
| thinking ladder (shipped shape) | 13,121 | +2,271 [+991, +3,775] |
| metadata GBM (38 features) | 10,850 | control |
| TF-IDF only | 9,893 | −956 [−1,724, −143] |
| MiniLM embedding only | 9,943 | −907 [−1,950, +67] |
| MiniLM kNN-40 quantiles | 11,702 | +852 [−119, +1,770] |
| metadata + TF-IDF | 9,867 | −982 [−1,722, −218] |
| metadata + MiniLM + TF-IDF | 9,704 | −1,145 [−2,028, −313] |

Read alone, that is a 10.6% loss reduction with the whole interval below
zero, which would clear the project's breakthrough bar. It does not survive
the next table.

### Five chronological session folds, three seeds, pooled (n = 5,331)

| model | loss | vs metadata GBM | per fold |
|---|---|---|---|
| metadata GBM | 10,905 | control | |
| TF-IDF only | 11,199 | +294 [−124, +724] (+2.7%) | |
| metadata + TF-IDF | 10,995 | +90 [−248, +469] (+0.8%) | −4.5%, +7.2%, −1.8%, +28.8%, −10.5% |
| metadata + 10 structural bits | 11,086 | +181 [−117, +493] (+1.7%) | −2.3%, +1.9%, +5.1%, +2.0%, +1.4% |

The text model wins two folds by 4 to 10 percent and loses two by 7 to 29
percent. The single-split result above is the last fold. Pooled, text is a
wash, and the ten cheap structural features (line count, question mark,
acknowledgement opener, Portuguese-word count, conjunction count, code
fence, URL count, digit count, upper-case ratio, under-40-chars) do not help
either.

### Shrinking the text model toward the metadata model

Geometric blend in log space, `(1−λ)·meta + λ·text`, same five folds:

| λ | vs metadata GBM | per fold |
|---|---|---|
| 0.20 | −146 [−220, −67] (−1.3%) | −2.0%, +0.1%, −1.1%, +1.7%, −4.4% |
| 0.35 | −214 [−339, −75] (−2.0%) | −3.1%, +0.4%, −1.8%, +4.4%, −7.1% |
| 0.50 | −232 [−408, −52] (−2.1%) | −4.1%, +1.2%, −2.3%, +8.8%, −9.2% |

This is the only text configuration whose whole interval sits below zero
across folds. It is an ensemble effect: the two models make partly
independent errors. Two percent is adoptable under the house gate, not a
breakthrough.

### The opening call, for completeness

Same five folds, target = the turn's first call:

| model | vs metadata GBM |
|---|---|
| TF-IDF only | +123 [+91, +159] (+13.1% worse) |
| metadata + TF-IDF | +47 [+21, +76] (+5.0% worse) |

Text reliably hurts the per-call forecast. §7.3 stands.

### What the text model is actually reading

Ridge weights on TF-IDF against log turn total, ordinary-word terms only.
Short turns: `ok`, `hi`, `hello`, `reply with`, `say ok`, `summarize`,
`concise`, `fix it`. Long turns: `let`, `and`, `also`, `as well`,
`afterwards`, `first`, `fix these`, `merge`, `image`, `dashboard`,
`everything`. Multi-line prompts have a median turn total of 13,104 tokens
against 3,423 for prompts under 80 characters. The signal is mostly
acknowledgement-versus-instruction, conjunction count, and length. The
shipped features already carry length and requirement count, which is why
the pooled gain is small. Genuinely semantic content (what the task is about)
is not separable from noise at 1.8k labelled turns.

### Conclusion of the measurement

1. Words help on turn totals, but only as a shrunk second opinion, and only
   by about two percent today.
2. The reason is sample size in turns, not the feature form. The
   fold-to-fold variance (−10% to +29%) is what a 48-dimensional text model
   looks like when trained on roughly 1,400 turns per fold.
3. Nothing here justifies shipping raw prompt text through telemetry. The
   client can compute the text model's output locally.

## The plan

### Stage 1: ship the shrunk text head locally (weeks, not months)

- Train a TF-IDF-SVD quantile head on the local corpus inside the personal
  profile build, blended at λ = 0.35 into the existing turn-total forecast.
  Gate it exactly like every other rung: five chronological session folds,
  whole CI below zero, re-tested on every regeneration, auto-refused when it
  fails.
- The head runs on the client. Telemetry keeps `hash_only`. The only new
  telemetry field is the head's own prediction, so the server can learn the
  residual and measure the blend without ever seeing a word.
- The typing simulation in `probe-turn-total-boost.mjs` becomes a required
  check: the blended forecast must not drop as a draft gets longer.

### Stage 2: grow the corpus in TURNS, which is the binding constraint

The corpus adds thousands of calls a week and that buys nothing here; the
estimand is indexed by human messages. Three sources, in order of cost:

1. **Public agent trajectories.** SWE-Gym, SWE-smith, the Nebius SWE-agent
   trajectories and the OpenHands trajectory releases carry a task prompt and
   the full agent output, so output tokens per turn are derivable. The shift
   is real: those prompts are GitHub issues, not a person typing into a
   terminal. Use them to pretrain the text head, then calibrate on local
   turns and gate as usual. Never mix them into the holdout.
2. **Other users' turns via the multi-user plan** (`docs/MULTI-USER-PLAN.md`).
   With the client-side head, each user contributes labelled turns without
   contributing text. Per-user heads plus a pooled head, with the pooled one
   as the cold-start fallback.
3. **A synthetic developer.** An LLM plays a developer against a real
   repository, and its prompts are run through the real agent so each
   synthetic prompt gets a real output-token label. Vary the persona in the
   system prompt (plans first versus dives straight into implementation,
   terse versus verbose, English versus Portuguese) so the prompt
   distribution covers more of the space than one person produces. This is
   the only source that can produce turns on demand, and it is the only one
   that costs money per turn. Budget it from the learning curve in
   `probe_single_split.py` once Stage 1 has a stable baseline.

### Stage 3: a real semantic head, once the turn count allows

- Replace TF-IDF-SVD with a small fine-tuned encoder (MiniLM-class) that
  outputs quantiles directly, trained on public trajectories, fine-tuned on
  local plus synthetic turns.
- Keep the metadata model as the anchor and the blend weight as a learned
  parameter, so a bad text head degrades to the shipped forecast rather than
  below it.
- Keep the oracle control in every gate. If any prompt-derived feature beats
  the true-first-tool oracle it is reading the answer, which is a live risk
  once an LLM writes both the prompt and the response.

### Telemetry policy

`docs/TELEMETRY.md` keeps `hash_only` as the default and this plan does not
change it. What changes is what the client may compute before hashing: a
locally trained text head and, later, a fixed-size embedding. If a future
study needs the embedding on the server, that is a separate ADR with its own
consent surface, because a 384-dimensional sentence embedding is not
reconstruction-proof.

## Gates, restated

- Adopt: whole 95% session-block CI below zero on five chronological folds,
  and no fold worse than +5%.
- Breakthrough: at least 5% pooled loss reduction, or materially narrower
  intervals without coverage damage.
- Kill: the same configuration graded at two consecutive regenerations with
  a CI that includes zero is removed from the profile automatically.

## v1 execution plan: proof of semantics on more than one person's data

Date: 2026-09-02. Decision: before shipping any text head, the semantic
claim gets tested on public corpora with ten times the turns. The local
corpus stays the calibration and transfer target; it is one person and it
cannot separate topical content from noise. Planning is done here;
implementation is delegated to Opus subagents with the acceptance checks
below.

### Step A: build a public turn corpus in the local schema

Output: `experiments/datasets/public/<name>/turns.jsonl` plus a committed
`MANIFEST.md` per dataset (source, license, row counts, field mapping, how
tokens were counted). Data directories are gitignored; manifests are not.

Schema is exactly what `export-turn-text.mjs` writes, so every probe in
`experiments/evaluation/semantic/` runs unchanged:
`turnRootId, sessionId, firstMs, total, calls, openerTokens, model, thinking,
command, features[38], text`, plus `tokenSource` (`usage` when the dataset
records output tokens, else `tiktoken:<encoding>` over assistant text
including tool-call arguments) and `dataset`.

Sources must contain prompts a PERSON typed to a coding assistant. Issue-text
trajectory corpora (SWE-smith, SWE-Gym, the Nebius SWE-agent set) are
excluded: their prompts are GitHub issues, and the local text model reads
conversational structure ("ok", "let's", "also", "fix these") that issue
text never has. Chosen on 2 September 2026:

1. **Agent chat histories committed to public GitHub repositories.**
   Aider writes `.aider.chat.history.md` into the repo by default; the
   SpecStory extension saves Cursor and Claude Code sessions under
   `.specstory/history/`; Cline and Roo Code users commit task exports.
   Real developer prompts, multi-turn, with the full assistant response.
   Found through GitHub code search. One human message plus everything the
   assistant produced until the next human message is one turn; the
   repository is the session key. Research input only: aggregates in this
   repo, no redistribution, and each repository's license is recorded.
2. **A coding slice of WildChat-1M or LMSYS-Chat-1M**, English, first
   human turn and first reply only, as a non-agentic control. Real human
   prompts at scale; the label is a single reply, so it tests prompt
   semantics against reply length rather than turn length.

The synthetic developer loop stays in Stage 2 for later. Cap each source at
50k turns.

Features come from the real code path: a small Node script calls
`derivePromptFeatures(text)` and `portableBoostFeatures(...)` with
`thinking` and `model` taken from the dataset, session position 0 and prior
fields null, so the metadata control is the same 38 numbers as locally.

Acceptance: each manifest states the license and the token source; a
`validate.py` asserts schema, non-empty text, positive totals, and prints
the same length-bucket table as `inspect_terms.py`; no dataset text is
committed.

### Step B: the proof, three questions

1. **Does text beat features at scale?** `probe_folds_pooled.py` per
   public dataset, five session folds (sessions are trajectory groups by
   repository or by shard), three seeds. Pass: metadata+text beats metadata
   with the whole CI below zero and no fold worse than +5%.
2. **How many turns does it take?** Learning curve at 1k, 2k, 5k, 10k, 20k
   training turns on the largest dataset. This number sets the
   synthetic-developer budget.
3. **Does it transfer?** Fit the text head on public data, evaluate on the
   local five folds with the metadata model retrained locally and the blend
   weight chosen on public data only. Pass: beats the local λ=0.35 result
   (−2.0%) or narrows its interval.

Every table lands in `docs/SEMANTIC-PLAN.md` under a dated results heading,
aggregates only.

### The shape of the shipped model: base head plus local post-training

Stated plainly, because it drives every choice above. The public corpus
trains a BASE text head that learns the general mapping from how a prompt is
written to how much work follows. After install, the head is POST-TRAINED on
the user's own transcripts on their machine, so it picks up that person's
idiolect: the words they use to open a big task ("let's", "afterwards",
"fix these" in the local corpus) and the ones that mean a short reply
("ok", "reply with"). The personal layer is a residual on top of the base
with shrinkage toward it, because a personal corpus is small and §6.32
showed an unshrunk text model swinging −10% to +29% across folds. Nothing
personal leaves the machine; telemetry carries the head's prediction only.

Two constraints follow. The base head's input must accept words it never
saw, so the feature space is hashed n-grams (the loader's `semanticHash`
already does this) or an encoder, never a vocabulary frozen on public
data. And the base head must be trained on prompts people typed, which is
why Step A excludes issue-text corpora.

### Step C: ship, only after B

If B.1 passes on at least one agentic corpus and B.3 does not regress
locally, Stage 1 proceeds as written above, with the public-pretrained head
as the cold-start default and the local head as the personal override. If
B.1 fails at 20k turns the semantic claim is refused for this feature form
and the plan moves to Stage 3's encoder before any further data spend.

## Results, 2 September 2026: Step B

Run with `experiments/evaluation/semantic/probe_semantic_scale.py` (one script,
subcommands `b1`, `b2`, `b3`, `svdnoise`). Aggregates land in
`experiments/artifacts/semantic-scale.json`; no prompt text is written or
printed anywhere.

Text feature form, as the plan decided: signed hashed word unigrams and
bigrams into 2^18 buckets with log1p counts, the same shape as
`semanticHashFeatures` in `packages/ingest-claude/load-history.mjs`, so the
head accepts words it never saw. The primary head reduces that to 256
`TruncatedSVD` components fitted on the TRAINING split only and feeds
`[metadata 38 + SVD 256]` to the same quantile GBM every probe uses. The
secondary head is a sparse `Ridge` on `log1p(total)` over
`[hashed + metadata]` with quantiles from empirical residual quantiles inside
ten bins of the training point prediction. Control is always the metadata-only
quantile GBM on the same rows, same learner, same seeds. Loss is summed
pinball at p50/p90/p99 per turn on the raw token scale; intervals are the
2,000-resample session-block bootstrap from `probe_folds_pooled.py`.

B.1 ran on all three public corpora. B.2 and B.3 use `github-agent-chats`,
the only agentic one, plus the local corpus.

### B.1 Does text beat features at scale?

`github-agent-chats`, 35,006 turns in 1,277 repository sessions, five
chronological session folds x three seeds, pooled holdout n = 105,018 rows.

| model | loss | vs control | 95% block CI | % | per fold |
|---|---|---|---|---|---|
| metadata GBM (38 features) | 2,094 | control | | | |
| SVD-256 only | 2,088 | −6 | [−22, +10] | −0.3% | +0.9%, −0.4%, +0.1%, −1.6%, +0.8% |
| metadata + SVD-256 | 2,075 | −19 | [−33, −4] | **−0.9%** | −0.3%, −0.8%, −0.5%, −1.8%, −0.7% |
| sparse Ridge + binned residual quantiles | 2,291 | +197 | [+87, +375] | +9.4% | +2.6%, +3.0%, +17.5%, +8.4%, +11.6% |
| blend λ = 0.35 | 2,078 | −16 | [−21, −11] | −0.8% | −1.0%, −0.6%, −0.5%, −1.1%, −0.8% |
| blend λ = 0.50 | 2,074 | −20 | [−27, −12] | −0.9% | −1.2%, −0.8%, −0.6%, −1.4%, −0.9% |
| blend λ = 0.75 | 2,072 | −22 | [−32, −11] | **−1.0%** | −1.0%, −0.9%, −0.6%, −1.7%, −1.0% |
| blend λ = 1.00 (= metadata + SVD) | 2,075 | −19 | [−33, −4] | −0.9% | −0.3%, −0.8%, −0.5%, −1.8%, −0.7% |

The Ridge head's alpha came out at 100 in all five folds (inner chronological
split of the training rows, grid 1/10/100).

metadata + SVD per tool, on the pooled holdout rows:

| tool | holdout rows | control loss | meta+SVD | % | 95% CI |
|---|---|---|---|---|---|
| specstory | 95,970 | 2,155 | 2,135 | −0.9% | [−1.7%, −0.2%] |
| aider | 7,278 | 1,261 | 1,234 | −2.2% | [−4.7%, +0.8%] |
| cline / roo | 1,770 | 2,212 | 2,274 | +2.8% | [−2.0%, +9.8%] |

**How much of that is the randomized SVD basis?** Fold 4 refitted with four
`TruncatedSVD` random states, everything else held fixed, gives −0.66%,
−0.25%, −0.43%, −0.69%: a spread of 0.44 pp and a standard deviation of
0.18 pp. The session bootstrap does not carry this variance because B.1 fits
the basis once per fold. The −0.9% headline is roughly twice the noise in its
own feature construction, not ten times it.

**Verdict.** The adopt gate is met on the letter: the whole interval sits below
zero ([−1.6%, −0.2%] in percent terms) and the worst fold is −0.3%, nowhere
near +5%. But the size is one percent, not the five percent the breakthrough
bar asks for, and it is the same order as the SVD-seed noise measured above.
Words do beat features at 35k turns, on the corpus that is closest to the
shipped setting, and the effect is small and concentrated in the two agentic
formats: aider (−2.2%) and specstory (−0.9%); cline/roo is 1,770 rows and
tells us nothing. The sparse linear head is refused outright at +9.4%: the
binned-residual quantiles are a bad substitute for a quantile learner.

### B.1 control: WildChat

The non-agentic control from Step A source 2: one row is one conversation, the
first human turn and the first assistant reply, so the label is REPLY length
rather than turn length. Same script, same learner, same five chronological
session folds x three seeds. `wildchat-coding` is 28,148 rows in 7,448 groups,
`wildchat-general` 28,170 rows in 13,140 groups. Note the loss scale: a single
reply is ~200 pinball units against ~2,100 for an agentic turn, so these
percentages are not comparable in absolute tokens with the table above.

**wildchat-coding** (pooled holdout n = 84,444):

| model | loss | vs control | 95% block CI | % | per fold |
|---|---|---|---|---|---|
| metadata GBM (38 features) | 193.0 | control | | | |
| SVD-256 only | 216.9 | +23.9 | [+8.6, +38.8] | +12.4% | +1.9%, +2.0%, −2.3%, +23.8%, +22.6% |
| metadata + SVD-256 | 202.4 | +9.4 | [−1.5, +20.0] | +4.9% | −1.9%, −2.7%, −3.9%, +12.8%, +10.1% |
| sparse Ridge + binned residual quantiles | 199.7 | +6.7 | [−31.6, +47.0] | +3.5% | +19.3%, +20.7%, +4.4%, −25.7%, +43.7% |
| blend λ = 0.35 | 194.0 | +1.0 | [−3.0, +5.0] | +0.5% | −1.7%, −2.1%, −2.4%, +3.7%, +0.6% |
| blend λ = 0.50 | 195.1 | +2.2 | [−3.6, +7.7] | +1.1% | −2.1%, −2.6%, −3.2%, +5.6%, +1.9% |
| blend λ = 0.75 | 198.0 | +5.1 | [−3.3, +13.3] | +2.6% | −2.4%, −3.0%, −4.0%, +9.0%, +5.2% |
| blend λ = 1.00 (= metadata + SVD) | 202.4 | +9.4 | [−1.5, +20.0] | +4.9% | −1.9%, −2.7%, −3.9%, +12.8%, +10.1% |

**wildchat-general** (pooled holdout n = 84,510):

| model | loss | vs control | 95% block CI | % | per fold |
|---|---|---|---|---|---|
| metadata GBM (38 features) | 159.0 | control | | | |
| SVD-256 only | 157.1 | −1.9 | [−3.8, +0.1] | −1.2% | +1.3%, −1.1%, −1.4%, −0.4%, −5.6% |
| metadata + SVD-256 | 150.2 | −8.8 | [−10.3, −7.3] | **−5.5%** | −4.5%, −5.6%, −3.5%, −6.4%, −7.9% |
| sparse Ridge + binned residual quantiles | 169.7 | +10.7 | [−0.4, +25.2] | +6.7% | +6.6%, +16.8%, +1.8%, +9.6%, −4.5% |
| blend λ = 0.35 | 153.7 | −5.3 | [−5.9, −4.7] | −3.3% | −2.6%, −3.0%, −2.1%, −4.4%, −4.7% |
| blend λ = 0.50 | 152.2 | −6.8 | [−7.6, −6.0] | −4.3% | −3.4%, −4.0%, −2.7%, −5.5%, −5.9% |
| blend λ = 0.75 | 150.6 | −8.4 | [−9.6, −7.3] | −5.3% | −4.3%, −5.2%, −3.4%, −6.5%, −7.3% |
| blend λ = 1.00 (= metadata + SVD) | 150.2 | −8.8 | [−10.3, −7.3] | −5.5% | −4.5%, −5.6%, −3.5%, −6.4%, −7.9% |

**Reading.** The control lands the wrong way round: on general chat the hashed
text head clears the breakthrough bar outright at −5.5% [−6.5%, −4.6%] with
every fold negative, while on the CODING slice of the same corpus, same size,
same pipeline, it fails the adopt gate at +4.9% with two folds above +10%.
Whatever the head is reading in a general prompt — the register that separates
"write me a 2,000-word essay" from "what time is it in Tokyo" — has no
equivalent in a coding prompt, where the shipped 38 features already carry the
length and requirement count that do the work. That is a useful negative: the
semantic gain measured on `github-agent-chats` is small because coding prompts
are the hard case, not because the hashed feature form is weak.

### B.2 How many turns does it take?

Holdout fixed at fold 4 (the latest 20% of sessions: 5,232 turns in 255
repositories). Training rows are the chronologically first N of the remaining
29,774. Three seeds each.

| training turns | control loss | metadata + SVD | gap | 95% CI |
|---|---|---|---|---|
| 1,000 | 1,958 | 2,074 | +5.9% | [+3.1%, +9.2%] |
| 2,000 | 1,932 | 1,977 | +2.3% | [+0.1%, +4.9%] |
| 5,000 | 1,884 | 1,908 | +1.3% | [−0.5%, +3.4%] |
| 10,000 | 1,805 | 1,835 | +1.7% | [−1.1%, +5.1%] |
| 20,000 | 1,801 | 1,787 | −0.8% | [−2.4%, +0.9%] |
| 29,774 (all) | 1,756 | 1,756 | −0.0% | [−1.5%, +1.6%] |

**Verdict.** The text head costs 6% at 1k turns, is inside noise of the
metadata model by 5k, crosses zero between 10k and 20k, and is flat from 20k
on. Twenty thousand turns is the number: below it the hashed head is a
liability, above it the curve has no visible slope left, so buying turns past
about 20k has no measured return at this feature form. That is the
synthetic-developer budget, and it is also the reason not to spend much more
than it. Note the fold-4 gap at full training size here (−0.0%) against B.1's
fold-4 gap (−0.7%) on the identical rows: the only difference is that B.2
orders the training rows chronologically, which changes the randomized SVD
basis. Same 0.4 pp of basis noise as above.

### B.3 Does it transfer?

Base head = hashing + `TruncatedSVD(256)` + the metadata/SVD quantile GBM,
all fitted on ALL 35,006 `github-agent-chats` turns, then applied to local
text. Blend weight λ = 0.75, chosen by B.1 on public data only. Local corpus:
2,164 exact turns exported today, 1,805 of them carrying text, 675 sessions,
five chronological session folds x three seeds, pooled holdout n = 5,415.
Control is the local metadata GBM retrained inside each fold.

| row | model | loss | vs control | 95% CI | % | per fold |
|---|---|---|---|---|---|---|
| a | local metadata GBM | 10,798 | control | | | |
| b | base head raw | 22,977 | +12,179 | [+10,510, +13,983] | +112.8% | +73.9%, +112.0%, +72.7%, +296.6%, +138.2% |
| b | base blended at λ = 0.75 | 19,609 | +8,811 | [+7,429, +10,327] | +81.6% | +52.7%, +84.1%, +49.8%, +221.3%, +98.9% |
| b′ | base blended at λ = 0.75, scale-corrected | 11,054 | +256 | [−248, +758] | +2.4% | −5.2%, −2.1%, +4.3%, +25.8%, +1.9% |
| c | local TF-IDF-SVD blended at λ = 0.35 | 10,633 | −165 | [−294, −31] | −1.5% | −3.0%, +0.5%, −0.8%, +4.7%, −6.7% |
| d1 | local metadata GBM + base head's 3 log quantiles as features | 10,512 | −286 | [−476, −92] | **−2.6%** | −4.3%, −1.4%, −0.8%, −4.3%, −3.8% |
| d2 | base log-median + local hashed Ridge residual | 12,730 | +1,932 | [+976, +3,300] | +17.9% | −8.1%, +1.6%, +19.8%, +65.5%, +45.7% |

Row d2's shrinkage alpha was chosen by three-fold session-grouped inner CV on
the training folds; it picked 100 in fourteen of fifteen fold-seed
combinations and 10 once.

**The label mismatch is large and it matters.** Public totals are
`tiktoken:o200k_base` counts over committed assistant text; local totals are
Anthropic `output_tokens`. Median `local total / base-head p50` on the local
TRAIN folds is **9.75** (per fold-seed range 8.72 to 12.37). The base head is
not merely uncalibrated, it is an order of magnitude low, because chat
histories committed to a repository record a fraction of what the agent
actually emitted. Row b is the literal instruction (blend the base head's
predictions) and it is a disaster for exactly this reason; row b′ multiplies
the base head by that median ratio before blending and lands at +2.4% with an
interval that includes zero, so even a perfectly rescaled base prediction does
not beat the local metadata model.

**Verdict.** The base head does not transfer as a *predictor* — not raw, not
blended, not even after the scale is fixed. It transfers as *features*: handing
the local metadata GBM the base head's three log quantiles gives −2.6%
[−4.4%, −0.9%] with every one of the five folds negative and the worst fold at
−0.8%. That beats the local-text λ = 0.35 result on both counts. Reproduced as
row c inside the same script it is −1.5% [−2.7%, −0.3%] with one fold at
+4.7%; running the original `probe_shrinkage.py` on today's export gives
−1.8% [−3.1%, −0.5%] against the −2.0% [−3.1%, −0.7%] recorded above, the
difference being 32 new turns in the corpus since that table and a slightly
different session ordering (this script orders sessions over text-carrying
rows only). Either way, d1 is a better result with a tighter interval and no
losing fold. B.3 passes.

### Step C decision implied by these criteria

B.1 passes the adopt gate on one agentic corpus and B.3 does not regress
locally, which is the condition Step C states, so Stage 1 proceeds — with one
change to its shape. **The public base head ships as three extra features into
the local metadata GBM, not as a prediction to be blended into the forecast.**
Rows b and b′ refuse the geometric blend of a transferred head, and row d2
refuses the shrunk hashed residual; only row d1 survives. λ therefore stops
being the transfer knob and stays what it already is locally: the weight on a
LOCALLY trained text head, if one is kept at all.

The size of the win argues against the rest of the spend. One percent on 35k
public turns, 2.6% locally, and a learning curve with no slope past 20k turns
mean the hashed n-gram feature form has been measured out ON CODING PROMPTS.
The WildChat control shows the form itself is not the limit — it returns −5.5%
on general chat — so what is exhausted is the signal available in the way
developers write to a coding agent, once length and requirement count are
already in the metadata vector. It clears the adopt bar here and it will never
clear the breakthrough bar here. So Stage 2's synthetic
developer should be budgeted at roughly the 20k turns B.2 identifies and no
more, and any further gain has to come from Stage 3's encoder rather than from
more turns at this feature form.

### Reproducing

```sh
SCRATCH=/tmp/tf-semantic   # never inside the repo
node experiments/evaluation/export-turn-text.mjs --out "$SCRATCH/turns.jsonl"
P=experiments/datasets/public/github-agent-chats/turns.jsonl
python3 experiments/evaluation/semantic/probe_semantic_scale.py b1 "$P" --seeds 3
python3 experiments/evaluation/semantic/probe_semantic_scale.py b1 \
  experiments/datasets/public/wildchat-coding/turns.jsonl --seeds 3
python3 experiments/evaluation/semantic/probe_semantic_scale.py b1 \
  experiments/datasets/public/wildchat-general/turns.jsonl --seeds 3
python3 experiments/evaluation/semantic/probe_semantic_scale.py b2 "$P" --seeds 3
python3 experiments/evaluation/semantic/probe_semantic_scale.py svdnoise "$P" --fold 4
python3 experiments/evaluation/semantic/probe_semantic_scale.py b3 \
  --public "$P" --local "$SCRATCH/turns.jsonl" --seeds 3 --lam 0.75
python3 experiments/evaluation/semantic/probe_shrinkage.py "$SCRATCH/turns.jsonl"
```

Total compute for the tables above was about 35 minutes on a 12-core laptop.
Nothing was reduced: all five folds and all three seeds ran everywhere.

## Stage 1 implementation plan, 2 September 2026

Decision (user, 2 September): build Stage 1 as revised by Step B. The
public base head ships as three extra features into the turn-total
correction, not as a blended prediction. Implementation is split into two
Opus tasks; the gates below are what I grade them against.

### What ships

1. **A base text head inside `@token-forecaster/predictor`.** A pure
   function `baseTextHead(text) → [logP50, logP90, logP99]` that lowercases,
   tokenizes, hashes word unigrams and bigrams with FNV-1a into `2^B` signed
   buckets, applies `sign·log1p(|count|)`, projects with a fixed SVD matrix
   of `K` components, and walks three quantile tree ensembles trained on
   `github-agent-chats`. Text is touched in memory only; nothing about the
   head persists text. The asset (hash config, quantized SVD matrix,
   ensembles) is generated by a Python trainer and committed as a JSON file
   under the predictor package, with the TS evaluator matched to it by a
   parity test.
2. **Boost feature schema `portable-precall-v4`** = the 38 v3 columns plus
   indices 38–40 holding the base head's three log-quantiles, and index 41 a
   presence bit. When the caller has no text the three are 0 and the bit is
   0; trees learn the split. The per-call correction keeps v3; only the
   turn-total correction (`turnTotalBoost`) trains against v4.
3. **The turn-total request carries `textHead` features, not text.**
   `TurnTotalForecastRequest.boostedContext.textHead?: [n, n, n]`; callers
   that already hold the draft and call `promptForecastFeatures(text)` also
   call `baseTextHead(text)` and pass the result. Every call site in this
   repository is updated.
4. **The repo build trains `turnTotalBoost` on v4** in
   `eval-winning-boost.mjs`, reading turn-root text through the loader's
   `withPromptText` flag, computing the head per turn, then discarding text.
   The existing turn-total gate stays, and a five-fold session check (the
   B.3 d1 protocol) is added and must pass with the whole CI below zero and
   no fold worse than +5% versus the v3 correction.
5. **Telemetry gets `textHeadQuantiles`** (three numbers) alongside the
   existing prompt features, so the server can measure the head without
   seeing text. `hash_only` unchanged.

### Step 0 gate: how small can the head be

Step B used `B=18, K=256`, a 67M-float projection that cannot ship. Before
anything is built, sweep `(B, K) ∈ {(18,256), (14,64), (13,48), (12,32)}` on
the B.1 five-fold protocol and the B.3 d1 transfer. Ship the smallest
configuration whose B.3 d1 interval overlaps the `(18,256)` result and
whose asset is at most 2 MB on disk. If none does, stop and report.

### Parity and privacy checks

- A committed fixture of 200 synthetic prompts generated from a word list
  (no real text) with the Python head's outputs; the TS evaluator must
  match to 1e-6 after dequantization.
- FNV-1a in Python runs over UTF-16 code units to match `charCodeAt`.
- `grep` for the asset and fixture confirms no string longer than the
  synthetic prompts; the loader test suite still passes with
  `withPromptText` off by default.

### What is deliberately out of Stage 1

- Post-training the head on other users' machines. Today the personal
  profile fits empirical rungs, not a GBM, so the local post-training is
  the repo build on this corpus. Moving the boost trainer into the personal
  package is Stage 1b.
- Training the head on WildChat. The coding slice failed its own gate, so
  the head trains on `github-agent-chats` only.
- Any change to the per-call ladder or the personal rung ladder.

### Step 0 sweep, 2 September 2026

Run with the new `sweep` subcommand of
`experiments/evaluation/semantic/probe_semantic_scale.py`. Aggregates land under
the `sweep` key of `experiments/artifacts/semantic-scale.json`.

Three things changed from the B.1 and B.3 tables above, and all three apply to
every row here, so the comparison inside the table is internal:

1. **The hasher is the one that ships**, `experiments/evaluation/semantic/text_hash.py`,
   not sklearn's `HashingVectorizer`: FNV-1a over UTF-16 code units on
   `u:<w>` and `b:<w1> <w2>` terms, bucket `hash % 2^B`, sign from bit 31,
   feature `sign(c)·log1p(|c|)`. It is mirrored in TypeScript by
   `packages/predictor/src/base-text-head.ts` and the two are held together by a
   parity fixture.
2. **Text is truncated to the first 2,000 UTF-16 code units** before tokenising.
   Step B did this for the embedding probes; the shipped head does it too, so
   one pasted 40 kB log cannot dominate a projection and the cost per call is
   bounded.
3. **B.1 runs five folds × two seeds**, not B.1's three, to keep the sweep to
   about six minutes. Stated rather than hidden: the seed only moves the GBM's
   `random_state`, and B.1's own fold spread is far wider than its seed spread.

Two base heads are graded on the B.3 d1 transfer. `d1 text-base` is the head
that actually ships — `baseTextHead(text)` sees the SVD components and nothing
else, because its TypeScript signature takes a string. `d1 meta-base` is the
B.3 form, where the public head also saw the 38 metadata columns, kept for
continuity with the table above. The shipped form decides the gate.

Public corpus `github-agent-chats` (35,006 turns, 1,277 repository sessions);
local corpus 1,814 text-carrying turns in 677 sessions exported today. Control
in both halves is the metadata-only quantile GBM on the same rows, retrained
inside each fold; the intervals are the same 2,000-resample session-block
bootstrap.

| config | proj. floats | asset on disk | B.1 meta+SVD | B.3 d1 text-base | per fold | B.3 d1 meta-base |
|---|---|---|---|---|---|---|
| B=18, K=256 | 67,108,864 | 179.2 MB | −0.36% [−1.04, +0.34] | −2.58% [−4.84, −0.53] | −3.3, −4.3, −3.1, +4.0, −2.2 | −3.17% [−5.27, −1.07] |
| B=14, K=64 | 1,048,576 | 3.06 MB | −0.58% [−1.20, +0.07] | −0.42% [−2.74, +1.83] | −2.5, −0.1, −0.0, −0.1, +1.6 | −1.29% [−2.85, +0.30] |
| **B=13, K=48** | 393,216 | **1.30 MB** | −0.82% [−1.45, −0.17] | **−3.06% [−5.38, −0.74]** | −5.4, −4.5, −3.5, +0.5, +0.9 | −2.49% [−4.19, −0.57] |
| B=12, K=32 | 131,072 | 0.59 MB | −0.62% [−1.23, +0.03] | −1.91% [−3.97, +0.13] | −2.5, −0.2, −2.5, −2.3, −1.6 | −1.29% [−2.78, +0.26] |

Asset size is the exported JSON — a base64 int16 projection plus the three
ensembles — measured by running `train_base_head.py` at each configuration on
all 35,006 rows. Base64 beats nested integer arrays by about 35% at every size,
so that is the encoding the asset uses. Explained variance of the projection
falls from 0.33 at B=18 to 0.20, 0.18 and 0.16.

**Reading the sweep.** Every configuration's d1 interval overlaps the
`(18, 256)` interval, so the overlap test does not discriminate: the four
intervals are two to five percentage points wide on 1,814 local turns, and the
point estimates do not order by size (K=64 is the worst of the four, K=48 the
best). What separates them is the 2 MB cap, which removes `(18, 256)` at
179 MB — a 67-million-float projection, ninety times over — and `(14, 64)` at
3.06 MB.

**Choice: B = 13, K = 48, 1.30 MB.** The literal rule in Step 0 says take the
smallest survivor, which is `(12, 32)` at 0.59 MB. It was not taken, because
its d1 interval includes zero (−1.91% [−3.97, +0.13]) and the head has to pass
the Stage 1 adopt gate — whole CI below zero — at the boost trainer. `(13, 48)`
reproduces the `(18, 256)` reference almost exactly (−3.06% against −2.58%)
with the whole interval below zero and its worst fold at +0.9%, well inside the
+5% bar, and it is still 35% under the cap. The honest caveat is that
`(12, 32)` has all five folds negative and `(13, 48)` has two mildly positive
ones; at this corpus size that difference is noise, and the decisive test is
the five-fold check the v4 boost trainer runs. Switching is one command:
re-run `train_base_head.py` with `--bits 12 --dims 32`.

The base head is an order of magnitude low on the local label at every
configuration — median `local total / base p50` on the training folds is 8.9 to
9.6 — which is the same label mismatch B.3 measured. It does not matter here,
because d1 hands the local GBM the head's three log quantiles as FEATURES and
lets the trees rescale them.

#### Reproducing Step 0

```sh
SCRATCH=/tmp/tf-semantic   # never inside the repo
node experiments/evaluation/export-turn-text.mjs --out "$SCRATCH/turns.jsonl"
P=experiments/datasets/public/github-agent-chats/turns.jsonl
python3 experiments/evaluation/semantic/probe_semantic_scale.py sweep \
  --public "$P" --local "$SCRATCH/turns.jsonl" --seeds 2 \
  --label github-agent-chats
python3 experiments/evaluation/semantic/train_base_head.py \
  --public "$P" --bits 13 --dims 48 \
  --out packages/predictor/src/text-head/base-text-head.json
python3 experiments/evaluation/semantic/make_parity_fixture.py
pnpm --filter @token-forecaster/predictor test
```

`train_base_head.py` writes two files: the JSON asset at `--out`, which is what
the 2 MB cap is read against, and, beside it,
`packages/predictor/src/text-head/base-text-head-asset.ts`, which inlines the
same JSON as a typed constant. The TypeScript module is the one that ships,
because `tsconfig.base.json` sets no `resolveJsonModule` and the predictor
package publishes `dist` only — the same reason `bundled-profile.ts` is a `.ts`
file rather than a `.json` one.

Both live under `packages/predictor/src/text-head/`, which is the package's
`./text-head` subpath export and is *not* reachable from `src/index.ts`. The
shipped turn-total correction is a schema v2 profile whose trees never index
past 37, so it reads no head column; leaving the asset on the main entry would
have put 1.2 MB into every extension, companion and status-line build that
never calls the head. A caller that wants it writes
`import { baseTextHead } from "@token-forecaster/predictor/text-head"`.

### Stage 1 part 2 results, 2 September 2026

Built: schema `portable-precall-v4` (42 columns — the 38 v3 columns, the base
head's three `log1p` quantiles at 38-40, a presence bit at 41), the optional
`boostedContext.textHead` on the turn-total request, the v4 training arm in
`eval-winning-boost.mjs`, the extension call site, and the
`textHeadQuantiles` telemetry field.

**The head did not earn its columns, so v3/v4 was not deployed.** The
turn-total correction still ships `portable-precall-v2`, unchanged.

Gate, run on 1,818 of 2,181 exact turns whose opener text was recoverable, in
678 sessions. Control is the identical turn boost at `portable-precall-v3`
(same rung ladder, same 24 depth-2 trees per quantile at lr 0.05), so the only
difference between the arms is the four head columns. Protocol is B.3 d1:
five chronological session blocks, leave-one-block-out, both arms trained
inside each fold, summed pinball at p50/p90/p99, 2,000-resample session-block
bootstrap on the paired per-turn difference.

| | turns | v3 loss/turn | v4 loss/turn | v4 − v3 |
|---|---|---|---|---|
| pooled | 1,818 | 11,052 | 11,018 | **−34.4/turn (−0.31%), 95% CI [−169.7, +83.6] = [−1.54%, +0.76%]** |
| fold 1 | 488 | 10,442 | 10,239 | −1.94% |
| fold 2 | 303 | 12,878 | 12,575 | −2.35% |
| fold 3 | 541 | 10,823 | 10,880 | +0.52% |
| fold 4 | 179 | 11,635 | 11,616 | −0.17% |
| fold 5 | 307 | 10,286 | 10,614 | **+3.19%** |

Adopt rule: whole 95% CI below zero AND no fold worse than +5% AND both arms
clear the existing turn-total gate. Two of the three hold — no fold is worse
than +5% (worst +3.19%), and both arms clear the turn-total gate (v3+head arm
−1,861/turn [−2,835, −1,107] against the shipped thinking-only groups, P90
coverage 92.5%). The CI does not: it spans zero, so `ciBelowZero = false` and
v4 is **NOT ADOPTED**.

This is not a dead feature. The final all-data v4 model splits on indices
≥ 38 in 85 places, so the trees do reach for the head; they simply do not
generalise across session blocks with it. The point estimate (−0.31%) is an
order of magnitude smaller than the −3.06% the Step 0 sweep measured for the
same head on the same local turns under the sklearn d1 harness, which is the
gap between "three quantiles help a HistGradientBoostingRegressor fitted on 38
scaled metadata columns" and "three quantiles help 24 depth-2 quantile trees
sitting on top of an already prompt-conditioned rung ladder". The rung ladder
and the v2 prompt columns have taken most of what the head has to give.

Typing simulation, the final all-data models on the seven-phrase draft ladder
(demo model `claude-fable-5`, p50 per phrase):

| model | trajectory | drops | growth |
|---|---|---|---|
| incumbent v2 | 3,873 → 3,890 → 3,890 → 22,301 → 22,863 → 22,863 → 22,863 | 0 | +18,990 |
| candidate v4 | 3,977 → 3,101 → 3,569 → 22,194 → 22,160 → 22,160 → 22,160 | 2 | +18,183 |

The head makes the live chip WORSE to watch: the incumbent grows monotonically
across the whole ladder, and v4 dips twice before the path is typed. That is a
second, independent reason not to ship it, and it is the criterion the
turn-boost config was originally chosen on.

What shipped anyway, because it is infrastructure rather than a model change:
the v4 schema is supported by the runtime and the trainer (a v4 profile would
evaluate correctly the day one is adopted); `historicalTurnTotalForecast`
accepts and forwards `boostedContext.textHead`; the extension computes
`baseTextHead(draft)` and passes it, and uploads it as
`request.textHeadQuantiles` so the head can be graded on real traffic without
the server seeing a draft; and the gate itself is now part of the repo build,
so the decision re-runs on every profile regeneration.

Known cost of the extension wiring: `dist/content.js` goes from 234,808 to
1,507,596 bytes (gzip 60,948 → 814,893), because `baseTextHead` pulls in the
1.3 MB projection asset. That is a large price for a head the shipped model
currently ignores; the honest options are to gate the import on adoption, to
move the head behind the companion daemon, or to re-run `train_base_head.py`
at `--bits 12 --dims 32` (0.59 MB) before the extension ships again.

**Follow-up, same day (reviewer).** The extension wiring was reverted: with
the shipped correction on v2 the head is dead weight, and importing it made
`content.js` 234 KB → 1.5 MB. `engine.ts` keeps the request field and the
snapshot column and documents the one-line re-wire; the bundle is back to
234,625 bytes.

**Follow-up, 4 September 2026 (housekeeping).** The first of the three honest
options above was taken: the asset now sits in
`packages/predictor/src/text-head/`, exported as the package's `./text-head`
subpath and unreachable from `src/index.ts`, so the import is gated on the
caller asking for the head rather than on anyone remembering not to. The main
entry's reachable graph is 412 KB, down from 1.7 MB, and every consumer of the
predictor -- extension, companion, status line -- stopped paying for a head the
shipped v2 correction ignores. `src/base-text-head.ts` keeps the pure feature
form and `createBaseTextHead(asset)`; only `src/text-head/index.ts` touches the
asset. The base profile regeneration the pipeline wanted (corpus
doubled since 12 August; its own gates now adopt the per-call `promptPath`
ladder and drop the pooled thinking groups) is a separate change and was
pinned out of this one.

## Results, 3 September 2026: Stage 3 encoder probe and "global ranks, local rescales"

Run with `experiments/evaluation/semantic/probe_encoder.py` (subcommands
`part1`, `part2`, `smoke`). Aggregates land under the `encoder` key of
`experiments/artifacts/semantic-scale.json`; checkpoints and logs stayed in the
session scratchpad; no prompt text is printed or written anywhere.

The question this answers: is the ~1% ceiling measured for hashed n-grams on
coding prompts a limit of the bag-of-words feature form, or of the domain?
Stage 3 said an encoder would tell. It has.

**The encoder head.** `all-MiniLM-L6-v2` (22M parameters), text truncated to
the first 2,000 UTF-16 code units then 256 word pieces, mean pooling, a
384 → 64 → 3 head with cumulative-softplus ordering of the three outputs,
trained end to end on the sum of the three pinball losses on `log1p(total)`.
AdamW, 2e-5 on the encoder and 1e-3 on the head, batch 32, 6% warmup, up to
four epochs; the epoch is chosen on the chronologically last 10% of the
training sessions, so the encoder trains on ~90% of each training fold while
the GBM control trains on all of it. Two arms: `encoder only` (text alone, the
shape `baseTextHead` ships) and `encoder + meta` (the 38 standardised metadata
columns concatenated before the head). A third, cheap arm, `frozen MiniLM +
meta GBM`, feeds the untuned 384-dimensional embedding to the metadata GBM and
asks whether fine-tuning matters at all. Control, folds, loss and bootstrap are
those of Step B: metadata-only quantile GBM on the 38 columns, five
chronological session blocks, summed pinball at p50/p90/p99 on the raw token
scale, 2,000-resample session-block bootstrap on the paired per-row difference.

**Two seeds, not three.** One four-epoch fine-tune takes about six minutes on
an M3 Pro's GPU (9.3 steps/s at batch 32), so the full protocol is 40
fine-tunes for the two public corpora plus four for the transfer; three seeds
would have doubled a night's compute for a seed axis that Step B already showed
is far narrower than the fold axis. Every fold ran. Stated once, applies to
every table below.

### Part 1: public b1, `github-agent-chats`

35,006 turns in 1,277 repository sessions, five folds × two seeds, pooled
holdout n = 70,012.

| model | loss | vs control | 95% CI | per fold |
|---|---|---|---|---|
| metadata GBM (38 features) | 2,093 | control | | |
| frozen MiniLM + meta GBM | 2,059 | **−1.6%** | [−2.4%, −0.9%] | −4.0, −1.8, −0.6, −1.9, −1.4 |
| encoder only (fine-tuned) | 2,065 | −1.4% | [−3.4%, +0.4%] | **+7.4**, −4.4, −0.0, −2.3, −1.7 |
| encoder + meta (fine-tuned) | 2,075 | −0.9% | [−3.0%, +1.3%] | **+13.4**, −5.0, +1.0, −3.0, −1.2 |
| blend λ = 0.35 (control, encoder+meta) | 2,023 | −3.3% | [−4.1%, −2.5%] | −1.1, −4.8, −2.1, −3.5, −4.1 |
| blend λ = 0.50 | 2,013 | **−3.8%** | [−4.9%, −2.7%] | +0.2, −5.8, −2.3, −4.2, −4.7 |
| blend λ = 0.75 | 2,024 | −3.3% | [−4.9%, −1.6%] | +4.9, −6.3, −1.5, −4.4, −4.0 |

Spearman rank correlation of p50 with the true total on the pooled holdout:
control 0.172, encoder + meta 0.302.

`encoder + meta` per tool: specstory (63,980 rows) −1.4% [−3.8%, +1.0%];
aider (4,852) **+9.6%** [+2.6%, +17.5%]; cline/roo (1,180) +4.2%
[−8.1%, +15.0%]. Epochs chosen by the inner split ranged over 0–3 with no
pattern; fold 0 picked epoch 2–3 and is the fold where both fine-tuned arms lose
(see the review note below: that block is the aider/cline block, not the
oldest sessions).

**Reading.** The fine-tuned encoder lands where the hashed head landed:
−0.9% to −1.4%, with an interval that includes zero and one fold at +7% or
+13%. It ranks turns far better than the metadata model (Spearman 0.30
against 0.17) and that does not turn into pinball, because the loss is paid
in the tail, where a ranking gain over the median does not help. The FROZEN
embedding does better than the fine-tuned one on every criterion: −1.6% with
all five folds negative, roughly twice the hashed SVD-256 result from B.1 and
the first text arm on this corpus with a clean gate. Fine-tuning 22M
parameters on 28k turns overfits a session block that is not there, which is
the same lesson B.2 taught at the hashed form. The only large number in the
table is the blend, −3.8% at λ = 0.5, and it is the same ensemble effect
STATE-OF-PLAY §6.32 already identified for the local TF-IDF head: two
different learners on the same rows average out each other's errors. It is
worth having and it is not semantics.

### Part 1 control: `wildchat-coding`

Same script, same protocol, the non-agentic control from Step A: one row is
one conversation and the label is the first REPLY's length, so the loss scale
is ~190 pinball units, not ~2,100. 28,148 rows in 7,448 groups, five folds ×
two seeds, pooled holdout n = 56,296. For reference, the hashed head on this
slice was +4.9% [−0.7%, +10.4%] in B.1.

| model | loss | vs control | 95% CI | per fold |
|---|---|---|---|---|
| metadata GBM (38 features) | 192.9 | control | | |
| frozen MiniLM + meta GBM | 189.1 | −2.0% | [−4.8%, +1.0%] | +0.6, −2.0, −0.9, −6.4, +6.5 |
| encoder only (fine-tuned) | 195.9 | +1.6% | [−15.9%, +18.8%] | +3.0, +10.9, −1.6, −28.8, **+84.3** |
| encoder + meta (fine-tuned) | 174.9 | −9.3% | [−30.8%, +12.0%] | −9.6, −5.9, −7.6, −44.9, **+95.6** |
| blend λ = 0.35 | 172.0 | −10.8% | [−18.9%, −2.9%] | −7.4, −6.8, −7.5, −23.6, +14.7 |
| blend λ = 0.50 | 168.1 | −12.8% | [−24.1%, −1.7%] | −9.3, −8.4, −9.3, −30.8, +27.7 |
| blend λ = 0.75 | 167.6 | −13.1% | [−29.4%, +3.0%] | −10.7, −8.9, −10.1, −39.6, +56.7 |

Spearman(p50, y) on the pooled holdout: control 0.461, encoder + meta
**0.744**.

**Reading.** This is the mirror image of the coding-agent corpus and it is the
control doing its job. On WildChat's coding questions the fine-tuned encoder
reads a great deal: it lifts the rank correlation from 0.46 to 0.74 and wins
four of five folds by 6% to 45%, where the hashed head could not clear zero.
Then the last block, a model-era block (see the review note below), loses by 96%, so
the pooled interval runs from −31% to +12% and the gate fails on both
conditions. The text signal in a general coding question is large; it is
also unstable across time on this corpus, which a frozen embedding (−2.0%,
worst fold +6.5%) mostly avoids by not fitting it. Put next to
`github-agent-chats`, where the same encoder moves Spearman from 0.17 to
0.30 and pinball by one percent, the conclusion of B.1's WildChat control
holds with a stronger model: the encoder finds far more to read in a
stand-alone coding question than in a prompt typed to a coding agent, and
what it finds there does not exist here. The ceiling on agent prompts is the
domain.

### Part 2: transfer to the local corpus (B.3 d1 protocol)

Both fine-tuned heads fitted on all 35,006 public rows, one fit per seed,
applied to the local export of 3 September: 1,831 text-carrying turns in 683
sessions, five folds × two seeds, pooled holdout n = 3,662. Control is the
local metadata GBM on the 38 columns, retrained inside each fold. The hashed
row is the shipped `baseTextHead` asset (13 bits × 48 dims), evaluated on the
same rows by the Python reference evaluator, so it is a paired comparison.

| arm | loss | vs control | 95% CI | per fold |
|---|---|---|---|---|
| a local metadata GBM | 10,756 | control | | |
| c local TF-IDF blend λ = 0.35 | 10,592 | −1.5% | [−2.8%, −0.3%] | −2.8, +0.3, −0.6, +4.9, −6.9 |
| h d1 hashed head's 3 log quantiles as features | 10,537 | −2.0% | [−4.6%, +0.3%] | −6.5, −2.6, −1.6, +1.2, +2.9 |
| e1 d1 encoder-only head as features | 10,445 | −2.9% | [−5.2%, −0.4%] | −6.6, −7.5, −0.9, **+7.0**, −1.1 |
| e2 d1 encoder + meta head as features | 10,334 | **−3.9%** | [−6.1%, −1.6%] | −7.6, −4.2, −2.2, −1.6, −2.3 |

Row h is the sweep's −3.06% [−5.38%, −0.74%] re-measured with two seeds on
1,831 rather than 1,814 turns; the point moved by one percentage point and the
interval now grazes zero, which is how wide these local intervals are. Row e2
is the only arm in either half of this document that passes the adopt gate
with every fold negative: −3.9% [−6.1%, −1.6%], worst fold −1.6%. Row e1, the
text-only shape that `baseTextHead` actually ships, passes the interval
condition and fails the fold condition at +7.0% on fold 3 (177 turns).

### Part 2: "global ranks, local rescales"

The user's idea: if the base head ranks turns correctly and only the label
scale is wrong (committed histories under-record output ~10×), then the
base head should be the primary turn-total forecaster with nothing local but
a scale recalibration, and no trees at all. Three recalibrators, each fitted
per quantile on the training fold only: `shift`, a constant in log space (the
pinball-optimal multiplier); `linear`, a two-parameter quantile regression of
`log1p(y)` on `log1p(base_q)`; `isotonic`, ten training-quantile bins with a
monotone per-bin quantile of `log1p(y)` and linear interpolation between bin
centres. Same folds, seeds and control as the table above.

| base | recalibration | loss | vs control | 95% CI | per fold |
|---|---|---|---|---|---|
| hashed | raw | 22,195 | +106.4% | [+91.4%, +122.0%] | +66.9, +105.2, +70.4, +294.0, +126.4 |
| hashed | shift | 11,301 | +5.1% | [+0.5%, +9.5%] | −1.4, −0.7, +2.2, **+38.6**, +7.5 |
| hashed | linear | 11,313 | +5.2% | [+0.5%, +9.6%] | −0.9, +1.4, +1.7, +31.6, +10.1 |
| hashed | isotonic | 11,126 | +3.4% | [−1.4%, +7.9%] | −1.4, −0.2, +2.7, +26.0, +3.4 |
| encoder | raw | 21,253 | +97.6% | [+83.6%, +112.0%] | +66.1, +107.1, +73.3, +230.8, +103.4 |
| encoder | shift | 11,138 | +3.6% | [−1.7%, +8.8%] | −6.8, −5.9, −0.5, **+51.9**, +9.9 |
| encoder | linear | 10,537 | −2.0% | [−7.0%, +2.8%] | −8.3, −7.9, +0.5, +21.7, −3.8 |
| encoder | isotonic | 10,488 | −2.5% | [−7.6%, +2.6%] | −8.0, −8.8, +1.3, +16.1, −4.2 |

Spearman(p50, y) on the pooled local holdout: local metadata GBM 0.449,
hashed base 0.419, encoder base 0.462. Median `local total / base p50` on the
training folds: hashed 8.67 (8.05–11.00), encoder 8.23 (7.16–10.78).

**Reading.** The premise does not hold. On local turns the base heads rank no
better than the local metadata model (0.42 and 0.46 against 0.45), so there
is no rank advantage for a rescale to preserve. Every rescale-only arm loses
fold 3 by 16% to 52%; that block is 177 turns from a period whose scale the
training folds do not predict, and a recalibrator with two to ten parameters
has nothing to fall back on where a tree on 38 metadata columns does. The
encoder with an isotonic rescale reaches −2.5% on the point estimate with an
interval from −7.6% to +2.6%, which is worse than handing the same head to
the local GBM as features (row e2). Trees stay.

### What Stage 3 concludes

1. **The limit is the domain, not the feature form.** A 22M-parameter
   encoder, fine-tuned or frozen, lands at −0.9% to −1.6% on 35k coding
   prompts, where hashed n-grams landed at −0.9%. The same encoder on
   WildChat's coding questions lifts rank correlation to 0.74 and wins four
   folds by 6–45%, so it is not blind; agent prompts are what it cannot read. The text of a coding
   prompt, beyond the length and requirement count the 38 features already
   carry, is worth one to two percent of pinball on turn totals. Stage 3's
   headroom was the last untested hypothesis on prompt text and it is now
   measured.
2. **Frozen beats fine-tuned at this turn count.** Fine-tuning overfits a
   session block in both public arms (fold 0 at +7% and +13%). If an encoder
   is ever used, it is the frozen embedding as GBM features.
3. **Transfer as features improves with the encoder** (−3.9% locally against
   −2.0% for the hashed head on the same rows, both as features into the
   local GBM), and it is the only clean gate pass in this document. It is
   also the arm the Stage 1 boost trainer will most likely shrink to nothing,
   as it did with the hashed head (−3.06% in the sklearn harness became
   −0.31% on top of the rung ladder).
4. **"Global ranks, local rescales" is refused.** No rank advantage to
   preserve, and no fallback on the block whose scale shifts.
5. **The blend is the one number above three percent** (−3.8% public,
   λ = 0.5) and it is an ensemble effect available to any second learner.

**Decision.** The encoder does not replace the hashed head in
`packages/predictor/src/base-text-head.ts`. Shipping MiniLM to the extension
is 22M parameters (about 23 MB quantised, 90 MB in float32) against 1.3 MB for
a head whose measured advantage over it is one to three points on local
intervals four to six points wide; the only place it could run is behind the
companion daemon, and the gain it would bring there is the same order as the
noise of the gate it would have to pass. Forecasting effort moves to context
and repository signals. Prompt text is closed as a line of work at the current
turn count; the open items in BACKLOG under this issue are reduced to the two
that do not depend on it.

### Review of the measurement, 3 September 2026

Reviewed the probe before planning on top of it. What holds, what does not.

**Holds.** Rows are grouped by session in every fold; the inner validation
split for epoch selection is cut from training sessions only; metadata
standardisation is fitted on the training fold; the frozen embedding is
label-free and computed once; holdout predictions are taken at the selected
epoch without touching holdout labels; the control is the imported Step B
learner on the same rows; the bootstrap is the same paired session-block
resample. In Part 2 the public fit never sees local rows, and every local
recalibrator and d1 GBM is fitted inside the fold. The hashed row is computed
from the committed asset by the reference evaluator. None of the numbers
above leak.

**Does not hold: "chronological".** The public corpora have no timestamps.
`harvest_github_chats.py` writes `firstMs` as the row's position in harvest
order, and `build_wildchat_slice.py` falls back to the row index when the
source carries no timestamp, which this slice does not. `load()` orders
sessions by that field, so on public data the five "chronological session
folds" are five harvest-order blocks. This applies equally to every public
table in this document, including B.1 and B.2 from 2 September; the local
corpus is unaffected (its `firstMs` is a real epoch time).

What the blocks actually are:

| corpus | fold | rows | tool / model mix | label p50 |
|---|---|---|---|---|
| github-agent-chats | 0 | 4,817 | specstory 2,604, aider 1,805, cline 408 | 532 |
| | 1 | 8,642 | specstory 7,839, aider 621, cline 182 | 669 |
| | 2–4 | 8,126 / 8,189 / 5,232 | specstory only | 688 / 899 / 550 |
| wildchat-coding | 0–2 | 5,299 / 4,878 / 3,280 | gpt-3.5 and gpt-4-0314 era | 331 / 304 / 329 |
| | 3 | 10,175 | gpt-3.5-turbo-0613 | **37** |
| | 4 | 4,516 | gpt-4-0125 / 1106-preview | **524** |

So github fold 0 is not "the oldest sessions": it is the block holding 78%
of the aider rows and 65% of the cline rows, held out against a training set
that is nearly all specstory. The encoder's +13% there is an out-of-tool
transfer failure, consistent with the per-tool cut (aider +9.6%
[+2.6%, +17.5%]). Within the specstory-only blocks the fine-tuned head is
−5.0%, +1.0%, −3.0%, −1.2%: still one to two percent, still unstable. And
wildchat fold 4 is a model-era shift with a 14× jump in median reply length
from the neighbouring block, which is what a +96% fold looks like; the
control suffers the same shift and the encoder, which fits the text more
tightly, suffers it more. The blocks remain a valid out-of-session,
out-of-tool test, and the hashed and encoder heads were graded on the same
blocks, so the comparison between them stands. What has to be reworded is
the interpretation of "fold 0" and "the last fold" above, which this note
supersedes.

**Consequence for the verdict.** None of the five points change. The
encoder is one to two percent on agent prompts in every block that shares a
tool with its training data and fails on the block that does not, which is
a worse property for a shipped head than the hashed head's flat −0.3% to
−1.8%. The public gate cannot be made chronological without dates, and the
harvester has none to recover: `github-agent-chats` sessions are repository
snapshots, not timelines.

**Minor.** The `presence` column 41 is left at zero in row h (constant
column, harmless). Raw-scale predictions are clipped at `expm1(20)`; no
fold's loss is consistent with a handful of runaway rows, so the clip did
not bind on anything that mattered.

### Deviations from the protocol, stated

- Two seeds everywhere in this section (see above).
- The local export's v4 columns 38–41 came out all zero, so the hashed head
  in rows h and "hashed base" was recomputed from `base-text-head.json` by
  the Python reference evaluator. `export-turn-text.mjs` does not populate
  the head columns; its `features` field is the 42-wide v4 vector with the
  head columns unfilled.
- Wall clock for `github-agent-chats` part 1 is recorded as 25,250 s, but
  folds 1–3 took ~1,350 s each and fold 4 took 18,769 s. The cause was memory,
  not compute: PyTorch's MPS caching allocator never purges below its default
  low watermark (1.0 × the 12.9 GB recommended maximum on this machine), so
  the process parked 5.9 GB of cached blocks for ~0.3 GB live, and when a
  local Ollama model loaded overnight the 18 GB box swapped and GPU work fell
  ~20×. The script now sets `PYTORCH_MPS_LOW_WATERMARK_RATIO=0.12` (3.1 GB
  steady state at the same speed), frees the optimizer with the model between
  arms, and logs allocator memory per epoch. The smoke run reproduced the
  reference numbers exactly after the change (control 1240.6, frozen+meta
  1191.2, holdout 1474.3). The artifact's `steps_per_second` field (2.6) for
  this key is contaminated; the real rate is 9.3 steps/s on this corpus and
  ~4.7 on `wildchat-coding`, whose texts are twice as long.

### Reproducing

```sh
SCRATCH=/tmp/tf-semantic   # never inside the repo
node experiments/evaluation/export-turn-text.mjs --out "$SCRATCH/turns.jsonl"
P=experiments/datasets/public/github-agent-chats/turns.jsonl
W=experiments/datasets/public/wildchat-coding/turns.jsonl
export HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
python3 experiments/evaluation/semantic/probe_encoder.py smoke --turns "$P"
python3 experiments/evaluation/semantic/probe_encoder.py part2 \
  --public "$P" --local "$SCRATCH/turns.jsonl" --seeds 2
python3 experiments/evaluation/semantic/probe_encoder.py part1 --turns "$P" --seeds 2
python3 experiments/evaluation/semantic/probe_encoder.py part1 --turns "$W" --seeds 2
```

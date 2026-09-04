# Context and repository signals for turn totals

*Planned 3 September 2026, after the Stage 3 encoder probe closed prompt text
as a line of work (`docs/SEMANTIC-PLAN.md`, "Results, 3 September 2026").
Plan and gates by Fable; implementation by Opus; grading on five local
session folds with the session-block bootstrap, never a single split.*

## Why this and not more text

Prompt text beyond length and requirement count is worth one to two percent
of pinball on coding prompts, measured three ways (hashed n-grams, a frozen
MiniLM embedding, a fine-tuned MiniLM head). STATE-OF-PLAY §5 says the loss
is not a fog: it is a few dozen long `Write` calls per corpus, and §7.3 says
the prompt predicts the turn, never the call. What the prompt does not say is
what the agent is about to touch. That is what this plan measures: signals
about the repository the session is in and about what the session has
already touched, all of them known before the first call of the turn.

The prior evidence is thin but not zero. §6.30's variance decomposition puts
project identity at 0.9–5.3% ICC on log output tokens, +2.1 points on top of
model+thinking, the same order as `model`, which the ladder does condition
on. Nothing in the repo has yet asked whether *properties* of the repository
(size, language, tests, the files the prompt names) or of the session so far
(files already read, files already changed) carry that or more.

## Constraints, restated so the implementation cannot drift

1. **Cold-start first.** Every new signal is optional. Absent means unknown,
   never false; the vector carries a presence bit per family and the trees
   learn the split. The bundled predictor must forecast with none of it.
2. **No path text.** The loader already reduces paths to transient SHA-256
   fingerprints that never leave it. New features are counts, sizes, bits and
   size classes. No file name, directory name, branch name or repository
   name is written to a profile, artifact, telemetry row or log.
3. **Pre-call only.** A feature is admissible if the companion could compute
   it at the moment the human presses enter, from the cwd, the git repository
   at that cwd, the draft's counts, and the session's completed calls.
   Anything derived from the turn's own calls is an oracle and is labelled so.
4. **Historical reconstruction must be honest.** Repository state at the
   time of a past turn is reconstructed at the nearest commit at or before
   the turn's timestamp (`git rev-list -1 --before=<ts> HEAD`, then
   `git ls-tree -r -l`). Working-tree state (uncommitted diff) is not
   reconstructible and is excluded from this round. Directories that are not
   git repositories get present-day counts and a `reconstructed=0` flag.
5. **Grading.** Control is the local metadata quantile GBM on the 38 v3
   columns, same rows, same learner, same seeds (`probe_semantic_scale.gbm`).
   Five chronological session folds (the local corpus has real timestamps),
   three seeds, summed pinball at p50/p90/p99 on the raw token scale, 2,000-
   resample session-block bootstrap on the paired per-row difference. Pass =
   whole 95% CI below zero AND no fold worse than +5%. A second cut,
   leave-one-project-out over the corpus's `workloadId`, is reported for the
   repository-state family because that family exists to transfer across
   repositories; it informs, it does not gate.

## Step 0: the oracle ceiling, before anything is built

Per turn, from the turn's own calls (post hoc, never shippable): number of
calls, distinct files read, distinct files searched, distinct files mutated,
whether any `Write` occurred, the largest single tool-input size class. Feed
them to the control GBM as extra columns. This is the ceiling for every
pre-call context signal: if knowing exactly what the agent touched moves
pinball by less than five percent, no proxy for it will clear the adopt gate
and the plan stops at this step with a one-table report.

## Step 1: the two pre-call families

**Session-so-far (S).** Computed by the loader from the session's completed
calls before this turn root: turns so far, calls so far, distinct files read
so far, distinct files mutated so far, distinct files searched so far,
whether the previous turn mutated anything, output tokens of the previous
turn (log1p), and minutes since the previous turn root (capped). The v3
vector already carries `sessionPosition`, `loopDepth`, `priorCallCount` and
`priorMaxOutputTokens`; the implementation must read
`packages/predictor/src/boosted.ts` and drop any S column that duplicates
an existing one at the turn root.

**Repository state (R).** Computed per turn from the cwd at the nearest
commit at or before the turn's timestamp: file count (log1p), tracked bytes
(log1p), share of files by top extension family (code / config / docs /
tests, four floats), test-directory or test-file presence bit, `CLAUDE.md`
or `AGENTS.md` presence bit, commit count up to that commit (log1p), days
since the previous commit (capped), branch-is-default bit, plus the
draft-named paths: how many paths the prompt names, how many of those exist
in the tree at that commit, and the log1p size of the largest one. Presence
bit `R_present`, reconstruction bit `R_reconstructed`. Non-git cwds get
present-day counts and `R_reconstructed = 0`.

Path extraction from the prompt uses the loader's existing `withPromptText`
path and the same path pattern the companion's draft counter uses, so live
and historical agree; the text is reduced and dropped inside the exporter.

## Step 2: what to measure

One exporter, `experiments/evaluation/export-turn-context.mjs`, writes one
row per exact turn to a scratchpad file (refuses in-repo paths, like
`export-turn-text.mjs`): `turnRootId`, `sessionId`, `workloadId`, `firstMs`,
`total`, `calls`, `model`, `thinking`, the 38 v3 columns, the S columns, the
R columns, and the oracle columns. No text, no paths, no hashes of paths.

One probe, `experiments/evaluation/semantic/probe_context.py` (it lives with
the other five-fold probes and imports their learner and bootstrap), grades
these arms against the control:

| arm | columns |
|---|---|
| control | 38 |
| oracle | 38 + oracle |
| S | 38 + S |
| R | 38 + R |
| S + R | 38 + S + R |
| S + R + oracle | ceiling with both families, for the gap |

Aggregates go under the `context` key of a new
`experiments/artifacts/context-signals.json`. Report per arm: loss, delta,
95% CI, percent, per-fold percent, gate pass/fail, and for R the
leave-one-project-out cut. Also report feature importance for the winning
arm as permutation drops on the pooled holdout, so the doc can say which
columns did the work.

## Step 3: ship, only if Step 2 passes

If S, R or S+R passes the gate, and only then: schema `portable-precall-v5`
in `boosted.ts` (v3 columns plus the passing family, presence bits last),
the loader emits S per turn root, the companion computes R at launch and
refreshes it per turn (one `git ls-tree` per distinct commit, cached), the
turn-total request carries `repoContext` and `sessionContext`, the boost
trainer in `eval-winning-boost.mjs` grades v5 against v3 with the existing
five-fold gate plus the typing-trajectory check, and telemetry carries the
new columns as numbers. That is a second Opus task with its own spec; it is
not started until the Step 2 tables are reviewed.

## Gates, restated

- Step 0 stop rule: oracle ceiling under 5% → stop, report.
- Step 2 adopt rule per family: whole 95% CI below zero AND no fold worse
  than +5%, on five chronological session folds, three seeds.
- Anything that needs the turn's own calls is an oracle and never ships.
- No feature that cannot be reconstructed historically is graded; it is
  listed as future work with the reason.

## Results, 3 September 2026: Steps 0–2

Run with `experiments/evaluation/export-turn-context.mjs` (numbers only,
refuses in-repo paths) and `experiments/evaluation/semantic/probe_context.py`;
aggregates in `experiments/artifacts/context-signals.json`. Population: all
2,225 exact turns, 689 sessions, 22 projects; five chronological session
folds × three seeds, pooled holdout n = 6,675. Control 10,090 pinball per
turn (10,738 on the 1,849 text-carrying turns, against 10,756 in the encoder
run: the population differs, the harness does not).

Columns as built: S = turns so far, files read / mutated / searched so far,
previous turn mutated, previous turn output (log1p), minutes since the
previous turn root, two presence bits; `callsSoFar` dropped because v3's
`sessionPosition` is that number at a turn root. R = file count, bytes, four
extension-family shares, tests bit, agent-doc bit, commit count, days since
previous commit, branch-is-default, draft-named paths / existing / largest,
reconstruction and presence bits. Oracle = calls, files read / searched /
mutated in the turn, any `Write`, largest tool-input size class.

| arm | loss | vs control | 95% CI | per fold | gate |
|---|---|---|---|---|---|
| control (38) | 10,090 | | | | |
| oracle | 3,748 | **−62.9%** | [−70.8%, −55.5%] | −65.5, −71.3, −65.8, −43.1, −55.9 | ceiling, never ships |
| S | 9,933 | **−1.6%** | [−3.0%, −0.05%] | −1.8, +0.7, −2.9, +1.7, −3.1 | **pass**, barely |
| R | 10,420 | +3.3% | [+0.9%, +5.7%] | +0.5, +2.4, +4.6, +5.8, +4.5 | fail |
| S + R | 10,318 | +2.3% | [−0.1%, +4.8%] | −1.1, +0.6, +4.0, +11.6, +0.1 | fail |
| S + R + oracle | 3,910 | −61.2% | [−69.2%, −54.1%] | | ceiling |

**Step 0.** The stop rule did not fire, but read the ceiling before
building on it. Permutation drops on the oracle arm: calls in the turn
+205%, largest tool input +157%, files mutated +4.8%, files read +2.6%, any
`Write` +0.2%. Two thirds of the loss is explained by how long the loop ran
and how big its biggest tool input was; which files it touched is worth a
few percent on top. That is a duration ceiling, not a context ceiling, and
no pre-call signal about the repository can reach it, because the loop's
length is decided by what the agent finds, not by what is on disk before it
starts.

**S.** Passes on the letter with a 0.05-point margin. Permutation drops:
turns so far +5.9%, previous turn's output +1.9%, files mutated so far
+0.5%, minutes since previous turn +0.5%; the file-touch counts are noise.
So the whole win is the turn index and the previous turn's size, which are
the turn-level twins of `sessionPosition` (already in v3) and
`previousOutputTokens` (§7.1, refused per call in August). Files searched
so far is unmeasurable through the loader: Glob/Grep inputs rarely carry a
path key, so the column is non-zero on 0.0% of turns.

**R.** Fails the gate and fails transfer. Leave-one-project-out on the ten
projects with enough rows: two provably worse (+52% on 64 rows, +10% on
164), one provably better (−13%), seven indistinguishable. The repository
columns let the trees memorise which project a turn belongs to, the same
finding as §6.30, now with the mechanism visible. Draft-named paths were
thin as well: 21% of turns name a path the companion's pattern accepts, 3%
name one that exists in the tree at that commit, because the pattern
requires a leading `/`, `./`, `../` or `~/` and most people type
`packages/core/index.ts`. 73.6% of turns were reconstructed at a real
commit, 21.1% at a non-git cwd with present-day counts, 5.3% at a cwd that
no longer exists.

**Decision.** Step 3 as written is not warranted: R is refused and S+R is
refused. The one thing S earns is a run through the real gate, not the
sklearn one: `turnsSoFar` and `prevTurnOutput` as two columns of a
`portable-precall-v5` candidate in `eval-winning-boost.mjs`, graded against
v3 on the existing five-fold session check and the typing-trajectory check.
The text head went from −3.06% in this harness to −0.31% on top of the rung
ladder, and these two columns are closer to what the ladder already holds
than the head was, so the prior is that they shrink the same way. If they
do, context signals close at the same place text did, and the remaining
lever on turn totals is the loop's own duration, which is only observable
after the turn starts: that is a re-forecast-as-you-go problem (§6.9, §7.1),
not a pre-call one.

## Results, 3 September 2026: the two session columns through the real gate

Built as schema `portable-precall-v5` (45 wide: columns 42 = `log1p(turnsSoFar)/6`,
43 = `log1p(previousTurnOutputTokens)/10`, 44 = presence bit; 38–41 stay the
refused text head's, so v1–v4 profiles are untouched and v5's candidate set
is the 38 v3 columns plus 42–44 only). Optional
`boostedContext.sessionContext` on the request; no call site wired. Graded
in `eval-winning-boost.mjs` exactly like the text head: five session blocks,
both arms trained inside each fold, paired session-block bootstrap. All
2,229 exact turns in 689 sessions; 1,338 turns had a completed previous turn.

| | turns | v3 loss/turn | v5 loss/turn | v5 − v3 |
|---|---|---|---|---|
| pooled | 2,229 | 10,481 | 10,511 | **+29.6/turn (+0.28%), 95% CI [−41.2, +100.1] = [−0.39%, +0.96%]** |
| fold 1 | 552 | 10,462 | 10,517 | +0.53% |
| fold 2 | 356 | 12,486 | 12,603 | +0.94% |
| fold 3 | 697 | 10,084 | 10,046 | −0.38% |
| fold 4 | 222 | 11,204 | 11,276 | +0.64% |
| fold 5 | 402 | 9,023 | 9,034 | +0.12% |

Gate: CI below zero **fails** (upper +0.96%); worst fold +0.94% passes; both
arms clear the turn-total gate (incumbent −1,854/turn, v5 −1,817/turn, P90
coverage 93.05% both). **NOT ADOPTED.** Deployed turn schema stays
`portable-precall-v2`. The final all-data v5 model splits on the session
columns 51 times and still does not generalise across session blocks. The
typing trajectory is clean (zero drops at turnsSoFar = 0 and = 5; the turn
index moves the pre-path estimate by ~90 tokens), so this is a well-behaved
feature that does not pay, not a broken one.

The sklearn harness said −1.6%; the rung ladder said +0.3%. Same shrink the
text head took (−3.06% → −0.31%). **Context signals close here.** Pre-call
turn-total signals on this corpus are measured out: prompt text ~1%,
repository state refused, session-so-far refused at the gate. Two thirds of
the loss is loop duration, which is only observable after the turn starts.
Predictor tests 66/66, `pnpm test:evaluation` 4/4, build clean; no profile
file was rewritten (run without `--profile-out`).

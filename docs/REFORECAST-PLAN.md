# Re-forecast-as-you-go on turn totals

*Written 3 September 2026, after context signals closed
(`docs/CONTEXT-SIGNALS-PLAN.md`, STATE-OF-PLAY §6.33). Plan and gates by
Fable 5.1; implementation by Opus; grading on five chronological local
session folds with the session-block bootstrap, never a single split.*

## Why this is the next lever, and why it is not §6.9 again

Every pre-call turn-total signal on this corpus is measured out: prompt text
is worth about one percent (§6.32), repository state is refused, and the
session so far is refused at the real trainer gate (+0.28% [−0.39%, +0.96%],
§6.33). The oracle that knows the turn's own calls is −62.9%, and permutation
puts two thirds of that on two numbers: how many calls the loop made and how
big its largest tool input was. Neither exists before the first call. Both
start to exist the moment the first call completes.

§6.9 already tried re-forecasting and rejected the *mechanism*. Read it
before reading on, because this plan must not repeat it. §6.9 graded
**per-call** forecasts: at each step of the loop, predict *this call's*
output from the previous step. That found one feature (the previous call's
output length, −16 pinball/call), later refused under the honest bootstrap
(§7.1, −8 [−18, +2]), and found that the agent-loop framing added nothing:
knowing the previous action was a `Read` says nothing about the next call.

This plan grades a different quantity. The status line shows **the turn's
total** ("prompt N in → est X out"), and today that number is frozen at the
moment the human presses enter. The question is whether, once k calls of the
turn have completed, a forecast of the *turn total* that reads what those k
calls did beats the frozen pre-call number by enough to matter. The
per-call result does not answer this: a turn total is dominated by how long
the loop runs, and the strongest evidence that a loop will run long is that
it has already run for k calls and is still going. That is the calls-in-turn
half of the oracle, partially revealed.

## What the status line already observes

`apps/companion/src/statusline.ts` tails the transcript during a turn and
already sums `usage.output_tokens` per request from the turn root, counts
distinct requests, and reads the last `stop_reason` to know whether the turn
is still running. So "calls so far" and "output so far" are live numbers
today. "Largest tool input so far" and "any `Write` so far" need one more
pass over the `tool_use` blocks of the same rows. Nothing in this plan needs
a signal the status line cannot compute from the transcript tail.

## Constraints, restated so the implementation cannot drift

1. **Legal features only.** At k completed calls, a feature is admissible if
   it is a function of calls 1..k of the same turn (their outputs, their
   `tool_use` blocks, their `stop_reason`) plus the pre-call vector. Nothing
   from call k+1 onward. Wall-clock elapsed is *legal* here (every call it
   covers has completed) but is **excluded** from this round: §6.9's legal
   clock measured at zero and its illegal one was the leak of record.
2. **The turn continues.** A row at k exists only for turns with more than k
   calls, because at runtime the k-th call's `stop_reason` being `tool_use`
   is what tells the status line the turn is still running. Turns that ended
   at exactly k calls are not rows at k: the status line shows their final
   number and forecasts nothing.
3. **Turn total, never remaining, is what is graded.** Whatever the model
   parametrises, the loss is pinball on the turn's total output tokens on
   the raw scale at p50/p90/p99, one row per (turn, k), because the total is
   what the bar paints.
4. **Cold-start first.** The candidate is a correction on top of the same
   pre-call forecast the bundled predictor already makes. A caller with no
   per-call visibility keeps the pre-call number.
5. **No text, no paths.** Columns are counts, sizes and bits. The exporter
   refuses in-repo output paths like `export-turn-context.mjs` does.

## Population and rows

All exact turns (loader `loopDepthExact` on every call), the same 2,225-turn
population as `export-turn-context.mjs`. Calls inside a turn are ordered by
timestamp; sidechain calls interleave the same way the status line sees them.
For k in {1, 2, 3, 5}, one row per turn with `calls > k`. Report, before any
model, a table of: turns with `calls > k`, their share of turns, their share
of the pre-call control's total pinball loss. The last column is the reach:
a re-forecast at k can only move loss that sits in turns still running at k.

## Columns

Pre-call: the 38 v3 columns, as exported today.

At k (family **K**):

| column | definition |
|---|---|
| `k_calls` | k, as log1p(k)/4 |
| `k_outputSoFar` | log1p(Σ output tokens of calls 1..k)/12 |
| `k_maxOutputSoFar` | log1p(max output tokens over calls 1..k)/12 |
| `k_lastOutput` | log1p(output tokens of call k)/12 (the §7.1 feature) |
| `k_maxToolInput` | log1p(largest single `tool_use` input in chars over calls 1..k)/10 |
| `k_anyWrite` | 1 if any call 1..k carried a `Write` tool_use |
| `k_anyMutation` | 1 if any call 1..k carried `Write`, `Edit`, `MultiEdit` or `NotebookEdit` |

Oracle at k (family **O**, never ships): the turn's final call count and final
largest tool input, i.e. the §6.33 oracle columns. The gap between K and K+O
at each k is what the rest of the loop still hides.

## Arms, per k

| arm | what it is |
|---|---|
| **precall** | the 38-column control GBM's forecast, unchanged. What the bar shows today. |
| **clamp** | precall with each quantile raised to at least `outputSoFar`. Zero learning, zero dips by construction. **This is the control the gate is against**, because any moving display must at least do this. |
| **reforecast** | GBM on 38 + K, target log1p(total). |
| **remaining** | GBM on 38 + K, target log1p(total − outputSoFar), prediction added back to outputSoFar. **This is the named candidate.** `reforecast` is a sensitivity arm. |
| **oracle** | GBM on 38 + K + O. Ceiling at k. |

Same learner as every five-fold probe here (`probe_semantic_scale.gbm`:
`HistGradientBoostingRegressor`, quantile loss, min leaf 40, depth 3, 150
iterations, lr 0.05), three seeds, five chronological session folds, all
arms trained inside each fold on that fold's training rows at the same k.
The precall control is fitted once per fold on turns (not on (turn, k)
rows) and its forecast reused at every k, so it is the same number the bar
would have frozen.

## Gates, stated before the run

Per k, paired per-row difference `remaining − clamp`, summed pinball at
p50/p90/p99 on the raw scale, 2,000-resample session-block bootstrap.

- **Adopt-for-a-real-gate rule.** The whole 95% CI below zero, no fold worse
  than +5%, **and** the point estimate at or below **−10% at k = 1 and −15%
  at k ≥ 3**. The last clause is new and deliberate: the sklearn harness
  overstated the text head by 2.7 points (−3.06% → −0.31%) and the session
  columns by 1.9 points (−1.6% → +0.28%) once they went through the rung
  ladder. A re-forecast that does not clear those margins with room to
  spare does not earn a trainer task; it closes like the other two.
- **Ceiling reading.** If `oracle − clamp` at k = 1 is above −30%, most of
  the −62.9% is not recoverable by anything the loop reveals early, and the
  doc says so.
- **Reach reading.** If turns still running at k = 1 hold less than half of
  the pre-call loss, a moving estimate can never touch the majority of the
  error and the plan says so, whatever the per-row win.

Anything using family O never ships.

## The dip criterion

The typing-trajectory check (`eval-winning-boost.mjs`) refuses a turn model
whose p50 falls as the draft grows. A moving turn estimate has the same
product constraint: an estimate that reads 12k, then 7k, then 15k as calls
complete is a worse bar than a frozen one, even if its pinball is lower.

Per held-out turn, the shown p50 path is `s_0 = precall p50`, then the
candidate's p50 at k = 1, 2, 3, 5 where the row exists. Report, per step:

- dip rate: share of steps where `s_k < s_{k−1}`;
- dip depth: median and p90 of `(s_{k−1} − s_k) / s_{k−1}` over dips;
- the same for the p90 quantile, which is what the bar's band paints.

Then grade a **ratchet** variant, `s_k := max(s_k, s_{k−1})` applied to each
quantile, with the same bootstrap against clamp. Decision rule, stated now:

- the moving estimate is displayable **raw** if the p50 dip rate is at or
  below 10% of steps and the p90 dip depth is under 25%;
- otherwise it is displayable **ratcheted** only if the ratchet keeps the
  whole CI below zero against clamp and gives up no more than 3 points of
  the raw win;
- otherwise the estimate does not move, whatever it measured.

`clamp` has a dip rate of zero by construction, which is the reason it is
the control and not `precall`.

## Deliverables

1. `experiments/evaluation/export-turn-reforecast.mjs`: one JSONL row per
   (exact turn, k), numbers only, scratchpad only. Reuse the turn assembly
   and the second-pass per-call largest-tool-input scan from
   `export-turn-context.mjs` rather than re-deriving them. A `--columns-out`
   side file names the columns.
2. `experiments/evaluation/semantic/probe_reforecast.py`: imports `gbm`,
   `folds_of`, `block_boot`, `loss_rows`, `summarise`, `print_table` from
   `probe_semantic_scale.py`; writes aggregates under the `reforecast` key of
   `experiments/artifacts/reforecast.json` with the locked read-modify-write
   `probe_context.py` uses. Per k: the reach table, the arm table (loss,
   delta vs clamp, delta vs precall, 95% CI, percent, per-fold percent,
   gate), the oracle gap, the dip table, the ratchet row, and permutation
   drops for the `remaining` arm.
3. This document gains a "Results" section with the tables and the verdict.
   STATE-OF-PLAY gains §6.34 and BACKLOG a line.

## What this does not decide

Whether the correction should live in the daemon or the status line, and
what the multi-user corpus needs to carry for anyone else to reproduce it.
Both wait for the tables.

## Results, 3 September 2026

Run with `experiments/evaluation/export-turn-reforecast.mjs` (numbers only,
refuses in-repo paths) and `experiments/evaluation/semantic/probe_reforecast.py`;
aggregates in `experiments/artifacts/reforecast.json` under `reforecast`.
Population: all 2,245 exact turns, 690 sessions, 22 projects (the corpus grew
by 20 turns since the context probe); five chronological session folds ×
three seeds; 8,472 rows over k ∈ {0, 1, 2, 3, 5}; wall clock 147 s. The
k = 0 control reproduces the context probe's control (10,076 vs 10,090 per
turn). Implementation by Sonnet, not Opus: Opus returned HTTP 529 four times
over twelve minutes and the run was not deferred further.

**Reach.** A re-forecast can only move loss in turns still running at k.

| k | rows | share of turns | share of pre-call loss |
|---|---|---|---|
| 1 | 1,822 | 81.2% | 92.0% |
| 2 | 1,646 | 73.3% | 89.0% |
| 3 | 1,500 | 66.8% | 86.5% |
| 5 | 1,259 | 56.1% | 81.5% |

The reach reading does not fire: the long turns are where the loss lives.

**Arms.** Loss per row, summed pinball at p50/p90/p99 on the raw scale;
deltas are paired against `clamp` with the session-block bootstrap. Gate for
`remaining`: whole CI below zero, no fold worse than +5%, point at or below
−10% (k = 1, 2) or −15% (k ≥ 3).

| k | arm | loss | vs clamp | 95% CI | per fold | gate |
|---|---|---|---|---|---|---|
| 1 | precall | 11,426 | +0.6% | [+0.4%, +0.9%] | +1.6, +0.1, +0.4, +0.2, +0.3 | |
| 1 | clamp | 11,358 | | | | control |
| 1 | reforecast | 11,035 | −2.8% | [−5.2%, −0.4%] | −7.7, −7.8, +0.7, +7.1, −3.0 | fail (fold) |
| 1 | **remaining** | 10,822 | **−4.7%** | [−7.6%, −1.9%] | −9.7, −7.3, −3.5, +6.8, −3.9 | **fail** (fold +6.8, point) |
| 1 | oracle | 4,233 | −62.7% | [−71.9%, −54.4%] | −62.1, −70.7, −66.4, −52.7, −54.1 | ceiling |
| 2 | precall | 12,235 | +1.1% | [+0.8%, +1.5%] | | |
| 2 | clamp | 12,099 | | | | control |
| 2 | reforecast | 11,424 | −5.6% | [−9.4%, −1.7%] | −8.1, −10.3, −3.6, +1.9, −4.7 | fail (point) |
| 2 | **remaining** | 11,347 | **−6.2%** | [−10.2%, −2.0%] | −10.3, −11.1, −4.6, +3.3, −3.6 | **fail** (point) |
| 2 | oracle | 4,526 | −62.6% | | | ceiling |
| 3 | precall | 13,039 | +1.9% | [+1.4%, +2.4%] | | |
| 3 | clamp | 12,799 | | | | control |
| 3 | reforecast | 11,832 | −7.6% | [−11.6%, −4.0%] | −12.9, −8.7, −7.6, −0.2, −3.1 | fail (point) |
| 3 | **remaining** | 11,996 | **−6.3%** | [−9.7%, −3.0%] | −14.7, −8.2, −4.7, +4.1, −1.4 | **fail** (point) |
| 3 | oracle | 4,863 | −62.0% | | | ceiling |
| 5 | precall | 14,635 | +3.8% | [+3.0%, +4.7%] | | |
| 5 | clamp | 14,102 | | | | control |
| 5 | reforecast | 12,938 | −8.3% | [−11.5%, −5.3%] | −18.2, −10.0, −4.4, −3.0, −2.6 | fail (point) |
| 5 | **remaining** | 12,662 | **−10.2%** | [−13.9%, −7.0%] | −22.8, −11.2, −6.8, −2.5, −2.5 | **fail** (point) |
| 5 | oracle | 5,273 | −62.6% | | | ceiling |

**Oracle gap.** `oracle − clamp` is −62.7%, −62.6%, −62.0%, −62.6% at
k = 1, 2, 3, 5. Watching the first five calls recovers none of the ceiling:
the two oracle columns (final call count, final largest tool input) are as
informative after five calls as before the first, because they describe how
the loop *ends*.

**Permutation drops, `remaining` arm.** k = 1: largest tool input so far
+3.3%, output so far +2.1%, any mutation +0.7%, the rest zero (`k_calls` is
constant within a k, and `k_lastOutput` equals `k_outputSoFar` at k = 1).
k = 3: largest tool input +2.5%, any mutation +1.8%, the output columns at or
below zero. The win is "a big Write or Edit has already happened", the
same half of the oracle §6.33 found, now observed instead of assumed.

**Dips, raw `remaining` p50 path (seed-averaged predictions).**

| step | steps | p50 dip rate | p50 depth median / p90 | p90 dip rate | p90 depth median / p90 |
|---|---|---|---|---|---|
| 0→1 | 1,822 | 28.3% | 15.5% / 42.1% | 43.3% | 14.7% / 43.9% |
| 1→2 | 1,646 | 29.6% | 11.6% / 33.5% | 40.9% | 10.4% / 32.0% |
| 2→3 | 1,500 | 32.2% | 12.1% / 34.9% | 40.0% | 10.4% / 29.1% |
| 3→5 | 1,259 | 28.3% | 14.0% / 35.8% | 38.0% | 10.9% / 26.9% |

The raw estimate fails the display criterion at every step (dip rate ≤ 10%
needed; observed 28–32% on p50, 38–43% on p90). `clamp` dipped on 0 of 6,227
steps (asserted).

**Ratchet** (`s_k = max(s_k, s_{k−1})` per quantile), one row per turn on
seed-averaged predictions, vs clamp: k = 1 −4.9% [−7.5%, −2.3%]; k = 2 −6.2%
[−10.6%, −2.2%]; k = 3 −7.2% [−11.9%, −2.6%]; k = 5 −11.2% [−16.3%, −6.4%].
The ratchet gives up 0.0–1.0 points against the raw path, so monotone
display costs nothing here.

### Verdict

**Not adopted for a trainer task.** The named candidate clears "whole CI
below zero" at every k and "no fold worse than +5%" at k = 2, 3, 5, but
misses the pre-registered materiality margin everywhere: −4.7% at k = 1
against −10%, −6.3% at k = 3 and −10.2% at k = 5 against −15%. Fold 4
(the same session block that hurt every probe this week) is +6.8% at k = 1.
The margin was set because the sklearn harness has overstated the rung
ladder by two to three points on both prior candidates; at that shrink the
k = 1 number, the one most turns would see, lands at one or two percent,
where prompt text and session context landed. Relaxing the gate after the
run would be moving the goalposts, so the answer stands.

What the tables do establish, and what stays true for whoever builds this
next on more users:

- **A moving turn estimate is real but small and grows with k.** The gain
  is −5% after one call and −10% after five, all on "a large mutation has
  already happened". It is not the §6.9 previous-output feature (zero
  importance here) and not loop depth (constant within k).
- **The ceiling is the loop's ending, not its beginning.** Oracle −62% at
  every k. No quantity observable in the first five calls narrows it.
  Nothing pre-call, and nothing early-in-turn, gets near it on this corpus.
- **If a moving estimate is ever shown, it must be ratcheted.** The raw
  path dips on a third of steps by 12–15% median; the ratchet is free.
  `clamp` alone (raise each quantile to what has already been spent) is a
  guaranteed, dip-free −0.6% to −3.8% over the frozen number and needs no
  model; the bar's "running long / very long" verdict already encodes it.
- **Fold spread is the sample.** −22.8% to −2.5% across blocks at k = 5 is
  the signature of a few dozen long turns deciding the number. This is the
  first probe since the text head whose direction is unambiguous, and the
  first whose value plausibly rises with more sessions, so it is the natural
  headline for a multi-user corpus ask.

Turn schema stays `portable-precall-v2`; nothing is wired. Re-forecast-as-
you-go closes as a single-user line of work here. STATE-OF-PLAY §6.34.

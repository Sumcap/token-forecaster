# Where we are & what's next

> **Verified update: 10 August 2026, night.** Whole-SESSION totals shipped
> ([§6.26](#-626-whole-session-totals--shipped-unconditional-the-kill-condition-fired)):
> `sessionTotals` profile field + `historicalSessionTotalForecast()`, session
> totals **P50 21,075 / P90 117,016 / P99 223,033** over 311 sessions. The
> pre-committed kill condition fired — no conditional forecast (turn-count
> buckets, spent-so-far buckets, turns×median) separates from the
> unconditional distribution with endpoint stability, so the unconditional
> quantiles are the whole ship. One finding for consumers: remaining output
> is roughly memoryless — do NOT subtract spent-so-far from the quantiles;
> that graded worst of everything measured. Standing gates this
> regeneration: `promptImage` −3.95 [−10.57, +0.75], `promptPath` +14.45,
> `prevOutput` −0.41 — all NOT ADOPTED, no action.
>
> **Verified update: 10 August 2026.** The missing-signals sweep
> ([§6.23](#623-the-missing-signals-sweep)) graded seven never-tested pre-call
> signals. Six are closed (slash-command turns have no support; same-tool
> streak, turn-cumulative output, and three prompt-feature rungs are zero,
> unstable, or worse). One is live: **`promptImage`** — image-bearing turns run
> ~0.89× shorter within (day, model) cells and the candidate rung is negative
> at all five corpus endpoints tested. It is wired end to end behind a
> self-enforcing gate (current endpoint: −4.19 [−10.59, +0.51], not adopted;
> it ships automatically the regeneration its CI clears). Rolling boosted
> stands at **489.2/call** vs the 506.0 base ladder on this regeneration.
>
> **Companion to [BACKLOG.md](./BACKLOG.md).** The backlog says *what we plan to
> build*. This says *what we actually know*, in plain language, and *what to do
> next*.
>
> **Verified update: 9 August 2026, afternoon. This section supersedes every
> older figure below.** The cold-start audit (see
> [§6.18–6.22](#618-the-cold-start-audit--pooled-thinking-tier-adopted)) did
> five things:
>
> 1. **The pooled `thinking=yes|no` tier is ADOPTED and shipped** — the first
>    profile change since the boosted correction, and it serves exactly the
>    caller the product now optimizes for: a model the profile has never seen
>    (`usedFallback: true`). Leave-one-model-out, the pooled thinking rung
>    beats the blended `overall` by **−43.2 pinball/call, 95% CI
>    [−65.4, −21.3]** (probe endpoint: −54.9 [−68.2, −39.9]), and the verdict
>    survives every reservation-metric variant tested in §6.20. The predictor's
>    pooled-rung order was also corrected: `thinking`-family rungs now outrank
>    the pooled `promptPath` bit (measured: thinking-first is −55.0/call
>    [−65.9, −43.6] better for fallback callers; the reorder changes **zero**
>    in-profile forecasts on the current corpus). The eval re-tests this gate
>    on every regeneration.
> 2. **`promptPath` fell out of the profile on its own gate.** After adopting
>    at −8.66 [−16.59, −2.32] in the morning regeneration, the same gate on the
>    15,374-call afternoon corpus read **+7.63 [−9.72, +25.96]** and refused
>    it. The feature is endpoint-sensitive the way `previousOutputTokens`
>    always was ([§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused));
>    the machinery will re-adopt it automatically the day it re-clears.
>    **The shipped profile today is: model, model+thinking, pooled thinking,
>    overall — 12 groups — plus the boosted correction** (rolling
>    505.0 → 485.9, diff −19.1 [−25.7, −13.6], still adopted).
> 3. **The P50/P90 over-coverage has a mechanism**: within-group workload
>    drift. The quantile estimator is unbiased in-sample (50.1/90.0/99.0);
>    the same (model, thinking) cell simply produces shorter outputs every
>    fortnight (corpus P50 510 → 429 → 345), so full-history fits overshoot
>    the present by ~25% at P50. Split-conformal recalibration on the trailing
>    train slice **refused** (some variants provably worse); exponential
>    time-decay weighting is directionally right at every half-life but never
>    separates from zero (best −1.88 [−4.91, +0.28]). [§6.19](#619-conformal--time-decay-recalibration--refused)
> 4. **The pinball target survived its audit, with one real divergence.** Both
>    standing adoptions (boosted, pooled thinking) pass under every
>    reservation-oriented metric. Recency-family candidates flip to *provably
>    worse* when overflow is priced ≥19× waste — §6.8's rejection is
>    strengthened, not weakened, by the product metric. In product terms the
>    shipped ladder overflows a p90 reservation on 7.9% of calls (promise:
>    ≤10%) and a p99 reservation on 0.9% (promise: ≤1%). [§6.20](#620-the-target-audit--pinball-vindicated-one-divergence)
> 5. **Two doors closed permanently**: the static action-type mixture (§6.12's
>    middle ground) is provably worse in every variant and *widens* the band
>    ([§6.21](#621-static-action-type-mixture--closed-permanently)); and
>    `max_tokens` cannot be tested as a signal because Claude Code transcripts
>    do not record it — zero support corpus-wide ([§6.22](#622-maxtokens-as-a-signal--unmeasurable-zero-support)).
>
> Caller-tier scoreboard (rolling-origin holdout, identical calls, base
> ladder): full-context 505.4 / tier-b `{model, thinking}` 508.5 (difference
> is noise: +3.0 [−5.3, +10.9]) / tier-a `{model}` 549.3 (+40.8 [+28.0, +52.8]
> vs tier b) / `overall`-only 568.8. **A cold caller that passes
> `thinkingEnabled` loses essentially nothing against the shipped base
> ladder**; the boosted correction (−19) is the bonus that context buys.
>
> **Verified update: 6 August 2026. This section supersedes older figures
> below.** The live corpus grew to 15,181 usable calls. Reproduction of the
> exact shipped ladder on the newest chronological 20% holdout is **678.6
> pinball/call**, not the documented ~623.7; coverage is **48.2/84.8/98.6%**.
> Five-fold rolling-origin evaluation is **671.2/call** with
> **49.5/86.9/98.6%** coverage. The drift is real and the old prose was stale.
>
> A portable quantile booster over the existing ladder has now been adopted as
> **`baseline-3-boosted/0.3.0`**. It uses only information available before the
> call: thinking configuration, prompt-path/derived intent, session position,
> parent depth, and summaries of completed calls in the exact parent chain. On
> rolling origin it scores **650.4/call** (−20.8, 3.1%, paired session-block
> 95% CI **[−30.2, −14.0]**) with **49.2/87.8/98.7%** coverage. Average
> P90−P50 width falls **1,147 → 1,109 tokens** and P99−P50 is essentially flat
> (**5,164 → 5,162** in the full probe). Every fold improves with its own CI
> below zero. This clears adoption, but not the 5% definition of a
> “breakthrough.” Missing loop context, unknown thinking, and pooled model
> fallback all skip the correction and explicitly return low confidence.
>
> The remaining ceiling is now sharply located. The worst 1% of calls carry
> **25.2%** of loss; `Write` is **2.6%** of the holdout and 17 of the 30 worst
> misses. A true future-`Write` hurdle is worth **11.1%**, true long-artifact
> regime **14.8%**, true action **18.8%**, and true long-output regime **37.0%**.
> Those are post-call oracle labels, not valid predictors. A leakage-free
> semantic Stage A reaches only **0.584 AUC** for `Write` and **0.555** for long
> artifacts; both two-stage forecasts worsen loss. A simulated caller signal
> reaches breakthrough only around **90% recall at 1% false positives**.
>
> The corpus still identifies only one local user (300 sessions; 49 holdout
> session blocks), so user-block validation is impossible. The next required
> evidence is multi-user, privacy-safe telemetry containing a pre-call
> `expectedOutputKind` intent declaration and post-call outcome label. See
> [TELEMETRY.md](./TELEMETRY.md). Exact results and rejected candidates are in
> `experiments/artifacts/breakthrough-probe.json` and
> `experiments/artifacts/winning-boost-eval.json`.
>
> **Last updated: 5 August 2026.** The 4 August stopping conclusion was partly
> wrong because the prompt ancestry join treated injected `isMeta` skill rows
> as new human turns. Those rows actually sit inside an existing turn. Making
> them transparent changed prompt coverage from **68.0% to 89.9%** and exposed
> one adoptable pre-call signal:
>
> 1. **The published ceiling was a measurement artifact and the prize is twice
>    what we said.** The oracle could not fire on `Write` at a 100-sample floor,
>    so it was scored as if it knew nothing on precisely the calls that carry the
>    loss. Corrected: **~−90 pinball/call (~17%), not −49 (~8%)**, and a *binary*
>    `Write` detector is worth **71%** of it.
>    [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact)
> 2. **Naming a file/path in the prompt does predict a heavier tail.** The
>    corrected `promptPath` ladder is **−10.9/call, CI [−21.9, −0.4]** against
>    model+thinking and is now shipped. P90 single-split coverage improves
>    **86.5% → 89.2%**. The broad programme kill condition still fires because
>    combined prompt R² is **0.244 < 0.25**; this is one narrow win, not a
>    general semantic forecaster. [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired)
>
> The predictor is now **model + thinking + one privacy-safe prompt bit**. Raw
> prompt text is still discarded; callers pass `promptMentionsPath`.
>
> Earlier on 4 August: the one adoptable win on the table was built,
> gated — and **refused by its own test**. Chasing *why* it read −3.8 one hour and
> −1.8 the next turned up the real problem: **the adoption statistic was broken**,
> not the feature. The 5-fold paired t has been replaced by a block bootstrap over
> per-call losses, applied to every comparison in the eval
> ([§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused),
> [house rules 1, 2, 10, 11](#8--house-rules-earned-not-assumed)).
>
> Previously updated 3 August 2026, after a three-part attack on the forecast
> **band width**.
>
> Reorganised on the same date: this document used to be a chronological log of
> what shipped when. It is now organised by *what we know*, with the history
> compressed into [§6, the ledger](#6-the-ledger-everything-weve-tested).

---

## 🎯 TL;DR

| Question | Answer |
|---|---|
| Does the learned predictor beat the static one? | **Yes — 32% less error.** Current single split: 624 vs 920 total pinball on 3,019 later calls. |
| Is it a *good* predictor yet? | **Useful, not exact.** It is a 24-row lookup table that reads one derived prompt bit, not prompt semantics. |
| Is it *calibrated*? | 🟢 **Nearly.** Single split: P50 48.8%, P90 89.2%, P99 98.9%. [§4](#-results) |
| So what *is* the problem? | The **band**. `opus-4-8` + thinking spans P50=705 → P99=10,555, a **15× range**. |
| Where does the error actually live? | ⚠️ **Not where the band is widest.** After the fix, P99 is **12%** of the loss and **1% of calls carry 23% of it.** [§5](#5-where-the-error-actually-lives) |
| What are those calls? | Mostly **`Write`** — 3% of traffic, **9.8×** over-represented among the worst misses. [§5](#5-where-the-error-actually-lives) |
| How big is the remaining prize? | 🔧 **Twice what we said.** An oracle told the true tool is worth **~−90/call (~17%)**, not −49 (~8%) — the old figure was a sample-floor artifact that switched the oracle off on `Write`. [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact) |
| Does the **prompt** predict output length? | 🟡 **One bit does.** Naming a path is **−10.9/call, CI [−21.9, −0.4]** and ships; all other bag-of-features still fail. Broad R² is 0.244 vs 0.25. [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired) |
| So is it over? | ✅ **The broad feature search is.** The discovered path bit is shipped; semantic prediction and `Write` detection remain unresolved. [§7.6](#-76-the-honest-stopping-point) |
| Did re-forecasting each agent-loop step help? | ❌ **The mechanism failed.** Previous *action* is worth −0.4 ± 3.7. The gain does **not** compound with loop depth. [§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected) |
| Did *anything* narrow the band? | ✅ **The path bit improves the tail.** Previous-output size is still refused on top of it: **−0.65/call, CI [−1.97, +0.02]**. [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused) |
| How do we decide if a change is real? | 🔧 **This changed on 4 Aug.** Paired **block bootstrap over per-call losses**, resampled in session blocks; adopt only if the 95% CI is entirely below zero. The old 5-fold t adopted and refused the same effect 20 min apart. [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused) |
| Do we have a P99 with an error bar? | ✅ **Yes, new.** A generalized-Pareto tail fit, stable across every threshold. [§4.3](#43-the-tail-what-the-p99-is-really-worth) |
| Can we predict cap risk yet? | ❌ **No, and the shortcut is now closed.** Extrapolation was tested and rejected 3/28. [§6.10](#610-fitting-the-tail--half-confirmed-half-rejected) |

**Pick your depth:**
- ⏱️ **30 seconds** → the table above, then [§7 What to do next](#7-what-to-do-next)
- ☕ **5 minutes** → §3 (what ships), §5 (where the error is), §7 (next)
- 🧠 **30 minutes** → all of it, then [§6 the ledger](#6-the-ledger-everything-weve-tested)

---

## 1. What are we even trying to do? (ELI5)

You're about to send a message to Claude. Two numbers matter:

| | Question | Is it hard? |
|---|---|---|
| **Input tokens** | How big is the thing I'm *sending*? | 😌 **Easy.** Anthropic has an endpoint that counts it. Solved. |
| **Output tokens** | How big will the thing coming *back* be? | 😰 **Hard.** Hasn't happened yet. |

This project is about the second one.

**The pizza analogy 🍕**

You order a pizza. "When will it arrive?"

- ❌ Bad answer: *"7:43pm."* — You can't know that. You'll be wrong.
- ✅ Good answer: *"Usually 25 min. Rarely more than 45. Almost never more than 90."*

That's what we build. Not one number — **three numbers that describe a range**:

$$P_{50} = \text{"half the time it's under this"}$$
$$P_{90} = \text{"9 times out of 10 it's under this"}$$
$$P_{99} = \text{"99 times out of 100 it's under this"}$$

**Why anyone cares:** if you're going to send a 900,000-token conversation to a
model with a 1,000,000-token window, you need to know how much room to leave for
the reply. Leave too little → it gets cut off. Leave too much → you waste context
you could have used.

---

## 2. How do you grade a guess like this? (the math, gently)

Two scores. You need both.

### 📏 Score 1: Coverage — "did you keep your promise?"

A $P_{90}$ forecast makes a promise: *"90% of replies will be under this number."*
So go check:

$$\text{coverage} = \frac{\#\{\text{replies} \le \text{forecast}\}}{\#\text{replies}}$$

- Got 90%? ✅ Perfect.
- Got 98%? ⚠️ You were too cautious. Safe, but you wasted room.
- Got 70%? 🚨 You lied. Things got cut off.

### 📏 Score 2: Pinball loss — "how tight was it?"

**Why coverage alone isn't enough:** I can get perfect $P_{90}$ coverage by
predicting *one billion tokens*. Technically 90%+ of replies are under a billion!
But that forecast is useless.

So we need a score that punishes being lazily huge. That's **pinball loss**
(lower = better):

$$L_p(y, \hat{q}) = \begin{cases} p \cdot (y - \hat{q}) & \text{if } y \ge \hat{q} \quad \text{(you guessed too low)} \\[4pt] (1-p) \cdot (\hat{q} - y) & \text{if } y < \hat{q} \quad \text{(you guessed too high)} \end{cases}$$

**ELI5:** it's a fine for being wrong, but the fine is **lopsided on purpose**.
For $P_{90}$ (so $p = 0.9$):

- Guessed too low → fined **0.9× the gap** 😬 (expensive — this is the dangerous mistake)
- Guessed too high → fined **0.1× the gap** 🙂 (cheap — just wasteful)

That lopsidedness is what makes the score's best possible answer be *exactly the
90th percentile*. Neat trick.

> 💡 **The one thing to remember:** coverage = "did you keep your promise",
> pinball = "were you tight about it". A good forecast wins on both.

### 📏 And the thing we're now optimising: band width

Coverage is solved. **Band width — $P_{99} - P_{50}$ — is not**, and it is what a
caller feels. A P90 of 833 and a P99 of 10,555 are both "correct" and wildly
different instructions about how much context to reserve.

⚠️ **Band width and pinball are not the same objective**, and [§5](#5-where-the-error-actually-lives)
is the discovery that they point in different directions. Be explicit about which
one you are chasing.

---

## 3. What ships today

### 🪜 The predictor: a backoff ladder over lookup tables

Read every Claude Code transcript on disk. Every assistant reply records its true
`output_tokens`. Sort them, read the percentiles off the pile, ship those
numbers — sliced by **model**, **whether extended thinking was on**, and whether
the human turn-root prompt **names a file or repository path**:

```
try:  this model + thinking on/off + promptPath yes/no
else: promptPath yes/no                 ← sparse-model backoff
else: this model + thinking on/off      ← prompt unavailable
else: this model
else: all models combined
else: the static guess (1,000 / 4,000 / 12,000)
```

No machine learning. Just *"look at what actually happened"*, conditioned on
three things known before the call. Prompt text is reduced to one boolean and
discarded.

📁 `packages/predictor/src/bundled-profile.ts` — generated, don't hand-edit.

### 📋 What it actually returns, per request

*Regenerated 5 August 2026 from 15,095 calls, zero censored. The table below
shows the base rows used when the prompt-path bit is unavailable.*

| Request you send | n | **P50** | **P90** | **P99** | note |
|---|---|---|---|---|---|
| *(nothing matched)* → `overall` | 15,095 | 430 | 1,926 | 6,842 | — |
| `model=claude-fable-5` | 7,167 | 430 | 1,998 | 6,838 | — |
| `model=claude-opus-4-8` | 3,862 | 487 | 2,209 | 8,487 | — |
| `model=claude-opus-5` | 4,017 | 387 | 1,601 | 5,428 | — |
| `claude-fable-5` + thinking **off** | 2,836 | **204** | 838 | 2,957 | — |
| `claude-fable-5` + thinking **on** | 4,331 | **665** | 2,638 | 7,961 | — |
| `claude-opus-4-8` + thinking **off** | 1,388 | **255** | 833 | 2,345 | — |
| `claude-opus-4-8` + thinking **on** | 2,474 | **709** | 2,930 | **10,581** | — |
| `claude-opus-5` + thinking **off** | 2,074 | **256** | 1,025 | 3,030 | — |
| `claude-opus-5` + thinking **on** | 1,943 | **551** | 2,187 | 8,017 | — |

The 14 prompt-path rows are where the new accuracy comes from. The clearest
example is Opus 5: with thinking off, path/no-path P99 is **4,862 vs 2,410**;
with thinking on it is **14,451 vs 6,419**. Those are still distributions, not
guarantees about an individual call.

**How to read the table.** Pick your model and thinking setting, take the P90 for
a typical safe reservation, the P99 if truncation would be expensive.

### 🤝 The integration contract — four things a caller must know

**1. Pass `thinkingEnabled` explicitly.** It moves the P50 by ~3× and the P99 by
~3–4×. It is by far the most useful thing you can tell the predictor.

**2. Omitting it means *unknown*, not *off*.** This is deliberate and it is the
safe direction:

```ts
// what the code used to do — WRONG
thinking: request.thinkingEnabled === true ? "yes" : "no"
```

That silently turned "caller didn't say" into "thinking is off", and the
no-thinking bucket has about **a third** of the P99 of the thinking bucket. An
unspecified request would have been under-forecast by ~3× at the tail. Now an
omitted flag skips every thinking rung and falls back to the model-only group:

| Request | Selected group | P50 | P99 |
|---|---|---|---|
| `{model: opus-5}` | `model=claude-opus-5` | 383 | 5,409 |
| `{model: opus-5, thinkingEnabled: true}` | `model=claude-opus-5\|thinking=yes` | 546 | 8,000 |
| `{model: opus-5, thinkingEnabled: false}` | `model=claude-opus-5\|thinking=no` | 251 | 3,119 |

Leaving it out is *safe* but you lose the entire gain.

**3. Pass `promptMentionsPath` when the turn-root prompt is available.** Use the
exported `promptMentionsPath(prompt)` helper; omitted means unknown, not false.
Raw prompt text is not retained.

**4. Branch on `calibration.usedFallback`.** It's true when the forecast came
from `overall` (a blend of *other* models) or the static baseline. There is no
silent degradation path — but you have to look.

### ⚖️ What it is and isn't

> The shipped predictor is a **lookup table with 24 rows**. It reads one derived
> prompt bit — whether a path was named — but it does not understand prompt
> semantics. Requests with the same model, thinking setting, and path bit get
> the same three numbers.

It's not really *predicting*; it's reciting the average of a bucket. That is
still genuinely useful — reserving 972 tokens instead of 4,000 (opus-5, thinking
off, P90) frees real context, and it is honest about its uncertainty. But calling
it a forecaster oversells it.

Two things it deliberately does **not** return:

- **`probabilityOfOutputCap`** — you cannot invent cap risk from three quantiles,
  and we have **zero** censored calls to fit it on. See [§6.10](#610-fitting-the-tail--half-confirmed-half-rejected).
- **A session total.** The profile forecasts *output tokens per API call*, not a
  whole agent task. Budgeting a session needs $\sum_{i=1}^{N} Y_i$ with $N$ itself
  random, which is a harder and separate problem.

---

## 4. Does it work, and what drives it?

### 🧪 How we test it — the honest way

The cheating way is to fit on all the data and test on the same data. Instead we
split **by time**, so the predictor never sees the future, and we do it **five
times over**, walking the cut-off forward:

```
fold 1: [train              ][test]
fold 2: [train                    ][test]
fold 3: [train                          ][test]
fold 4: [train                                ][test]
fold 5: [train                                      ][test]
```

**Why five and not one.** A single 80/20 cut gives one number per predictor. The
differences we were reading off it were ±1–2%, and folds vary from each other by
**±187 total pinball**. One split could not tell a real 2% gain from which
fortnight it happened to land on.

### 📊 Results

*15,095 calls, zero censored. Single split: 12,076 train / 3,019 holdout. CV: 5
folds, 603–607 calls each. "Total" is the three quantile losses summed — one
number to rank predictors by. Lower is better.*

**Rolling-origin CV, 5 folds** — the numbers to actually trust:

| Predictor | Mean total | Spread (σ) | Range across folds |
|---|---|---|---|
| 🪨 Static guess | 920 | ±60 | 858 – 995 |
| 📚 Learned, one global profile | 676 | ±110 | 555 – 804 |
| 🪜 Learned, per model | 678 | ±126 | 537 – 815 |
| Learned, + input size | 673 | ±123 | 539 – 805 |
| Learned, + input + subagent | 675 | ±126 | 536 – 808 |
| 🧠 Learned, + thinking | 633 | ±137 | 482 – 778 |
| 📁 **+ prompt path ← *shipped*** | **622** | **±137** | **465 – 766** |
| Learned, + thinking + input size | 623 | ±129 | 490 – 758 |

**Single 80/20 split** — kept because it's what every earlier result here was
reported against:

| Predictor | P50 | P90 | P99 | **Total** | vs static |
|---|---|---|---|---|---|
| 🪨 Static guess | 404 | 394 | 122 | 920 | — |
| 📚 Learned, one global profile | 293 | 289 | 94 | 676 | −27% |
| 🪜 Learned, per model | 293 | 295 | 93 | 680 | −26% |
| 🧠 Learned, + thinking | 280 | 271 | 84 | 635 | −31% |
| 📁 **+ prompt path ← *shipped*** | **279** | **266** | **79** | **624** | **−32%** |

**Coverage** — how close each forecast is to the promise it makes:

| Predictor | P50 (want 50%) | P90 (want 90%) | P99 (want 99%) |
|---|---|---|---|
| 🪨 Static | 79.4% 🚨 | 97.1% ⚠️ | 99.8% ✅ |
| 🪜 Per model | 48.7% ✅ | 87.1% ⚠️ | 98.8% ✅ |
| 🧠 Per model + thinking | 47.1% ⚠️ | 86.5% ⚠️ | 98.6% ✅ |
| 📁 **+ prompt path** | **48.8%** ✅ | **89.2%** ✅ | **98.9%** ✅ |

The path bit repairs most of the P90 drift on the single chronological split:
**86.5% → 89.2%**. Rolling-fold mean coverage is still lower at 87.1%, so drift
monitoring and conformal calibration remain live work; this is not permission
to claim perfect calibration for every future user or workload.

### 🔍 What jumps out

**1. The static P50 was never a median.** It sat above **80%** of calls. It was
secretly a P80 — not "the typical reply" but "a pretty big reply".

**2. Nearly all the gain came from just looking at the data.** static → one
global learned profile is −27%. Everything since has been worth about 5 points
more. **The cheap move captured almost everything.**

**3. 🚨 Read the ranking, not the decimals.** The fold spread (±187) is now
**four times** the entire gap between the global profile and what ships
(660 → 617 = 43):

| Comparison | Gap | Verdict |
|---|---|---|
| static → **+ thinking** | 292 | 🟢 **Real.** Wins in every fold. |
| per model → **+ thinking** | 43 | 🟢 **Real.** Wins in every fold. |
| global → per model | 0 | 🟡 Now exactly zero to the nearest point. |
| + thinking → **+ thinking + input size** | **11** (better) | 🔴 **Noise** — it was 1 *worse* two regenerations ago, and has lost six straight paired tests. Stays out. |

> ⚠️ **Flag, this regeneration:** *global → per model* no longer keeps its
> direction in every fold. On the current corpus per-model wins folds 1–3 and
> **loses folds 4 and 5** (paired −3.0 ± 10.9, t = −0.3). The verdict above is
> left as written — it was never a shipping claim, and per-model stays for the
> reason [§6.2](#6-the-ledger-everything-weve-tested) gives — but "consistent in
> direction" is now 3/5, not 5/5.

Anything under ~±30 is unmeasurable on this corpus unless you **pair the per-call
series and block-bootstrap it**. Pairing across 5 fold totals is not enough — it
is what made a −16 look believable in [§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected)
and then unmade it ([§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused)).

**4. ⚠️ The workload drifts, hard.** The best fold scores 443 and the worst 923
for the *same* predictor — a **2.1× swing** driven purely by which fortnight you
grade against. Much of the leftover error is drift, not model error. The corpus
is also **live**: it grows every time anyone works in this repo, so numbers
regenerated a day apart will differ slightly.

**5. ⚠️ The recent workload doesn't use most of the profile.** Of the 10 shipped
groups, the held-out period exercises **four**. `claude-opus-4-8` has essentially
vanished from recent traffic, so its three rows — including the widest band in
[§3's table](#-what-it-actually-returns-per-request) — are calibrated on history
nobody is generating any more.

---

### 📐 The effect ladder: what actually moves output length

Largest first. This is the map of what moves output length, and — just as
important — what you're *allowed* to use.

| Feature | Effect on median | Knowable pre-call? | Status |
|---|---|---|---|
| 🔧 **Which tool the turn calls** | **15.2×** | ❌ No | ⚠️ **Biggest effect in the corpus.** Worth **~−90 pinball/call (~17%)** against what ships — *corrected upward from −49 on 4 Aug*, see [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact) |
| 🧠 **Thinking on/off** | **2.8×** | ✅ Yes | ✅ **Shipped** — worth −8% |
| How the turn ends (`stop_reason`) | 2.0× | ❌ No | ❌ Unusable |
| **Previous call's output size** | 1.4× *(and 2.5× at P99)* | ✅ Yes | ❌ **Built and gated off.** −16.4 ± 4.4 on 3 Aug, **−7.2 ± 4.1 on 4 Aug** — [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused) |
| Which model | 1.35× | ✅ Yes | ✅ Shipped |
| Input size | ~1.3× (and it *hurts*) | ✅ Yes | 🗑️ Deleted from the ladder |
| Subagent or not | 1.2× | ✅ Yes | ❌ No measurable gain |
| Tools available | ~1.0× (constant) | ✅ Yes | 🗑️ Deleted from the ladder |
| `effort` (`low`…`max`) | 4.6× *apparent*, ~0 real | ✅ Yes | ❌ Rejected — a (day, model) artifact |
| Loop depth, previous action, previous `stop_reason`, tool-result size, tool duration | — | ✅ Yes | ❌ **All rejected** — [§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected) |

### 4.1 Thinking is the one that paid

**Extended-thinking tokens are billed as output tokens.** So a request with
thinking on produces more output *mechanically*, not statistically. Nobody had
checked; the eval script parsed the thinking blocks and threw them away.

| Segment | n | P50 | P90 | P99 |
|---|---|---|---|---|
| 🧠 thinking on | 8,461 | **645** | 2,637 | **9,147** |
| 😴 thinking off | 5,956 | **228** | 883 | **2,939** |

2.8× at the median, 3.1× at the P99, −8% error. Shipped.

> 📉 **How we detect it, and the limit.** Transcripts record the blocks the model
> *emitted*, not the request's configuration, so we infer: *thinking block present
> ⟹ thinking was enabled*. That implication is sound; the reverse is not. A
> thinking-enabled call that emits no thinking block gets labelled `no`. **The
> error rate is measured at 5.9%** — genuinely slight. Replace the inference with
> the recorded request config when Phase 3 telemetry lands; it buys a rounding
> error.

### 4.2 Action type: the big one we can't use

Grouping by the first tool the turn calls:

| first tool | n | P50 | P90 | P99 |
|---|---|---|---|---|
| `Bash` | 7,526 | 378 | 1,461 | 4,308 |
| `Edit` | 2,639 | 630 | 2,106 | 5,839 |
| `Read` | 2,026 | **183** | 1,118 | 4,337 |
| **`Write`** | 469 | **2,773** | 10,050 | **24,246** |
| `ToolSearch` | 102 | 475 | 1,770 | 5,395 |
| *(no tool)* | 1,009 | 827 | 2,454 | 6,325 |

**15.2× at the median.** It survives every gate that killed `effort`: all classes
appear on 26–28 days and in 44–61 (day, model) cells, within-cell ratios are
near-identical to naive ones (`Write` 7.40× vs 7.34×), and direction is consistent
in **19/19** cells for `Write`.

**What it's worth: about −90 pinball/call, or ~17% of shipped loss.** That
figure replaces the **−49 / ~8%** this section published until 4 August, which
was a **measurement artifact**. The correction is [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact)
and it re-prices [§7.2](#-72-build-a-write-detector--priced-then-starved-of-inputs).

> ⚠️ **Two older numbers are still quoted elsewhere and both are wrong.**
> [GENERATIVE-MODEL.md §4](./GENERATIVE-MODEL.md#4-action-type-is-a-12-signal--backlog-8-is-underestimated-by-6)
> priced this at **−92 (−15%)** against the *marginal* — a forecast with no
> features at all — which is the wrong baseline. This document then priced it at
> **−49** against the shipped predictor, which is the right baseline measured
> with the oracle switched off on two thirds of the calls that matter. **Quote
> −90 (median across corpus endpoints, range −51 to −126).**

### 4.2a The −49 ceiling was a sample-floor artifact

*`node experiments/evaluation/probe-loop-depth.mjs` (section E),
`node experiments/evaluation/probe-oracle-endpoints.mjs`*

The oracle was one **joint** rung, `m=<model>|t=<thinking>|action=<tool>`, fitted
only where a group cleared the repo's 100-sample floor. `Write` is ~3% of the
corpus, so per fold **exactly one of six (model, thinking) cells clears 100 for
`Write`** — and it is `claude-fable-5|t=yes`, the model
[§4.5](#-what-jumps-out) notes has left recent traffic:

| `Write` training samples, final fold | n | |
|---|---|---|
| `claude-fable-5 \| t=yes` | 172 | ✅ clears |
| `claude-opus-4-8 \| t=yes` | 94 | ❌ |
| `claude-fable-5 \| t=no` | 62 | ❌ |
| `claude-opus-5 \| t=yes` | 56 | ❌ |
| `claude-opus-5 \| t=no` | 43 | ❌ |
| `claude-opus-4-8 \| t=no` | 41 | ❌ |
| **pooled across cells** | **468** | ✅ comfortably |

So the "oracle" **could not fire on an opus-5 `Write`**. It fell straight back to
the shipped predictor on exactly the class [§5.3](#53-those-calls-have-a-name-and-it-is-write)
identifies as the whole prize, and then reported what the incumbent scored as if
that were the ceiling.

**The fix is one line: a pooled `action=<tool>` rung below the joint one**, still
at ≥100 samples. Nothing is loosened — the pooled group has 465 samples where the
joint groups have 43.

| oracle construction | vs shipped | 95% CI | informed on `Write` |
|---|---|---|---|
| joint rung only *(what we published)* | −46.3 | [−61.7, −32.2] | **31.8%** |
| **+ pooled rung** | **−123.1** | [−179.8, −73.8] | **100%** |
| binary "is this a `Write`?" | −78.7 | [−131.5, −33.9] | **100%** |

Graded with the [block bootstrap](#8--house-rules-earned-not-assumed), not the
5-fold t. All three CIs are clear of zero.

**The `informed on Write` column is the whole finding**, and it replicates
without exception: across **12 corpus endpoints** spanning 11,520 → 14,768 calls,
the joint-only oracle is informed on **23–43% (median 32%)** of held-out `Write`
calls, and the pooled oracle on **100% at all 12**.

> ✅ **What replicates, and what does not.** The pre-committed falsification was
> "re-run at a second endpoint; if −121 doesn't reproduce, revert". Run at twelve:
>
> | | median | range | replicated at |
> |---|---|---|---|
> | joint only | −51.5 | −108.1 … −44.0 | — |
> | **+ pooled** | **−89.8** | −125.5 … −50.6 | — |
> | binary `Write` | −65.7 | −122.7 … −34.8 | — |
> | *pooled beats joint* | — | — | **10/12** (the other 2 are ties within 1.3/call) |
> | *CI clear of zero* | — | — | **12/12** for all three |
>
> **The point estimate −121 does not reproduce; the correction does.** −121 is a
> recent-endpoint reading, not a constant. Report the ceiling as **~−90, range
> −50 to −126 (11–20% of shipped loss)**.
>
> **§7.2 is not reverted to −49, because −49 is refuted by the same evidence.**
> Joint-only is not a stable estimate either: it drifts **−108 → −44** as the
> corpus grows, because the one cell that clears the floor for `Write` is a model
> leaving the workload, so the rung fires informatively on fewer and fewer of the
> calls being scored. **−49 is the most recent and most suppressed reading of a
> sliding number**, not a measurement to fall back to.

**And it is not its own threshold artifact.** Refit at three sample floors — only
the fitting floor moves, the 7-way action alphabet is held fixed:

| minGroup | joint only | + pooled |
|---|---|---|
| 25 | −116.7 | −116.5 |
| 50 | −67.2 | −123.9 |
| 100 | −46.3 | −123.1 |

**At a floor of 25 the joint rung recovers the pooled answer.** That is precisely
what "the 100-floor was suppressing the joint rung" predicts, and it is the
cleanest single line of evidence here: the pooled construction is stable across
the floor, the joint one is not.

**What it changes.** The remaining prize is **~17% of shipped loss, not ~8%** —
and a **binary** `Write` detector is worth **71% of it** (median across the 12
endpoints; 62–98%). That makes [§7.2](#-72-build-a-write-detector--priced-then-starved-of-inputs)'s previously
unmeasured claim correct.

**What we can capture: ~2%.** A multinomial classifier on strictly pre-call
features reaches 58.7% accuracy vs a 47.3% majority baseline — statistically
real as a *classifier*, operationally negligible as a *forecast*. **The
bottleneck is $\pi_k(x)$, the classifier, not the component distributions.**

### 4.3 The tail: what the P99 is really worth

Output length is heavy-tailed. The Hill estimator drifts with no plateau, which
is why "α ≈ 2" was only ever a shape claim:

| k | y₍ₖ₎ | α̂ |
|---|---|---|
| 50 | 11,611 | 2.75 |
| 100 | 8,354 | 2.33 |
| 500 | 3,786 | 2.08 |
| 1,000 | 2,521 | 1.88 |
| 2,000 | 1,531 | 1.60 |

**But the generalized-Pareto shape parameter, refitted at every threshold, does
not drift at all:**

| threshold | u | n > u | ξ (shape) | se(ξ) | implied P99 |
|---|---|---|---|---|---|
| P75 | 922 | 3,603 | 0.412 | ±0.024 | 7,051 |
| P80 | 1,116 | 2,882 | 0.374 | ±0.026 | 6,984 |
| P85 | 1,444 | 2,162 | 0.382 | ±0.030 | 6,987 |
| P90 | 1,948 | 1,441 | 0.359 | ±0.036 | 6,995 |
| P95 | 3,043 | 721 | 0.355 | ±0.052 | 7,006 |
| P97 | 4,081 | 433 | 0.357 | ±0.071 | 7,004 |

The implied P99 moves **1.0% across a 4.4× range of thresholds**. That is a
stable fit, and it is where the P99 ± SE column in [§3](#-what-it-actually-returns-per-request)
comes from. Delta-method and seeded-bootstrap standard errors agree to within a
few percent — worth something, given a 140-point tail.

> 🔧 **This corrects a claim you may have read.** [GENERATIVE-MODEL.md §5](./GENERATIVE-MODEL.md#5-the-tail-is-power-law--which-is-why-experiment-a-failed)
> reads α < 2 off the Hill estimator at large *k* and concludes **infinite
> variance**, recommending a codebase audit of anything built on means of $Y$.
> The GPD fit says **ξ ≈ 0.37, so α ≈ 2.7**, and a GPD has finite variance
> whenever ξ < ½ (our tightest CI is 0.32–0.43). The Hill drift toward 1.88 is
> **Hill-estimator bias from including non-tail data at large *k***, not evidence
> about α. **The variance is finite. No audit needed.** The heavy-tail *shape*
> conclusion stands.

---

## 5. Where the error actually lives

*This section changed the plan. Read it before adding any feature.*

Decompose the held-out pinball the shipped predictor already pays — by quantile
level, by group, and by individual call.

### 5.1 The P99 is the widest part of the band and the smallest part of the error

| level | mean loss/call | **share of total** | coverage | target | loss paid on *over*-forecasts |
|---|---|---|---|---|---|
| P50 | 278.9 | **44.9%** | 48.3% | 50% ✅ | 15.3% |
| P90 | 268.0 | **43.1%** | 87.1% | 90% ⚠️ | 35.7% |
| P99 | 74.8 | **12.0%** | 98.8% | 99% ✅ | 64.3% |

**88% of the error is at P50 and P90.** Chasing the P99 — where the 15× band
comes from — is chasing an eighth of the problem. And **85% of the P50 loss is
paid on calls the forecast came in *under***: the median isn't too wide, it's too
low on the calls that matter.

### 5.2 The loss is not a fog. It is 30 calls.

| worst … of held-out calls | carry … of all pinball |
|---|---|
| **1%** (30 calls) | **22.8%** |
| **5%** (151 calls) | **46.1%** |
| 10% (302 calls) | 57.1% |
| 50% | 86.6% |

Nearly a quarter of everything we get wrong is **30 calls out of 3,019**. That is a
different problem from "the forecast is vague", and it wants a different fix.

### 5.3 Those calls have a name, and it is `Write`

Composition of the worst 5%, against their share of the holdout:

| first tool | share of holdout | share of worst 5% | **lift** |
|---|---|---|---|
| **`Write`** | 3.1% | 30.5% | **9.8×** |
| `Edit` | 29.6% | 28.5% | 1.0× |
| `Read` | 14.4% | 5.3% | 0.4× |
| `Bash` | 46.2% | 23.2% | 0.5× |

| | share of holdout | share of worst 5% | lift |
|---|---|---|---|
| thinking **on** | 48.1% | 70.9% | 1.5× |
| **loop depth 6+** | 78.1% | 72.2% | **0.9×** |

`Write` is 3% of calls and nearly a third of the disaster cases. **Loop depth has
a lift of 0.9** — not over-represented at all, which is
[§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected)'s conclusion arriving
from a completely different direction.

### 5.4 The worst-miss table — individual calls, not aggregates

| # | model | thinking | first tool | depth | **actual** | P50 | P90 | P99 | pinball |
|---|---|---|---|---|---|---|---|---|---|
| 1 | opus-5 | **no** | `Write` | 3 | **22,551** | 374 | 1,366 | 4,264 | 48,259 |
| 2 | opus-5 | yes | `Write` | 11 | **23,239** | 559 | 2,030 | 6,469 | 47,030 |
| 3 | fable-5 | yes | `Write` | 9 | **12,761** | 680 | 2,448 | 6,438 | 21,582 |
| 4 | opus-5 | yes | `Write` | 64 | **15,045** | 481 | 1,474 | **14,701** | 19,836 |
| 5 | opus-5 | yes | *(no tool)* | 23 | **14,713** | 565 | 2,561 | **14,392** | 18,329 |
| 6 | opus-5 | yes | `Write` | 72 | **14,346** | 584 | 2,886 | **14,618** | 17,198 |
| 13 | fable-5 | yes | `Edit` | 8 | **11,416** | 660 | 3,577 | 11,950 | 12,438 |
| 16 | opus-5 | **no** | `Write` | 63 | **6,231** | 225 | 839 | 2,566 | 11,484 |

The top 25 are **0.8% of the holdout and 20.9% of all pinball paid**. Note the
depth column in the examples: 3, 11, 9, 64, 23, 72, 8, 63. There is no useful
monotonic pattern there, and that is the point.

**By group**, the same loss concentrated differently:

| group | n | **share of total loss** | mean/call | driver |
|---|---|---|---|---|
| `opus-5 \| thinking=yes` | 907 | **44.2%** | 915 | P50 |
| `opus-5 \| thinking=no` | 1,135 | 24.9% | 411 | P50 |
| `fable-5 \| thinking=yes` | 517 | 23.5% | 854 | P50 |
| `fable-5 \| thinking=no` | 415 | 6.0% | 270 | P90 |
| pooled sparse-model fallback | 45 | 1.4% | 598 | P90 |

**What would fix them:** an oracle told the true tool pays **4,376/call** on the
worst 5% against the shipped predictor's **5,730** — **23.6% less**. The ceiling
is not spread evenly; it is concentrated on exactly these calls. *(That 23.6% is
measured with the **joint-only** oracle, so like every other pre-4-August oracle
figure it is a floor — see [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact).)*

> 🧭 **What this changes about the goal.** "Narrow the band" and "reduce the
> error" are *different objectives*. The band is widest at P99, which costs 14%.
> The error is at P50/P90 on a tiny, identifiable set of calls that are mostly
> `Write`. **A `Write` detector — even a mediocre one — is worth more than any
> amount of tail modelling.**

---

## 6. The ledger: everything we've tested

Every experiment run against this corpus, with its verdict. Shipped things are
described once; rejections keep their reasoning so nobody re-runs them.

| # | Experiment | Verdict |
|---|---|---|
| 6.1 | Learn quantiles from history at all | ✅ **Shipped** — −29% |
| 6.2 | Slice by model | ✅ **Shipped** — −1% more |
| 6.3 | Slice by `thinking` | ✅ **Shipped** — −8% more |
| 6.4 | Rolling-origin CV instead of one split | ✅ **Shipped** (methodology) |
| 6.5 | `tools` as a dimension | 🗑️ **Deleted** — degenerate constant |
| 6.6 | `input size` as a dimension | 🗑️ **Deleted** — five tests, never helped |
| 6.7 | `effort` as a dimension | ❌ **Rejected** — (day, model) artifact |
| 6.8 | A recency window | ❌ **Rejected** — no window beats full history |
| 6.9 | Re-forecasting by loop depth | ⚖️ **Mechanism rejected**, one feature survived |
| 6.10 | Fitting the tail (GPD / POT) | ⚖️ **Half confirmed, half rejected** |
| 6.11 | Log-normal quantiles instead of empirical | ❌ **Rejected** — tie, and unsafe at the tail |
| 6.12 | The action-type mixture | ❌ **Not shipped** — classifier captures ~2% |
| 6.13 | The loader bug (one JSONL row per content block) | 🐛 **Methodology note** — two probe findings withdrawn; the shipped eval was never affected |
| 6.14 | `previousOutputTokens` as a shipped dimension | ❌ **Built, then refused by its own gate** — [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused) |
| 6.15 | The oracle ceiling itself | 🐛 **Measurement artifact — corrected upward** to ~−90 (~17%), was −49 (~8%). [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact) |
| 6.16 | **Turn-root prompt features** *(the actual hypothesis)* | 🟡 **One adopted, broad kill still fired — and see the 9 Aug flag.** `promptPath` −10.9, CI [−21.9, −0.4] when adopted; **refused (+7.63, CI [−9.7, +26.0]) at the 15,374-call endpoint** and currently out of the profile. [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired) |
| 6.17 | `isMeta` prompt ancestry | 🐛 **Fixed.** Skill injections are passthrough rows, not human turn boundaries; prompt coverage 68.0% → 89.9%. |
| 6.18 | **Cold-start audit + pooled `thinking` tier** | ✅ **Adopted, shipped 9 Aug.** LOMO −43.2/call [−65.4, −21.3] for unknown-model callers; pooled-rung order corrected. [§6.18](#618-the-cold-start-audit--pooled-thinking-tier-adopted) |
| 6.19 | Conformal / time-decay recalibration | ❌ **Refused.** Drift mechanism identified; no cold recalibration layer clears the gate. [§6.19](#619-conformal--time-decay-recalibration--refused) |
| 6.20 | The pinball target itself | ✅ **Vindicated, one divergence.** Adoptions metric-robust; recency candidates worse under overflow-heavy pricing. [§6.20](#620-the-target-audit--pinball-vindicated-one-divergence) |
| 6.21 | Static action-type mixture (§6.12 middle ground) | ❌ **Closed permanently.** Every variant provably worse; band widens. [§6.21](#621-static-action-type-mixture--closed-permanently) |
| 6.22 | `maxTokens` as a conditioning signal | ⚫ **Unmeasurable.** Transcripts never record it; zero support corpus-wide. [§6.22](#622-maxtokens-as-a-signal--unmeasurable-zero-support) |
| 6.23 | **The missing-signals sweep** (command, image, artifact-rung, deliverable-rung, expansive-rung, same-tool streak, turn-cumulative output) | 🟡 **One live candidate, six closed.** `promptImage` is negative at all 5 endpoints tested (−1.4 … −5.8/call), gate-clear at 2, and is now wired with a self-enforcing gate exactly like `prevOutput`; the other six are closed. [§6.23](#623-the-missing-signals-sweep) |
| 6.24 | Boost capacity sweep | ✅ **Adopted.** depth 3 / 48 iters / lr 0.08; rolling boosted −23.8 [−32.4, −15.9] vs base. Capacity exhausted at this corpus size. [§6.24](#-624-boost-capacity-sweep--adopted) |
| 6.25 | Whole-turn totals | ✅ **Shipped, coarse on purpose.** `turnTotals` profile field + `historicalTurnTotalForecast()`; every finer rung failed endpoint stability. [§6.25](#-625-whole-turn-totals--shipped-coarse-on-purpose) |
| 6.26 | **Whole-session totals** | ✅ **Shipped unconditional — the kill condition fired.** No conditional forecast (k buckets, spent buckets, turns×median) separates from the unconditional distribution at any of 4 endpoints; `sessionTotals` + `historicalSessionTotalForecast()` ship the quantiles only. Consumers must NOT subtract spent-so-far — measured worse. [§6.26](#-626-whole-session-totals--shipped-unconditional-the-kill-condition-fired) |
| 6.27 | **The prompt-path rung inside the boost's own base** | 🟡 **Not adopted, but the ladder is not monotone and the README now says so.** §6.16 refused `promptPath` as a shipped *dimension*, yet it is still the top rung of the base the correction is fitted on (`method.base`), and it is the one rung that loses: 538.5 vs 520.3 for plain `model+thinking` on the 7 Aug split, a cost of 18.2/call that the correction then wins 16.2 of back. Refitting the same correction on a promptPath-free base wins the single split (−15.8, CI [−28.4, −3.8]) but NOT the rolling gate (−4.8, CI [−12.2, +2.9]), so the pre-committed rule keeps the ladder as shipped. The correction is worth more on the worse base (−17.0 vs −10.8), which is what a correction undoing a base-rung mistake looks like. Re-test at the next corpus endpoint. `probe-base-ladder.mjs`, `base-ladder-probe.json` |

### 6.5 `tools` — deleted

It meant *"were tools available"*, which for an agent is **always yes** — a
constant. A constant carries zero information but still splits every group in
half, starving the tail estimate. The transcripts never record a tool count, so
it was unmeasurable here and no `tools=` group ever shipped. Removing the rungs
left every holdout number **unchanged**.

### 6.6 `input size` — deleted

Tested five independent ways. It has **never once helped at P99** — more buckets
means fewer samples per bucket, and the tail estimate goes noisy first. On the CV
its effect is indistinguishable from zero, and its sign flips between
regenerations. No `input=` group ever shipped.

**The ladder is now four dimensions** (`model`, `thinking`, `effort`, `task`)
instead of six, and 9 rungs instead of 17. `effort` and `task` are Phase 3
placeholders that no shipped profile populates.

### 6.7 `effort` — rejected

`effort` *is* populated in raw transcripts (~52% of calls) and looked like a
monotone **4.6×** ladder. It is a **(day, model) artifact**: each level occupies
almost no shared cells, `effort=max` had exactly one, and the separation does not
survive holding date and model fixed. `effort=xhigh` fails both the heterogeneity
and sign tests on 2 cells.
[Details](./GENERATIVE-MODEL.md#3-effort-is-recorded--and-it-does-not-survive-contact-with-the-confound).

**This is the rejection that set the standard of evidence for everything after
it:** check **support** (which (day, model) cells does the group occupy?), then
significance, then whether the effect keeps its **direction** across cells.

### 6.8 A recency window — rejected

Drift is real, so fitting only on recent data looked obvious. Swept 7 / 14 / 30 /
90 / all days against the rolling CV, **paired fold by fold**:

| Window | Per-call difference vs full history | 95% CI | Verdict |
|---|---|---|---|
| 7 days | **+16.22** (worse) | [+5.97, +25.43] | 🔴 Worse — too few samples, noisy P99 |
| 14 days | −0.64 | [−3.52, +1.73] | ⚪ Noise |
| 30 / 90 / all | 0.00 | [0.00, 0.00] | ⚪ Identical (the corpus is under 30 days wide) |

> 🔧 **This table now reports the block bootstrap, not the 5-fold t.** The old
> statistic is kept in the artifact as `legacyFold*` on every comparison so
> results published before 4 August 2026 stay checkable — for these rows it said
> t = +3.06 / −0.52, which reaches the same verdicts. It does not always:
> [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused) is
> the case where it disagreed with itself.

**No window adopted.** The near-miss is the lesson: an earlier version of the
selection rule used a plain `<` comparison and duly adopted 14 days, which would
have **halved the shipped sample for a difference 350× smaller than the fold
spread**. The rule now requires the **whole 95% CI to sit below zero**.

> 📌 **Repo rule, from this experiment:** a change only replaces the current one
> if it genuinely *beats* it on held-out data. A difference inside the noise is
> not a win.

### 6.9 Re-forecasting by loop depth — mechanism rejected

*`node experiments/evaluation/probe-loop-depth.mjs`*

**The hypothesis.** Don't forecast once — re-forecast at every step of the agent
loop. This looked like the most promising lead we had, for a good reason: the
biggest signal in the corpus is *which tool the turn calls*, and it's unknowable
before the call — **but in a loop, the previous action has already happened.**
Every tool result is a free, legal, pre-call feature for the next forecast.

**The result.** Held-out pinball per call, paired across 5 folds, graded against
the **shipped** predictor. Adoption needed **t ≤ −2** — the rule at the time, since
[replaced](#8--house-rules-earned-not-assumed) by a block bootstrap on the
per-call series, for reasons this very table produced.

| Feature from the preceding step | vs shipped | paired SE | t | |
|---|---|---|---|---|
| **Previous output size** | **−16.4** | ±4.4 | **−3.8** | 🔴 **did not replicate — see [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused)** |
| Previous action *(the whole thesis)* | −0.4 | ±3.7 | −0.1 | ⚪ nothing |
| Loop depth | −0.8 | ±1.2 | −0.7 | ⚪ nothing |
| Previous `stop_reason` | −1.6 | ±1.9 | −0.8 | ⚪ nothing |
| Size of the tool result it answers | +0.4 | ±1.5 | +0.2 | ⚪ nothing |
| How long those tools took | +1.1 | ±1.6 | +0.7 | ⚪ nothing |
| Previous action **+** previous output | −9.8 | ±2.4 | −4.2 | 🟡 worse than output alone |
| Whole-loop output regime (8-call mean) | −9.6 | ±2.5 | −3.9 | 🟡 worse than the last call alone |
| *(ceiling)* told the true action | −50.6 | ±7.8 | −6.5 | 🔒 oracle — **understated, see [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact)** |

> 🔧 **The oracle row above is wrong, and the probe that produced it is fixed.**
> It is a joint-rung-only measurement, which cannot fire on `Write` at a
> 100-sample floor. The corrected ceiling is **~−90 (range −50 to −126)**, and
> the correction does not touch the five rows above it: those measured at zero
> under both statistics. [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact)
> has the evidence. The row is left as published, because the interesting fact is
> *which* row moved — the same reason the `previous output size` row was left.

**The mechanism is dead.** The previous action *is* observable, and it is worth
**−0.4 ± 3.7** — indistinguishable from zero, and it makes the combined ladder
*worse* than the winning feature alone. Knowing the last step was a `Read` tells
you nothing that model and thinking haven't already said.

> ⚠️ **Read the last row of that table against [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused)
> before building on it.** The four zeros below replicated on 4 August. The one
> positive result did not: it came back at −7.2 ± 4.1. The table is left as
> published, because the interesting fact is *which* row moved.

**What survived is a feature the hypothesis mentioned only in passing:** the
**previous call's output length** — the free feature
[GENERATIVE-MODEL.md §5b](./GENERATIVE-MODEL.md#5b-one-free-feature-nobody-has-tested)
proposed and nobody had graded. Restricted to the 93% of held-out calls that
actually have a preceding step, it is worth **−17.5 ± 4.6** (~3%). It passes the
[§6.7](#67-effort--rejected) gates where it claims an effect:

| level (vs `200-800`) | days | cells | within-cell | naive | sign | sign p |
|---|---|---|---|---|---|---|
| previous output `800-3k` | 27 | 55 | **1.35×** | 1.41× | 36/45 | <0.0001 |
| previous output `≥3k` | 27 | 47 | **1.33×** | 1.33× | 18/25 | 0.043 |
| previous output `<200` | 27 | 56 | 0.97× | 0.95× | 22/42 | 0.88 ⚪ |

Within-cell ≈ naive is what an unconfounded effect looks like. Note the last row:
a **short** previous output says nothing. The signal is entirely *"the last reply
was long, so this one may be too"*, and it concentrates in the tail.

#### 🔬 The headline diagnostic: band width by loop depth

The plot that was supposed to decide it. Held-out calls, mean width of the
forecast issued:

| loop depth | n | actual P99−P50 | shipped band | with loop context | narrowing |
|---|---|---|---|---|---|
| 0 | 194 | 4,999 | 6,301 | 6,301 | — |
| 1 | 164 | 4,035 | 4,726 | 4,441 | 285 |
| 2 | 148 | 4,197 | 5,009 | 4,315 | 694 |
| 3 | 133 | 3,915 | 4,947 | 4,315 | 632 |
| 4 | 122 | 3,503 | 5,382 | 4,891 | 491 |
| 5 | 114 | 8,762 | 4,704 | 4,322 | 382 |
| 6+ | 1,950 | 4,311 | 4,390 | 4,242 | 148 |

**Read the third and fourth columns together, because that is the whole trick.**
Deep calls *are* forecast tighter than depth-0 calls — 4,284 vs 6,301, exactly as
predicted. But **the shipped predictor narrows just as much** (4,390 vs 6,301),
and it has no depth feature at all.

The narrowing is **composition, not information**:

| loop depth | n | thinking enabled |
|---|---|---|
| 0 | 1,308 | **85.0%** |
| 1 | 1,017 | 64.2% |
| 3 | 802 | 64.0% |
| 6+ | 8,806 | **53.7%** |

Turn-opening calls are overwhelmingly thinking-enabled, thinking groups have ~3×
the band, and **both predictors already know about thinking**. Depth is a proxy
for a variable we shipped in June.

What re-forecasting actually buys is the *gap* between those columns:

$$\text{slope of the gain against depth} = +1.1\ \text{pinball per level}$$
$$\text{slope of the narrowing against depth} = -28\ \text{tokens per level}$$

**The gain does not compound with loop length.** A forecast at step 20 is no
better-informed by its history than one at step 2.

> ⚖️ **Verdict.** The stated kill condition was "if depth ≥3 is no tighter than
> depth 0, stop". Literally it doesn't fire — depth ≥3 *is* tighter. As meant
> ("the gain compounds with loop length") it **fires**. The honest statement:
> re-forecasting is worth a flat −16.4 pinball/call through a single feature, and
> **the agent-loop framing contributed nothing to that number.** Any caller that
> remembers its last output length gets the same win without re-forecasting.
>
> It remains a fine *delivery model* — it dissolves the per-call-vs-per-session
> question rather than solving it — just not an accuracy win.

#### 🐛 A leak we caught, and how

The first version of "elapsed time since the previous step" measured **previous
call → this call**. It looked like the best feature ever found: **−79.9**
pinball/call, *better than the oracle*.

That is the tell. **A pre-call feature cannot beat knowing the answer.** The gap
between two assistant timestamps contains the time *this* call spent generating,
and generation time rises with output length — the feature was the answer wearing
a clock:

$$\text{corr}(\log \text{gap}, \log Y) = \mathbf{0.513} \quad\text{(wall clock — illegal)}$$
$$\text{corr}(\log \text{gap}, \log Y) = \mathbf{0.041} \quad\text{(tool duration — legal)}$$

The legal clock — previous call → *its results arriving*, which finishes running
before the next forecast is due — is worth **+1.1 ± 1.6**, i.e. nothing. The leaky
version is kept in the probe as a **labelled control**, next to the oracle, so the
next person to find a suspiciously good timing feature has something to compare
against.

#### 🧱 The infrastructure this needed

`lib/load-history.mjs` reconstructs the agent loop from the transcript's
`parentUuid` chain, behind `{ withLoopContext: true }`. Two mistakes it avoids:

- **"Previous call" by timestamp within a session is wrong.** Sidechains run
  concurrently inside one session, so a subagent's call gets handed a parent it
  never saw. The parent link is what the transcript actually records.
- **An unindexed chain row is not a broken chain.** 2,236 calls hang off
  `attachment` rows (skill listings, tool-registry deltas) — transcript
  decoration, not conversation steps. Treating those as breaks lost the ancestry
  of **one call in six**, and those calls then defaulted to "depth 0" — seeding
  the control bucket of this very experiment with deep-loop calls. Ancestry
  resolution went from 18% to **100%** once they were passed through.

### 6.10 Fitting the tail — half confirmed, half rejected

*`node experiments/evaluation/probe-tail-fit.mjs`*

Peaks-over-threshold: empirical quantiles below a threshold, a generalized Pareto
above it.

**✅ What worked** is in [§4.3](#43-the-tail-what-the-p99-is-really-worth): a
stable fit, a P99 with a standard error, and a correction to the
"infinite variance" claim.

**❌ What failed: extrapolating past what we've seen.** The exciting claim was
that a fitted tail gives $P(Y > \texttt{max\_tokens})$ by extrapolation, unblocking
cap risk despite our having zero censored calls — and it came with its own
proposed test: fit as if nothing above $T$ had ever been observed, predict
$P(Y > 2T)$ and $P(Y > 4T)$, check against counts we have.

Run properly (the fit is **right-truncated** at $T$, so exceedances above $T$
contribute nothing) and **swept across thresholds instead of run at one**:

| fit below | threshold u | ξ fitted | P(Y>8,000) predicted | observed |
|---|---|---|---|---|
| T=4,000 | 432 | 0.613 | 1.45e−2 | **7.14e−3** |
| T=4,000 | 775 | 0.648 | 1.61e−2 | (95% CI |
| T=4,000 | 1,116 | 0.336 | **6.12e−3** ✅ | 5.9e−3 |
| T=4,000 | 1,444 | 0.535 | 1.16e−2 | – 8.7e−3) |
| T=4,000 | 1,948 | 0.069 | 1.42e−3 | |

**The answer depends entirely on a threshold we would have had to guess.** Across
both truncation points and every threshold tried, the GPD lands inside the
observed interval in **3 of 28** tests. At T=2,000 the fitted shape ranges from
**−1.51 to +3.63** depending on u — at the negative end it claims a hard upper
bound around 2,000 tokens, which the corpus contradicts 99 times over.

The log-normal fails too (**0 of 4**, understating every time) — but "the rival is
also wrong" is not a licence to extrapolate.

> ⚖️ **Verdict: the cap-risk shortcut is rejected, by its own test.** The tail can
> be *interpolated* — a P99 with a standard error, stable and useful. It cannot be
> *extrapolated* to a threshold we have never observed. **Cap risk stays blocked,
> and the reason is unchanged: we need data where the cap actually binds.** A
> fitted tail is not a substitute for an observation.

**And it doesn't narrow the band either.** The shipping question — replace the
empirical P99 with the fitted one?

| P99 source | total pinball | P99 loss | mean band | P99 coverage |
|---|---|---|---|---|
| empirical *(ships today)* | 594.9 | 82.1 | 4,659 | 98.6% |
| fitted GPD | 594.2 | 81.5 | **4,860** | 98.6% |

Paired difference **−0.7 ± 0.8 (t=−0.85)** — inside the noise — and the band gets
**4.3% wider**. **Not adopted.** The fitted P99 is documentation of uncertainty,
not a better forecast.

### 6.11 Log-normal quantiles — rejected

Output lengths *look* log-normal. If true, two numbers would describe any group
instead of needing 100+ samples per percentile:

$$\log Y \sim \mathcal{N}(\mu, \sigma^2) \quad\Longrightarrow\quad q_p = \exp\!\big(\mu + \sigma \Phi^{-1}(p)\big)$$

**Result: a tie overall (553.0 vs 554.4 — noise), and dangerous in one spot.** For
Opus 5 it *understated* the P99 by **38%**. A log-normal has all moments finite,
so it can never match a tail with ξ ≈ 0.37 ([§4.3](#43-the-tail-what-the-p99-is-really-worth)) —
the failure wasn't Opus-5-specific, that's just where the thinner tail got caught
first. Understating a P99 is the one direction you can't afford.

✅ **Don't switch. Revisit only if groups get thin.**

### 6.12 The action-type mixture — measured, not shipped

Since the action isn't knowable pre-call, it enters as a mixture:

$$P(Y \le y \mid x) = \sum_{k} \pi_k(x) \, P(Y \le y \mid A = k)$$

| | vs marginal | paired SE | t |
|---|---|---|---|
| **mixture** (uses $\hat\pi_k$) | −2.2 | ±3.0 | −0.7 |
| **oracle** (told the true action) | −112.6 | ±22.3 | −5.1 |

The classifier captures **1.9%** of the available prize. Operationally
negligible. **Don't ship the mixture; chase $\pi_k$.**

> 🔧 **This section's −112.6 is measured against the MARGINAL, and it is the one
> oracle figure in this document the 4 August correction leaves standing.** A
> mixture over the marginal never had a joint `m|t|action` rung to be suppressed
> by the sample floor. It is also, read alongside
> [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact), the corroboration:
> −112.6 against the marginal and ~−90 against a shipped predictor that already
> holds much of the `thinking` signal are consistent. **−49 never was.**

> ⚠️ **Flag, this regeneration:** the mixture's gain used to be *statistically*
> real (−4.9 ± 2.0, t = −2.4) even while being operationally worthless. On the
> current corpus it is **−2.2 ± 3.0, t = −0.7** — no longer distinguishable from
> zero at all, and the captured share fell from 5.1% to 1.9%. The verdict is
> unchanged and only gets easier: **don't ship the mixture.** The oracle moved
> the other way (−95.8 → −112.6), so the *prize* is still there; it is the
> classifier that cashes none of it.

### 🐛 6.13 The loader bug — a methodology note worth keeping

Claude Code writes **one JSONL row per emitted content block**, all sharing a
`requestId`, and repeats the call's *total* `output_tokens` on every row. An early
probe loader assumed usage *accumulates* and kept one row per call — the first on
ties, which for a thinking call is the zero-length `thinking` marker. So it
compared **one block's characters** against **the whole call's tokens**, discarding
the text and tool blocks of **7,650 of 12,946 calls (59%)**.

Two published findings were entirely this bug. **The shipped predictor and main
eval were never affected** — `eval-claude-code-history.mjs` merges rows correctly
and always has.

**How it was caught:** not by a test, but by checking a data assumption before
building on it. All probes now share one population definition
(`lib/load-history.mjs`) and one set of statistical gates (`lib/stats.mjs`), so
neither can quietly diverge again.

### ✅ 6.18 The cold-start audit — pooled `thinking` tier ADOPTED

*`node experiments/evaluation/probe-cold-start.mjs [--as-of <instant>]`; the
adoption gate now lives in `eval-claude-code-history.mjs` and runs on every
regeneration.*

The 9 August product decision made the zero-context path the product, and this
was the first time it was graded as such. Three results, in increasing order of
consequence:

**1. The caller tiers, scored on identical holdout calls.** A cold caller that
passes `{model, maxTokens, thinkingEnabled}` scores **508.5** against the full
ladder's **505.4** — a difference that is pure noise (+3.0 [−5.3, +10.9]).
Dropping `thinkingEnabled` costs a real **+40.8/call [+28.0, +52.8]**. So the
shipped headline was never earned by rungs a cold caller can't reach; it is
earned by `thinking`, which every caller can pass, plus the boosted correction
(−19.1) where context exists.

**2. The `overall` fallback was never calibrated — it was labelled.**
Leave-one-model-out (fit every group with model M excluded, score M's holdout
calls through the fallback path): the blend covers an unseen fable-5 at
**87.7%** at P90 and an unseen opus-5 at **96.6%** — wrong in opposite
directions, because the blend is whatever the *other* models happened to be.

**3. The fix was already in the ladder and had never shipped.**
`HISTORICAL_GROUP_TIERS` has carried a pooled `["thinking"]` rung since June;
no profile ever materialized those groups, so a fallback caller declaring its
thinking flag got the same blend as one declaring nothing. Pooled
`thinking=yes|no` groups beat `overall` on LOMO calls by **−43.2/call
[−65.4, −21.3]** (eval gate; the probe endpoint read −54.9 [−68.2, −39.9]),
and the verdict survives every metric variant in §6.20. **Adopted; the profile
now ships `thinking=no` (219/897/3,226) and `thinking=yes` (588/2,436/8,477).**

Two related measurements settled the ladder order for fallback callers:
thinking-first beats the previous path-first order by **−55.0/call
[−65.9, −43.6]**; a joint `thinking|promptPath` pooled rung adds nothing
(−4.0 [−11.6, +4.8] — house rule 7 says stop). The pooled `promptPath` rung
moved below the thinking-family rungs, and the reorder changes **0 of 2,996**
in-profile holdout forecasts, because every joint `m|t|path` group is
populated whenever the path tiers ship at all.

> 🧭 **Why this is the right kind of win.** It is exactly the shape the
> product needs: zero caller context, zero predictor code beyond a tier
> reorder, active on day one for any model the profile has never seen —
> Sonnet 5 today, every future model until its groups are fitted.

### ❌ 6.19 Conformal / time-decay recalibration — REFUSED

*`node experiments/evaluation/probe-calibration.mjs [--as-of <instant>]`*

The P50 coverage miscalibration (57–59% against a 50% target) and the P90
drift finally have a mechanism, found by elimination:

- **Not estimator bias.** In-sample coverage of every fitted
  (model, thinking) group is **50.1 / 90.0 / 99.0** — the empirical quantile
  estimator is unbiased at these group sizes.
- **Within-group drift.** Holdout-weighted, the fitted quantiles overshoot the
  holdout of the *same group* by **1.245× at P50, 1.333× at P90, 1.374× at
  P99**; 16 of 18 group-folds overshoot P50 by >5%. The workload itself is
  shrinking: corpus-wide P50 by fortnight ran **510 → 429 → 345** and P90
  **2,344 → 1,844 → 1,572**. A full-history fit is an average over that slide,
  so it sits above the present. (Composition across groups cannot explain
  group-conditional coverage; it was checked and doesn't.)

Two cold fixes were gated, and both were refused:

| candidate | vs shipped ladder | 95% CI | verdict |
|---|---|---|---|
| split-conformal, additive, global | +4.03 | [−1.69, +10.41] | ❌ |
| split-conformal, additive, per-model | +5.30 | [−0.94, +11.37] | ❌ |
| split-conformal, additive, per-group | +6.98 | [−0.84, +13.48] | ❌ |
| split-conformal, multiplicative, per-model | **+7.18** | **[+0.69, +13.47]** | 🔴 **provably worse** |
| exp. decay, half-life 7d | −1.88 | [−4.91, +0.28] | ❌ close, CI touches 0 |
| exp. decay, 14d / 28d / 56d | −1.22 / −0.91 / −0.50 | all include 0 | ❌ monotone in the right direction |

The conformal failure is instructive: the trailing 25% of training data is a
handful of *sessions*, and its residual quantiles are session noise, not a
drift estimate — the same effective-sample trap as house rule 14. The decay
ladder is the honest middle: right direction at every half-life, never
separable from zero at 57 session blocks. **Nothing ships. The mechanism is
documented; the miscalibration is drift, and the safe direction — over-cover,
never under-cover — is the direction it errs in.**

### ✅ 6.20 The target audit — pinball vindicated, one divergence

*`node experiments/evaluation/probe-reservation-metric.mjs [--as-of <instant>]`*

The product use is a reservation: reserve R tokens, pay `waste = max(0, R−y)`
when over, pay overflow when under. The loss family
`L_k = waste + k·excess` prices one overflow token at k wasted ones — and
`L_9` at R=p90 is *exactly* 10× the p90 pinball, so pinball always was a
reservation loss at a fixed exchange rate. What was never checked is whether
any verdict depends on the rate. Re-graded under p50-only / p90-only /
p99-only pinball and `L_k` for k ∈ {1, 4, 9, 19, 49} at R=p90 plus `L_99` at
R=p99:

- **Metric-robust:** the boosted correction and the pooled thinking tier pass
  the gate under **every** variant. No standing adoption depends on the blend.
- **The divergence:** hard 14-day windows and 7-day decay — both refused under
  total pinball — become **provably worse** at k ≥ 19 (window14 at k=19:
  +27.6 [+8.8, +49.4]). Thinning the tail estimate is precisely what an
  overflow-averse caller cannot afford. §6.8's rejection is *strengthened*
  under the product metric.
- **`promptPath` under the product metric:** inconclusive under every variant
  at this endpoint, consistent with its gate flip in §6.18/7.3.
- **Product-terms calibration of the shipped ladder:** a p90 reservation
  overflows **7.9%** of calls (promise ≤10%), a p99 reservation **0.9%**
  (promise ≤1%). The drift of §6.19 costs waste, not overflow.

**Question closed: total pinball stays the score.** Adoption gates need no
second metric; the one systematic disagreement (recency) agrees with the
existing rejection.

### ❌ 6.21 Static action-type mixture — CLOSED PERMANENTLY

*`node experiments/evaluation/probe-static-mixture.mjs [--as-of <instant>]`*

§6.12's untested middle ground: blend pooled per-action outcome distributions
with **fixed** weights (the group's train-time action shares — no classifier,
fully cold). The narrow question was whether it buys a narrower P99−P50 band
at equal coverage than the pooled empirical tail. It does the opposite, with
CIs entirely clear of zero:

| variant | vs plain group quantiles | 95% CI | P99−P50 band |
|---|---|---|---|
| *(plain, incumbent)* | — | — | 5,220 |
| mixture, all quantiles, action components | **+55.0** | [+43.1, +65.9] | 6,186 |
| mixture, p99 only, action components | +8.4 | [+6.2, +10.7] | 6,195 |
| mixture, all quantiles, action×thinking components | +7.6 | [+4.8, +11.0] | 5,443 |
| mixture, p99 only, action×thinking components | +1.7 | [+0.4, +2.7] | 5,457 |

The mechanism is the mirror image of §4.2a: a group's own tail is *already*
the correctly-weighted blend of its own actions. Replacing its components
with corpus-pooled ones imports other regimes' heavier tails and widens every
band. **§6.12 is closed: with oracle weights the mixture is worth −112; with
learnable weights ~2%; with static weights it is provably negative. There is
no version of this that ships.**

### ⚫ 6.22 `maxTokens` as a signal — unmeasurable, zero support

Callers choose `max_tokens` and might choose it informatively — it is
pre-call, cold-start-available, and had only ever been used as a clamp. It
cannot be tested on this corpus: **Claude Code transcripts do not record the
request's `max_tokens` anywhere.** Zero of 2,694 assistant rows in the 40 most
recent transcripts carry any `max*` key at any depth; a corpus-wide grep for
`"max_tokens":` as a JSON key matches **zero files** (the string appears only
inside conversation *text*). `stop_details` is always empty and the corpus has
zero `max_tokens` stop reasons. Support is not thin — it is absent, which is
also why cap-risk calibration (§6.10, §7.5) stays blocked. **Revisit only with
Phase 3 telemetry, which records the request configuration.**

### 🟡 6.23 The missing-signals sweep

*`node experiments/evaluation/probe-missing-signals.mjs [--as-of <instant>]`,
10 August 2026.*

Seven pre-call signals the ledger had never graded, each tested as one extra
dimension on `model|thinking` (joint rung above, pooled rung below, unknown
skips, MIN_GROUP 100), rolling-origin holdout, paired session-block bootstrap:

| candidate | diff/call at the current endpoint | 95% CI | verdict |
|---|---|---|---|
| **`promptImage`** — turn-root message carries an image | **−4.23** | [−10.77, +0.44] | 🟡 **Wired, gated, not yet adopted** |
| `command` — which slash command opened the turn | +0.09 | [−0.24, +0.61] | ⚫ **No support** — 390 command rows corpus-wide, dominated by `/clear` (248) and `/model` (75), which never root an API call. Closed the way §6.22 closed `maxTokens`. |
| `artifactIntent` as a rung | +9.91 | [−10.79, +27.69] | ❌ Worse. It stays a boosted-tree feature only. |
| `deliverableType` as a rung | +10.40 | [−10.55, +28.43] | ❌ Worse. |
| `hasExpansive` as a rung | +1.32 | [−2.79, +5.12] | ❌ Nothing. |
| same-tool `streak` (§7.2's untried candidate) | −0.24 | [−3.50, +3.27] | ❌ Nothing. The §7.2 list is now empty. |
| `turnCum` — within-turn cumulative output | +1.97 | [−3.72, +7.07] | ❌ **Endpoint-unstable** — reads −25.0 [−34.6, −13.9] at the 5 Aug endpoint and +2.0 today. The `promptPath` disease; not credible. |

**The `promptImage` finding.** 13.7% of resolved turn roots carry an image, and
image turns run *shorter*: within-(day, model) median ratio **0.89×** (pooled
0.77×; direction holds in 15 of 25 supported cells — consistent with
screenshot-verification turns getting short confirmations). Across five corpus
endpoints (25 Jul, 1 Aug, 5 Aug, 8 Aug, full) the paired difference is
**negative at all five** — −1.38, −3.44, −2.29, −5.75, −4.23 — and the CI
clears zero at two (1 Aug: [−6.28, −1.36]; 5 Aug: [−5.05, −0.03]). No sign
flip anywhere, which is more direction-stability than `promptPath` ever
showed. It is implemented end to end — `promptHasImage` on the request schema
(tri-state: omitted means the turn root was unavailable, never "no image"),
a `promptImage` dimension and pooled rung in `HISTORICAL_GROUP_TIERS`, and an
adoption gate in the eval graded against the active baseline — and ships
automatically the regeneration its CI upper bound crosses zero. Current
verdict on stdout: **NOT ADOPTED, −4.19 [−10.59, +0.51]**.

The loader now records two turn-root observations that were previously
stripped as harness noise: `turnCommand` and `turnHasImage`, both strictly
pre-call, both propagated down the loop exactly like `turnPrompt`.

**Second delivery route, shipped: the boosted correction is now
`portable-precall-v2`**, appending one feature — turn-root image presence,
tri-state like `promptMentionsPath` (index 36; v1 trees never reference an
index above 35, so old profiles still apply). Paired v2-vs-v1 on identical
folds: **−0.06/call overall [−1.24, +1.14] — not separable — but −3.76/call
on the 692 image-turn holdout calls (21.7% of the holdout)**, with the cost
spread as noise across the rest. The correction's own shipping gate is
unaffected (rolling −17.5 [−23.4, −12.2]). For an image-heavy caller this is
a real regime win that the corpus-wide average dilutes; callers must pass
`promptHasImage` to receive it, and omitted still means unknown.

### ✅ 6.24 Boost capacity sweep — ADOPTED

*Scratch sweep, 10 August 2026 (evening); winning defaults are now in
`lib/quantile-boost.mjs` and cited there.*

The correction's hyperparameters (depth 2, 24 iterations, lr 0.12, leaf 150)
had never been tuned. Swept 8 configurations on rolling folds, paired
session-block bootstrap vs the shipped config:

| config | vs shipped | 95% CI | verdict |
|---|---|---|---|
| **depth 3, 48 iters, lr 0.08** | **−6.41** | [−9.81, −2.85] | ✅ **shipped** — and beats depth-3-alone by −1.79 [−3.24, −0.33], so rule 7 does not bind |
| depth 4, 48 iters, lr 0.06, leaf 200 | −6.51 | [−10.90, −2.49] | tie with winner; deeper for nothing |
| depth 3, 24 iters | −5.66 | [−8.16, −2.83] | beaten paired by the winner |
| depth 2, 48 or 96 iters | −1.9 … −2.3 | include 0 | ❌ more rounds without depth is not the mechanism |

**Depth is the lever, not rounds** — consistent with the v2 feature set being
interaction-shaped (image × prompt size, prior-chain × thinking). Regenerated:
**rolling boosted 483.2/call vs 507.0 base, −23.8 [−32.4, −15.9]** (was
−17.5); mean P90−P50 width 1,134 → 1,097 and P99−P50 5,241 → 4,894. Coverage
holds (58.1 / 91.9 / 98.8). Deeper (4) and longer (96) capacity is exhausted
at this corpus size; do not re-sweep without materially more sessions.

### ✅ 6.25 Whole-turn totals — SHIPPED, coarse on purpose

*`node experiments/evaluation/probe-turn-totals.mjs [--as-of <instant>]`,
10 August 2026 (evening). API: `historicalTurnTotalForecast()`; profile field
`turnTotals`, emitted by the eval on every regeneration.*

§7.5's per-session-total question, answered at the turn level: 1,095 turns
(14.5 calls/turn mean), totals **P50 4,952 / P90 31,133 / P99 102,070** —
a completely different budget than any per-call number. Holdout coverage of
the shipped grouping is **49.5 / 91.7 / 97.9** against 50/90/99 targets.

**Why it ships only `overall` and `thinking=yes|no`.** Every finer
conditioning candidate failed: model+thinking is *worse* than the overall
blend at turn level (thin cells), and the one gate-clearing candidate at the
current endpoint — session position (first/early/late) at
−1,911/turn [−3,651, −128] — **flips sign across endpoints** (+788 on 25 Jul),
the `promptPath` disease at 62 holdout sessions. House rule 14: the effective
sample is ~1,100 turns / ~60 sessions, and it cannot support turn-level rungs
yet. ⚠️ One number not to over-read: the `thinking=no` P99 (126,579 on 230
turns) sits above the `thinking=yes` P99 — that is tail noise at n=230, not a
finding. The turn count is the number to watch before re-testing (§7.3 said
the same about prompts).

### ✅ 6.26 Whole-session totals — SHIPPED unconditional; the kill condition fired

*`node experiments/evaluation/probe-session-totals.mjs [--as-of <instant>]`,
10 August 2026 (night). API: `historicalSessionTotalForecast()`; profile field
`sessionTotals`, emitted by the eval on every regeneration.*

§6.25 answered Σ over one turn; this answers the session: given k turns
finished, forecast the TOTAL remaining output with the number of remaining
turns itself random. Dataset: **311 usable sessions** (312 with known ids; 1
dropped because calls fell outside any turn — one broken turn poisons the
sum), turns/session P50 2 / P90 7, session totals **P50 21,075 / P90 117,016
/ P99 223,033** — five orders of magnitude spanned, another budget class
above per-call (~500) and per-turn (~5k).

**Design.** One prediction point per (session, k) for k = 0..N−1; target is
the remaining total. Per-session loss is the mean over its points, bootstrap
blocks are sessions (house rule 14: the effective sample is ~63 holdout
sessions, and the CIs below are honestly wide). Dumb forecasts first:

| candidate | vs total-minus-spent, current endpoint | vs pooled remaining, current endpoint |
|---|---|---|
| `uncondTotal` — session-total quantiles minus spent, clamped ≥0 | baseline (54,349/point) | +21,928 — the WORST forecast graded |
| `uncondRemaining` — remaining pooled over all k | −21,928 [−50,571, −416] | baseline (32,421/point) |
| `turnsTimesTurnQ` — (median turns − k) × per-turn quantiles | −2,306 [−12,296, +7,740] | +19,622 [+1,600, +39,183] — provably worse |
| `kBucket` — remaining quantiles per k bucket | −17,422 [−39,543, −21] | +4,506 [−575, +11,112] |
| `spentBucket` — remaining quantiles per spent bucket | −20,430 [−46,219, −583] | +1,498 [−1,031, +4,321] |

**The kill condition fired, and endpoint stability is what killed it.** At
the current endpoint `kBucket` and `spentBucket` read ADOPTABLE against
total-minus-spent — with CI upper bounds of −21 and −583, grazing zero. At
the three earlier endpoints (25 Jul, 1 Aug, 5 Aug) **neither clears at even
one**, and against the pooled remaining distribution no conditional
candidate is ever negative at any endpoint (`kBucket` is significantly
*worse* at 1 Aug: +3,368 [+1,086, +5,799]). One endpoint's ADOPTABLE is not
a finding — §6.23/§6.25's lesson, third confirmation. Ship the unconditional
quantiles only.

**One real finding rides along: remaining output is roughly memoryless.**
The natural UI move — take the session-total quantile, subtract what was
already spent — is the *worst* forecast measured, beaten by simply
re-reading the unchanged quantiles mid-session (−21,928/point, CI clear at
2 of 4 endpoints, direction negative at all 4). Sessions that have already
spent a lot are not "nearly done"; they are sessions revealed to be large.
The doc comment on `sessionTotals` says so, because a consumer WILL try to
subtract.

**What ships:** `sessionTotals.overall` (n=311) in the profile, emitted every
regeneration with the same session-eligibility rule as the probe;
`historicalSessionTotalForecast(profile, options)` — deliberately no request
argument, nothing conditional earned a parameter; tests in
`historical.test.ts`. Coverage of the shipped quantiles at session start:
41.3 / 92.1 / 98.4 at the current endpoint — but read that against n=63
sessions (25 Jul: 61.9/85.7/100; 1 Aug: 31.0/100/100). The number to watch
before re-testing conditional rungs is the SESSION count, not calls or
turns; at ~300 total this question is answered until the corpus roughly
doubles.

### ⚫ 6.27 `followupCompression` — implemented, gated, REFUSED on support

*`pnpm evaluate:claude-history` (the gate now runs in `eval-winning-boost.mjs`
on every regeneration), 11 August 2026. Motivating issue: BACKLOG "prompt-aware
boost is flat at chat turn roots".*

The issue's fix direction (1). At a chat turn root every loop-shape feature is
zero, so opposite drafts land in the same leaves and forecast the same median
(523 for `let's summarize it` and for a one-sentence brief). Part of the
mechanism is a missing bit: the corpus sense of "summarize X" is *go read X,
then write 800 tokens*, and nothing separated it from "summarize **it**",
which means *shrink what you just said*. So: a `followupCompression` feature
(short prompt + compression verb + anaphoric object, mirrored byte-for-byte in
`predictor/src/boosted.ts` and `evaluation/lib/load-history.mjs`), feature
schema `portable-precall-v3` appending it at index 37, and a retrain.

**The retrain never got a chance, and the reason is the finding.** The feature
fires on **2 of 987 distinct human turn prompts — 2 of 16,386 calls**:

| population | n | median output | mean output |
|---|---|---|---|
| `followupCompression=yes` | **2 calls** | 337 | 235 |
| `followupCompression=no`, `loopDepth=0` | 1,030 | 517 | 1,161 |

The direction is the one the issue predicted (and the two calls are exactly the
two live "summarize it" turns it recorded, 337 and 132 against p50 523) — but
**n=2 is an anecdote, not a measurement**, and it is the whole corpus. Length
is not the binding constraint: 342 of 987 turns are ≤80 characters. The
compression verb with an anaphoric object is simply rare in a Claude Code
transcript, because this corpus is agent work, not chat.

**Why the loss gate cannot decide this.** The trainer's minimum leaf is 150
rows, so a column that is 1 on 2 rows can never be chosen as a split. v3
therefore trains **byte-identical trees to v2**, and the paired rolling
comparison reads exactly **0.00/call [0.00, 0.00] with P90 coverage 92.0% in
both arms** — a perfect "no regression" that would have adopted a schema whose
new column is dead. The gate grades **support first** for that reason: ≥150
training rows, *then* no provable pinball regression, *then* P90 coverage in
88–93%. Verdict on stdout: **NOT ADOPTED, support=2 calls / 2 turns; deploying
`portable-precall-v2`.** `bundled-profile.ts` is unchanged.

Health of the shipped correction on the same run, for the record: rolling
baseline **525.5/call → boosted 506.5, −19.0 [−28.0, −10.3]**, coverage
53.6/92.0/98.9; single split 531.9 → 511.7, −20.2 [−30.3, −10.2].

**What did ship: the runtime, so the profile can move without a code change.**
`SUPPORTED_BOOST_FEATURE_SCHEMAS` now carries v3, the extractor emits 38
features, and the width check is schema-dependent
(`BOOST_FEATURE_COUNT_BY_SCHEMA`) instead of one constant — v1 and v2 profiles
evaluate exactly as before, and the optional
`promptForecastFeatures.followupCompression` field keeps pre-v3 telemetry rows
valid. The day a corpus with materially more *human chat turns* exists — §7.3's
condition, third time it has been the answer — the gate flips the schema on its
own. This is §6.22's shape, not §6.23's: not "measured and refused", but **no
support to measure**. Do not loosen the extractor to manufacture support; a
looser rule would relabel corpus "summarize X" tasks as compression follow-ups
and make the feature mean the opposite of what it is for.

---

### 🟢 6.28 Prompt-aware TURN TOTALS — the turn-root fix lands one level up

*`probe-turn-root-regime.mjs`, `probe-turn-total-boost.mjs`,
`pnpm evaluate:claude-history`, 12 August 2026. Motivating issue: BACKLOG
"prompt-aware boost is flat at chat turn roots", fix direction (2).*

**Fix direction (2) as literally stated — retrain the per-call correction on
turn-root rows only — was tried first and REFUSED.** A turn-root-only per-call
correction does unlock prompt splits (characterCount 162, requirements 130 of
its splits, versus 42+36 in the shipped ensembles), but every configuration in
an 18-point sweep (leaf 40–80, depth 2–3, replace and stacked) graded WORSE
than the shipped v2 on the turn-root holdout — best +14.5/call [−2.3, 29.0],
worst +93. The corpus is telling us something real: **the opening call of a
turn does not get longer when the prompt asks for more work.** The chip's
premise was aimed at the wrong random variable.

**The variable that does scale with typed intent is the whole turn.** An
artifact-plus-review draft doesn't lengthen the first API response; it
lengthens the loop (more calls, Write payloads, review output). So prompt
conditioning shipped on the TURN TOTAL instead:

1. **Pooled opener rungs** `thinking|promptPath` and `thinking|promptImage`
   (path first — it is the stronger lever, path turns run ~2.2x the pooled
   median, and it is the bit that can flip while a user types). Model
   conditioning is deliberately absent: the model-conditioned turn ladder
   graded ~+500/turn worse than pooled thinking-only, consistent with §6.25's
   thinking-only mean advantage.
2. **`turnTotalBoost`** — a portable quantile correction (24 depth-2 trees,
   leaf 60, lr 0.05, `portable-precall-v2` features) trained on per-turn
   totals over the rung ladder. At a turn opener every parent-chain feature is
   definitionally zero, so the trees spend their splits on prompt aggregates,
   thinking and session position — no regime collapse to fight.

**Gate, stated honestly.** At 1,182 turns the session-block CI is ±400–500 per
turn, so house rule 1's provable-improvement bound cannot close for effects of
this size in either direction. The shipping unit (rungs+boost) is graded
against the previously shipped thinking-only groups under the schema-gate
family rule — adopt unless it PROVABLY regresses or P90 coverage leaves
[0.90, 1]: **+5.2/turn [−499.6, +449.6], P90 coverage 96.7% → ADOPTED**.
Components for the record: rungs alone +69.4 [−126.6, +288.7] vs thinking-only,
boost −64.2 [−460.2, +269.6] vs rungs. This is a weaker gate than rule 1 and
is recorded as such; the trade bought is that the turn forecast now responds
to the draft, which is the product surface (the "reads your draft" chip that
BACKLOG told consumers to stop implying — it stops being a lie this way, not
by softening the copy). Config choice among the statistically-tied depth-2
candidates was made on final-model smoothness over a growing draft (smallest
mid-typing dip), because the chip is the consumer.

**What the shipped profile now does on a draft typed phrase by phrase**
(bundled profile, thinking on, `sessionPosition=1`):

| draft so far | turn p50 | turn p90 |
|---|---|---|
| `can you write` | 3,564 | 24,884 |
| `…a small report` | 3,390 | 23,682 |
| `…into a file lets say ./here.txt` | 8,427 | 38,283 |
| `…a report about predicting output tokens.` | 9,054 | 38,283 |
| `…then review a random pr in the internet` | 9,054 | 38,283 |

2.5x from first fragment to full intent, one ~5% dip (artifact-intent openers
run slightly shorter at median than unclassified fragments — data truth, not a
bug). The per-call forecast is untouched: same ladder, same v2 correction,
same numbers as §6.24. API: `historicalTurnTotalForecast` now accepts optional
`model` / `promptMentionsPath` / `promptHasImage` / `boostedContext`, returns
`promptCorrectionApplied`, and keeps byte-identical behavior for the old
thinking-only call shape. Profile field: `turnTotalBoost`, plus the pooled
rung keys in `turnTotals`. Legacy profiles without them behave exactly as
before.

---

## 7. What to do next

### 🟡 7.1 `previousOutputTokens` — implemented, gated, and currently refused

**Status: the machinery ships, the numbers do not.** The feature was built end to
end on 4 August 2026 — schema field, ladder rung, bucket function, tests, and an
adoption gate in the eval. The gate then **refused it**, and it was left switched
off. No shipped profile contains a `prevOutput` group today.

**What happened, and what it exposed.**
[§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected) measured this at
**−16.4 ± 4.4, t = −3.8** on 3 August. The same unmodified probe on 4 August gave
**−7.2 ± 4.1, t = −1.8**. So did an independent implementation in the main eval
(**−7.5 ± 4.7**). The two paths agree to within a tenth of a standard error, so
this was never a coding difference.

It was not a difference between *days* either — that was the first diagnosis
here, and it was wrong. Re-running the identical comparison at 41 corpus
endpoints spanning 13,470 → 14,470 calls (a 7% window):

| | across 41 corpus endpoints |
|---|---|
| point estimate | **−12.9 ± 3.5**, range −17.2 … −5.9 |
| 5-fold paired t | mean −2.12, **range −3.45 … −0.87** |
| would have adopted at t ≤ −2 | **22 of 41** |

**The effect was stable the whole time. The statistic used to judge it was not.**
The published −16.4 is reproducible simply by truncating today's corpus back to
~13,900 rows. In one twenty-minute window the identical comparison refused
(t = −1.6) and then adopted (t = −2.55) — with the point estimate barely moving
and the *standard error* swinging 5.42 → 3.56.

> 🧭 **The 5-fold t was the bug.** Three things were wrong with it, and all three
> are now fixed ([§6.8](#68-a-recency-window--rejected) has the replacement):
> 1. **n = 5.** The standard error was itself estimated from 5 numbers, so it
>    swung wildly run to run.
> 2. **Rolling-origin folds are not independent.** Fold 5 trains on fold 1's
>    holdout, so the per-fold differences share fitted parameters and their
>    spread is not a valid error bar.
> 3. **It threw away almost all the data** — 2,933 held-out calls aggregated into
>    5 fold totals, then a test run on those 5.
>
> This is [house rule 2](#8--house-rules-earned-not-assumed) one level up: trust
> the spread of the *statistic*, not one draw of it.

**The verdict under the honest test.** Re-run with the paired block bootstrap
over per-call losses, 2,933 held-out calls in 54 session blocks, 2,000 resamples,
fixed seed:

| ladder | per-call diff vs shipped | 95% CI | adopt? |
|---|---|---|---|
| `model+thinking+prevOutput` | **−8.21** | **[−18.38, +2.07]** | ❌ CI includes 0 |
| the same with `<200` merged | −3.62 | [−12.08, +5.36] | ❌ (and not shippable — see below) |

**It does not adopt, and it is not close.** The interval is wide because the
information here is 54 sessions, not 14,663 calls — calls inside one session
share a task, a file and a user, and their errors move together. The old 5-fold
t was pretending to have far more independent information than exists.

The honest summary is neither "−16.4, adoptable" nor "it halved and died": the
effect is **about −8 to −13 pinball/call (~1.5–2%), real in direction, and not
separable from zero at this sample size.** Both earlier readings were single
draws of a broken statistic.

**What that means for the four rejections in [§6.9](#69-re-forecasting-by-loop-depth--mechanism-rejected).**
They stand and get stronger. Previous action, loop depth, previous `stop_reason`,
tool-result size and tool duration all measured at zero on both days, and none of
them was ever near the bar under either test. Only the one positive result was
fragile — the expected asymmetry, since nine candidates were searched and the
best-looking one written up.

**What was built anyway, and why it was worth building:**

- `previousOutputTokens` on the request and on `ForecastObservation`, tri-state
  exactly like `thinkingEnabled`: **omitted means unknown, never "short"**.
  Turn-opening calls have no predecessor and are the *longest* calls in the
  corpus, so filing them under the smallest bucket is the one unsafe direction.
  `0` is a measurement and does select `lt200`.
- `previousOutputBucket()`, exported so the profile builder and the forecaster
  cannot drift apart. Edges `<200` / `200–800` / `800–3k` / `≥3k` — the ones the
  within-cell ratios in §6.9 were measured against.
- The `model+thinking+prevOutput` rung in `HISTORICAL_GROUP_TIERS`, inert until a
  profile actually contains such a group.
- **A self-enforcing gate**, now built on the block bootstrap rather than the
  5-fold t. `eval-claude-code-history.mjs` fits the ladder every run and emits the
  `prevOutput` tier into the profile **only when the 95% CI upper bound is
  strictly below zero** — the same machinery that selects the recency window. If
  the effect ever separates from zero, the next regeneration adopts it with no
  code change and says so on stdout. If it doesn't, nothing ships.
- The eval now joins agent-loop ancestry from `lib/load-history.mjs` rather than
  reconstructing the `parentUuid` walk a second time ([house rule 6](#8--house-rules-earned-not-assumed)),
  at the cost of one extra pass over the transcripts.

> ⚠️ **The merged 3-bucket variant is measured but deliberately not adoptable,
> and that is a correctness constraint rather than a preference.** The eval folds
> `<200` into `200–800` when emitting a profile, while `previousOutputBucket()`
> in the predictor has no merged mode — so a merged profile would fit every
> `<200` call into the `200–800` group and then never select that group for one.
> That is **21.5% of the calls that have a predecessor**, silently mis-routed,
> delivering none of the measured gain. [House rule 7](#8--house-rules-earned-not-assumed)'s
> tie-break can only be applied once both sides express the same bucketing:
> teach `previousOutputBucket()` the merge *first*, then make it adoptable.

**What would change the verdict:** a 95% CI that clears zero. That needs either a
materially larger effect or many more *sessions* — more calls inside the same 54
sessions buys almost nothing.

> 🔁 **Re-read on the evening regeneration of 4 August: −3.70/call, 95% CI
> [−15.10, +8.09]**, on a corpus 1% larger. The point estimate keeps wandering
> between about −4 and −13 and the verdict has not moved once. That is what a
> real-but-unresolvable effect looks like under an honest statistic, and it is
> the contrast with the old 5-fold t — which flipped its *verdict*, not just its
> estimate, on the same data.

### ⚫ 7.2 Build a `Write` detector — priced, then starved of inputs

This is where the remaining prize is, and [§5](#5-where-the-error-actually-lives)
names it precisely.

- The ceiling is **~−90 pinball/call (~17% of shipped loss)**, and it is
  **concentrated**: on the worst 5% of calls, knowing the tool is worth **−29%**.
  *Corrected upward from −49 on 4 August — [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact).*
- **Target `Write` specifically, and the correction now says so quantitatively.**
  3% of calls, **9.8×** over-represented among the worst misses, P50 2,773 vs
  `Read`'s 183. A **binary** "is this a `Write`?" detector is worth **71% of the
  full 7-way ceiling** (median across 12 corpus endpoints, range 62–98%) — it
  captures most of the prize and is a far easier problem than the 7-way
  classifier we built. Until 4 August that "captures most of the prize" was an
  assertion; it is now measured.
- ❌ **Ruled out as inputs:** previous action, loop depth, previous `stop_reason`,
  tool-result size, tool duration. Don't re-try them without a new argument.
- ❌ **And now the prompt too.** [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired)
  measured P(`Write`) by prompt verb class: saying *"write"* moves it from a 3.2%
  base rate to **3.7% — a 1.17× lift** against a target that is 9.8×
  over-represented among the worst misses. The last candidate input is gone.
- Still untried: whether the same tool has fired consecutively; the *content* of
  the last result (an error? empty?) — though result **size** and **error status**
  are both measured and worth nothing on their own.

> ⚫ **Status: correctly specified, correctly priced, and unbuildable.** This is
> the sharpest statement of where the project ended up. We know the prize is
> ~17% of shipped loss, we know a binary detector captures ~71% of it, and we
> have tested every feature this corpus exposes. **None of them can see a `Write`
> coming.** Building the detector is not blocked on effort or on statistics — it
> is blocked on there being no observable that predicts the target.

<a id="-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired"></a>

### 🟡 7.3 Features from the actual prompt — ONE FEATURE ADOPTED; BROAD KILL CONDITION STILL FIRES

*`node experiments/evaluation/probe-prompt-features.mjs`*

> ⚠️ **Status flag, 9 August 2026 (afternoon): `promptPath` is currently OUT
> of the shipped profile.** Its own gate adopted it at −8.66 [−16.59, −2.32]
> in the morning regeneration and refused it at **+7.63 [−9.72, +25.96]** on
> the afternoon corpus (15,374 calls) — the point estimate changed sign as
> ~500 calls arrived. This is the `previousOutputTokens` pattern from §7.1: a
> small effect that is not separable from zero at ~57 session blocks, drawn at
> different endpoints. The eval re-tests it on every regeneration and will
> re-adopt it automatically the day it clears; nothing below is deleted
> because the measurement methodology and the depth-0 finding stand.

**Status: done, with one narrow shipped win.** This was the project's
stated objective and, until 4 August, the one hypothesis no experiment here had
ever tested — all fourteen entries in [§6](#6-the-ledger-everything-weve-tested)
are post-hoc metadata, and none of them looked at a prompt.

> 🔓 **The "needs Phase 3 telemetry" blocker was self-imposed and wrong.** ADR
> 0004 governs what an *observation stores*; [house rule 9](#8--house-rules-earned-not-assumed)
> scopes to *committed artifacts*. Neither restricts what a local pass may read
> from a transcript already on disk and then discard — which is exactly what
> `lib/load-history.mjs` has done with character counts since it was extracted.
> Prompt features are derived inside the loader and the text is dropped there.

**The design point that made it worth running.** The human message is not a
depth-0 feature. Only 8.8% of calls open a turn, so joining prompts to those
alone would leave the feature missing on nine calls in ten. But every call in a
turn descends from one human message, and that message was typed before the
turn's *first* call was issued — so it is strictly pre-call for all of them.
`resolveLoopContext()` already reconstructs that ancestry, so the turn-root
prompt is propagated onto every descendant. The original loader then made one
critical mistake: it treated injected `isMeta` skill rows as human turn
boundaries. They are passthrough context inside the same turn. Fixing that rule
raises prompt coverage from **68.0% to 89.9%**; a regression test now locks the
ancestry behavior. Missing prompts still **skip the rung**; unknown is not a
level.

Features, all strictly pre-call: message length, verb class (write/fix/explain/
read/run, scored by match count so the answer doesn't depend on regex order),
explicit limit (*"in one sentence"*, *"20 examples"*), the opposite marker
(*"exhaustive"*, *"thorough"*), file path mentioned, question vs command, and
number of distinct requirements.

#### The result

| | |
|---|---|
| best ladder vs model+thinking, held out | **`promptPath`: −10.9 pinball/call, 95% CI [−21.9, −0.4] — ADOPTED** |
| R² on log Y, + prompt features | **0.244** *(programme threshold was 0.25)* |
| **kill condition** | 🔴 **FIRES** |

Most prompt ladders remain **worse** than shipped — splitting already-thin
groups thinner costs more than the feature pays. `promptPath` is the exception.
The R² ladder, all rows measured on the same 13,566 calls that carry a prompt:

| feature set | R² | rank |
|---|---|---|
| marginal | 0.000 | 0 |
| model only | 0.025 | 5 |
| model + thinking | 0.192 | 6 |
| + every metadata feature ever tried | 0.237 | 28 |
| **+ prompt features** | **0.244** | 43 |
| *prompt features alone* | *0.007* | *15* |
| + true first tool *(oracle)* | 0.399 | 34 |

**Prompt features buy 0.007 R² over metadata we already rejected.** The feature
ships because it clears the held-out pinball gate, not because the broad R²
programme succeeded.

#### But the null is not flat, and that part matters

Split by how far the call sits from the message it descends from:

| population | n | R² shipped | + prompt | gain | **prompt alone** |
|---|---|---|---|---|---|
| **depth 0** *(turn opener)* | 938 | 0.288 | 0.345 | **+0.057** | **0.219** |
| depth 1–2 | 1,478 | 0.203 | 0.236 | +0.033 | 0.022 |
| depth 3+ | 11,150 | 0.179 | 0.187 | +0.008 | **0.004** |

**The prompt predicts the turn's first reply and has decayed to nothing a few
steps into the loop.** That is a real effect, not a calendar artifact: absorbing
the (day, model) cell first — the regression form of the gate that killed
[`effort`](#67-effort--rejected) — leaves the depth-0 gain at **+0.046**.

**The depth-0 semantic lead still cannot be cashed.** Only **121** prompt-bearing
turn openers land in the holdout, and every depth-0-only ladder—including the
oracle—remains inside the noise. The shipped win is instead the simple
`promptPath` bit evaluated across all descendants of a turn.

> 🧭 **The binding constraint is turns, not calls** — [house rule 10](#8--house-rules-earned-not-assumed)
> arriving from a new direction. The corpus grows by thousands of calls a week
> and that buys almost nothing here, because the thing being estimated is
> indexed by human messages. **This is the one lead worth resuming if the corpus
> ever grows in turns rather than in calls.**

#### And it closes [§7.2](#-72-build-a-write-detector--priced-then-starved-of-inputs) too

| prompt verb class | n | P(`Write`) | lift |
|---|---|---|---|
| write | 2,142 | 3.8% | **1.19×** |
| other | 5,954 | 3.6% | 1.12× |
| fix | 1,281 | 2.8% | 0.88× |
| read | 2,766 | 2.6% | 0.80× |
| run | 980 | 2.4% | 0.76× |
| explain | 443 | 2.0% | 0.63× |

Against a 3.2% base rate, saying *"write"* raises P(`Write`) to 3.8%. That
**1.19×** lift is still tiny next to how much `Write` dominates the misses.
`Write` is 9.8×
over-represented among the worst misses; a 1.18× detector does not touch that.
**The binary `Write` detector [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact)
priced at 71% of the ceiling has no input.** The prize is real and there is
nothing here to reach it with.

### ⚫ 7.4 Quantile regression instead of lookup tables — moot

Once you have 4+ real features, a lookup table over the cross-product runs out of
data fast — exactly the P99 failure we already saw with `input size`. Gradient-
boosted quantile regression handles this; lookup tables can't.

**We never got to 4+ real features.** We got to two. This was always conditional
on [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired)
finding something, and it didn't. A more expressive model class cannot help a
feature set that explains 0.011 of the variance on its own — the bottleneck was
never the functional form.

### 🚫 7.5 Blocked

- **Cap risk.** Zero censored calls out of 15,095. The statistical shortcut is
  **closed** ([§6.10](#610-fitting-the-tail--half-confirmed-half-rejected)).
  Needs Phase 3 execution telemetry with a deliberately low `max_tokens`.
- **Reading `thinking` from the request** rather than inferring it from emitted
  blocks. Worth doing when telemetry lands; buys a rounding error (5.9% error
  rate, [§4.1](#41-thinking-is-the-one-that-paid)).
- **Per-session totals.** ✅ Partially delivered 10 Aug 2026: whole-TURN
  totals now ship ([§6.25](#-625-whole-turn-totals--shipped-coarse-on-purpose),
  `historicalTurnTotalForecast()`). Whole-session totals (N turns, N random)
  remain open and are blocked on the same thing as every turn-indexed
  question: more turns, not more calls.

### ⚫ 7.6 The honest stopping point

**The broad search in §7 is closed, with one narrow correction shipped.**

The 4 August work did two opposite things. It **doubled the measured size of the
prize** — the ceiling is ~17% of shipped loss, not ~8%, and a binary `Write`
detector captures ~71% of it. The corrected prompt join found a smaller,
reachable piece: whether the prompt names a path. It improves reservations but
still does not identify `Write`; the largest part of the ceiling remains
unreachable from the observables tested here.

**What is worth keeping, and why:**

| | |
|---|---|
| **The calibrated 24-row table** | 32% less error than a static guess; path-aware without storing raw prompts. |
| **The `usedFallback` contract** | A caller can always tell whether it got a fitted group or a backoff. |
| **Rolling-origin + paired block bootstrap** | The methodology outlived three separate findings it killed. [House rules 1, 2, 10](#8--house-rules-earned-not-assumed) |
| **`lib/load-history.mjs`** | One definition of "a call", one ancestry walk, one prompt-feature derivation. Two loaders invented two published findings. |
| **`lib/stats.mjs`** | The gates — support, significance, direction — plus the adoption statistic, now shared by the eval *and* the probes so they cannot drift. |
| **This document** | Mostly negative results, which is why it is useful. |

**What it is, described accurately:** *a calibrated reservation heuristic that
knows its own ceiling.* Not a predictor of output length. It reserves a sensible
band for a call given the model, whether thinking is on, and one prompt-path bit;
it tells you when it is guessing and can quantify how much remains unreachable.

**The one thing that would restart it.** Not more calls. The depth-0 prompt
signal in [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired)
is **real** (R² 0.251 alone, surviving the (day, model) gate) and could not be
demonstrated out-of-sample only because 105 turn-openers reached the holdout. The
effective sample for every question in this document is **sessions and turns, not
calls** — so a corpus that is ten times larger in *calls* changes nothing, and one
with a few thousand more *human messages* would settle it. If this is ever picked
back up, that is the single number to check first.

---

## 8. 🧭 House rules (earned, not assumed)

Each of these cost us something to learn.

1. **A change only ships if it BEATS the current one on held-out data**, judged by
   a **paired block bootstrap over per-call losses**: adopt only when the upper
   end of the 95% CI on the mean difference is **strictly below zero**. Not "the
   point estimate is negative", not "a t crossed a line".
   *(From: the 14-day window that "won" by 0.16 — [§6.8](#68-a-recency-window--rejected)
   — and from the 5-fold t that adopted and refused the same effect twenty
   minutes apart — [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused).)*
2. **Trust the spread, not the mean — and check the spread of the spread.** Folds
   vary by ±187 total pinball, so any unpaired "improvement" smaller than that is
   a story about the calendar. An error bar estimated from 5 numbers is itself
   noisy enough to flip a verdict; block-bootstrap the per-call series instead.
3. **Check support before believing a group difference.** Which (day, model) cells
   does the group occupy? Does the effect keep its **direction** across them? Not
   just: is the pooled test significant?
   *(From: `effort`'s fake 4.6× ladder — [§6.7](#67-effort--rejected).)*
4. **Check the clock.** Every input must have finished happening before the
   forecast was due. **If a feature beats the oracle, it is reading the answer.**
   *(From: the timestamp leak — [§6.9](#-a-leak-we-caught-and-how).)*
5. **Unknown ≠ false.** An absent feature must skip its rung, never be filed as a
   level. The unsafe direction is always the one that under-forecasts the tail.
6. **Verify the data assumption before building on it.** Ask "is that field
   reliably where I think it is?" first.
   *(From: the loader bug — [§6.13](#-613-the-loader-bug--a-methodology-note-worth-keeping).)*
7. **Prefer the simpler model when two are tied.** Within one paired SE, take the
   shorter ladder.
8. **Negative results get written up with the same care as positive ones.** This
   document is mostly negative results, and that is why it's useful.
9. **Aggregates only in committed artifacts.** Sample counts, quantiles, and call
   metadata (model, tool name, depth, token counts). **Never prompt or response
   content.**
10. **Don't aggregate away your sample, and block what is correlated.** Testing on
    5 fold totals when you hold out 2,933 calls discards almost all the data and
    leans on an error bar estimated from 5 numbers. Test on the per-call series —
    and resample it in **session blocks**, because calls inside a session share a
    task and their errors move together. The effective sample here is **54
    sessions**, not 14,663 calls, and pretending otherwise is what made a null
    result look adoptable.
    *(From: `previousOutputTokens` reading −3.8 and −1.8 on the same stable
    effect — [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused).)*
11. **Adoption gates belong in the eval, not in a doc.** A rule written only in
    prose is not enforced, and drifts from the code — this document claimed a
    "three consecutive regenerations" bar that had never existed in any script.
    If it is a rule, it runs on every regeneration.
12. **A sample floor is a silent filter, so measure what it filtered.** A rung
    that never fires looks *exactly* like a feature that does not work — and for
    a rare class, the floor bites hardest on the calls you care most about. Every
    ladder now reports **which rung fired**, and every joint `model|thinking|X`
    rung carries a **pooled `X` rung** beneath it, so a thin cell costs coverage
    rather than correctness.
    *(From: the ceiling published at −49 for a month because the oracle could not
    fire on `Write` — [§4.2a](#42a-the-49-ceiling-was-a-sample-floor-artifact).)*
13. **Grade the statistic the same way everywhere.** The adoption test now lives
    in `lib/stats.mjs` and is imported by the eval *and* the probes. A probe
    reporting a 5-fold t while the eval reported a bootstrap CI is how the same
    effect was adopted and refused twenty minutes apart.
14. **Your effective sample is the unit your feature is indexed by.** Calls are
    not the unit. `previousOutputTokens` is indexed by *sessions* (54 of them);
    prompt features are indexed by *turns* (105 in the holdout). Both looked far
    better against a call count than they were. Before believing a feature, ask
    how many independent instances of the *thing it reads* the holdout contains.
    *(From: [§7.1](#-71-previousoutputtokens--implemented-gated-and-currently-refused)
    and [§7.3](#-73-features-from-the-actual-prompt--tested-and-the-kill-condition-fired).)*

---

## 9. 📖 Glossary

| Term | ELI5 |
|---|---|
| **Output tokens** | How much the model wrote back. What we're predicting. |
| **Quantile / percentile** | "X% of the time it's under this number." |
| **Coverage** | Did the forecast keep its promise? P90 should cover 90%. |
| **Pinball loss** | Score that punishes lazy-huge forecasts. Lower = better. |
| **Band width** | $P_{99} - P_{50}$. How vague the forecast is. What §5 is about. |
| **Calibration error** | coverage − target. `+6 pts` = over-covering by 6 points. |
| **Censored / right-censored** | The reply got cut off at `max_tokens`, so we only know it was *at least* that long. Poisons averages if you don't exclude it. |
| **Holdout** | Data hidden from the model during fitting, used to grade it. |
| **Drift** | The world changed between fitting and using. |
| **Backoff ladder** | Try the most specific group → fall back to broader ones → fall back to the static guess. |
| **Overfitting** | Slicing so thin that each bucket is mostly noise. |
| **Log-normal** | A distribution that's bell-shaped *after* you take the log. Common for "durations and lengths". Rejected here — [§6.11](#611-log-normal-quantiles--rejected). |
| **Pre-call feature** | Something you know *before* sending — legal to use. (Model ✅, thinking ✅, stop reason ❌.) |
| **Rolling-origin CV** | Test 5 times, walking the train/test cut forward each time. Gives a spread, not just one number. |
| **Paired comparison** | Compare two options *on the same folds* and look at the per-fold difference. Cancels out "this fortnight was just busier". |
| **Standard error** | How much a mean would wobble if you re-ran the experiment. A difference smaller than ~2 of these is not a result. |
| **Support** | Which (day, model) cells a group actually appears in. `effort=max` had *one*. If two groups never appear in the same cell, comparing them compares the cells, not the groups. |
| **Replication** | Does the effect show up *again* in a different cell, with the same sign? A pooled significant result built from one day has not replicated. |
| **Mixture** | Forecast built as a weighted blend of per-action distributions: $\sum_k \pi_k(x) P(Y \le y \mid A=k)$. Used when the thing that drives output isn't known until after the call. |
| **Oracle** | A cheating forecast that's told the answer (here: the true tool). Useless to ship, invaluable as a **ceiling**. Also a **leak detector**: no legal feature can beat the oracle, so one that does is reading the answer. |
| **Leakage** | Using information that wasn't available when the forecast was due. Our case: the gap between two assistant timestamps contains the time the second call spent generating. |
| **Loop depth** | How many tool-result round-trips this call sits behind the human's message. Depth 0 opens a turn. Reconstructed from `parentUuid`, not timestamp order. |
| **Peaks-over-threshold (POT)** | Model only the values above a threshold, with a generalized Pareto, and use the empirical distribution below it. Gives a smooth tail — and a standard error — instead of one order statistic. |
| **Shape parameter (ξ)** | How heavy the tail is. ξ > 0 is heavy; the mean exists if ξ < 1, the variance if ξ < ½. Ours is ≈ 0.37, so both exist. Relates to the power-law exponent as α = 1/ξ. |
| **Right-truncated fit** | Fitting as if nothing above some *T* had ever been observed, so you can test whether the model predicts the part you hid from it. |

---

## 10. 🗺️ Where the code lives, and how to re-run it

| What | Where |
|---|---|
| Static fallback | `packages/predictor/src/static.ts` |
| Learned predictor + backoff ladder | `packages/predictor/src/historical.ts` |
| Shipped profile (generated — don't hand-edit) | `packages/predictor/src/bundled-profile.ts` |
| Model limits, pricing, snapshot aliases | `packages/model-registry/src/index.ts` |
| The eval that produces all of it | `experiments/evaluation/eval-claude-code-history.mjs` |
| Previous-output bucketing (one definition, both sides) | `previousOutputBucket()` in `packages/predictor/src/historical.ts` |
| Gates that decide whether prompt-path / `prevOutput` ship | `pairedAgainst()` in the eval using `blockBootstrapDifference()`; printed on every run |
| Full results JSON (incl. per-fold CV detail) | `experiments/artifacts/claude-code-history-eval.json` |
| What the main app must pass | README → "Integration contract" |
| **Shared transcript loader** (all probes) | `experiments/evaluation/lib/load-history.mjs` |
| Agent-loop reconstruction (opt-in on that loader) | same file, `{ withLoopContext: true }` |
| **Shared statistical gates** (support, rank test, replication) | `experiments/evaluation/lib/stats.mjs` |

**Re-run the shipped numbers:**

```sh
pnpm build                    # required first: the eval reads the built registry
pnpm evaluate:claude-history
```

Reads `~/.claude/projects`, writes the report, the profile, and the bundled TS.

**Re-run the investigations** — independent of the eval, each writes aggregates
to `experiments/artifacts/`:

```sh
node experiments/evaluation/probe-latent-structure.mjs    # the original six measurements
node experiments/evaluation/probe-effort-confound.mjs     # §6.7  rejected `effort`
node experiments/evaluation/probe-visible-mass.mjs        # Y = H + V; falsified two claims
node experiments/evaluation/probe-action-type.mjs         # §6.12 confirmed action type
node experiments/evaluation/probe-loop-depth.mjs          # §6.9  loop depth & re-forecasting
node experiments/evaluation/probe-tail-fit.mjs            # §6.10 GPD tail, p99 with an SE
node experiments/evaluation/probe-loss-decomposition.mjs  # §5    where the loss actually is
node experiments/evaluation/probe-base-ladder.mjs         # §6.27 does promptPath earn its base rung
```

They are seeded, so bootstrap and placebo figures reproduce exactly over the same
history. ⚠️ **The corpus is live** — it grows every time anyone works in this
repo, so absolute counts drift between runs. Conclusions shouldn't.

**Privacy:** aggregates and call metadata only — sample counts, quantiles, model
names, tool names, loop depths, token counts. **Never prompt or response
content.**

---

## 11. ✅ The eight things to remember

1. **Learning from history beat the static guess by 32%.** Real, held out, across
   5 folds on 15,095 calls.
2. **`thinking` did most of the rest — 2.8× effect, −8% error.** It's shipped.
   **Pass the flag explicitly** or you don't get it. Omitting it means *unknown*,
   not *off*.
3. **It's still a lookup table, now with 24 rows.** It reads one privacy-safe
   prompt bit (`promptPath`), not prompt semantics.
4. **Slicing metadata finer is a dead end, with one prompt-derived exception.**
   `tools`, `input size`, `effort`, previous action, loop depth, previous
   `stop_reason`, tool-result size and tool duration are all deleted or rejected.
   The last one standing, **the previous call's output size**, halved on
   re-measurement and [failed its own gate](#-71-previousoutputtokens--implemented-gated-and-currently-refused).
   The corrected path bit cleared its gate; every other pre-call metadata or
   bag-of-prompt feature remains rejected.
5. **Re-forecasting inside the agent loop is an API convenience, not an accuracy
   win.** Deep calls *are* forecast tighter — but so are they by the shipped
   predictor, which knows nothing about depth. The gain doesn't compound.
6. **The error is not where the band is widest.** P99 is 12% of the loss; **1% of
   calls carry 23% of it**, and they are mostly `Write`. Narrowing the band and
   reducing the error are different jobs — say which one you're doing.
7. **Trust the spread, not the mean.** Folds vary by **±187**. Pair the per-call
   series and block-bootstrap it; require the whole 95% CI below zero.
8. **Check the support, and check the clock.** `effort` looked like a monotone
   4.6× ladder and was two single-day samples. "Elapsed time" looked like the best
   feature ever measured and was the answer leaking through a timestamp — it beat
   the *oracle*, which is the tell.

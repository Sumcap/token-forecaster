# Toward a generative model of output length

> **Status: findings + proposed program. Nothing here is shipped.**
> Companion to [STATE-OF-PLAY.md](./STATE-OF-PLAY.md), which describes the
> predictor we actually ship. This document argues that the current program has
> hit its ceiling for a structural reason, and proposes replacing the empirical
> lookup table with a model of *how the tokens are produced*.
>
> Written: **3 August 2026**. Every number below is reproducible from your own
> transcripts — see [§7](#7-reproducing-all-of-this).

---

## 0. TL;DR

> ## 🛑 Read this first: two of the five findings were a bug in our own loader
>
> **Corrected 3 August 2026.** Claude Code writes **one JSONL row per emitted
> content block**, all sharing a `requestId`, and repeats the call's *total*
> `output_tokens` on every one of them. The probe's loader assumed the opposite
> — that usage *accumulates* — and kept a single row per call. With ties broken
> by `>=` it kept the **first** row, which for a thinking-enabled call is the
> zero-length `thinking` marker.
>
> So it compared **one block's characters** against **the whole call's tokens**.
> That discarded the text and tool blocks of **7,650 of 12,946 calls (59%)**.
>
> §1 and §2 were measuring that bug. §4 was measured on the biased ~37% of calls
> whose retained row happened to hold the `tool_use`. Fixed in
> `experiments/evaluation/lib/load-history.mjs`; every number below is post-fix.
>
> **The shipped predictor is not affected.** `eval-claude-code-history.mjs`
> merges rows correctly (`eval-claude-code-history.mjs:189`) and always did. The
> bug was confined to the analysis written for this document.

| Claim | Verdict | Where |
|---|---|---|
| ~~The corpus barely observes what it's modelling (93% under 1 char/token).~~ | ❌ **FALSIFIED.** Post-fix, visible content predicts billed output at **held-out R² = 0.949**. Prose runs 2.81 chars/token, tool JSON 2.47 — both normal. | [§1](#1-most-of-the-billed-output-is-not-in-the-corpus) |
| ~~The `thinking` flag measures transcript retention, not thinking (60% mislabelled).~~ | ❌ **FALSIFIED.** The real figure is **5.9%**, and median hidden mass on no-thinking calls is **−8 tokens**. The shipped flag is measuring thinking. | [§2](#2-the-thinking-flag-is-detecting-the-wrong-thing) |
| ~~`effort` is already recorded and unused.~~ | ❌ **REJECTED.** Recorded, but the 4.6× separation is a (day, model) artifact that does not replicate. | [§3](#3-effort-is-recorded--and-it-does-not-survive-contact-with-the-confound) |
| **Which tool is called is a 14.8× signal.** | ✅ **CONFIRMED**, and it is the only claim here that survived. Write/Bash = 7.27× *within* (day, model) cells, direction consistent in **19/19** cells. | [§4](#4-action-type-is-a-12-signal--backlog-8-is-underestimated-by-6) |
| **The tail is power-law, α ≈ 2, not log-normal.** | ⚖️ **SPLIT.** Heavy-tailed ✅ — but α ≈ **2.7**, not 2, so the variance is **finite** and §5's "audit the codebase" consequence is void. Extrapolation to unseen caps ❌ **rejected** (3/28). | [§5](#5-the-tail-is-power-law--which-is-why-experiment-a-failed) |
| **Previous output length is a free untested feature.** | ✅ **CONFIRMED and priced: −16.4 ± 4.4 pinball/call vs the shipped predictor** (t=−3.8). The only thing measured in this document's follow-up that beats what ships. | [§5b](#5b-one-free-feature-nobody-has-tested) |

**The thesis, revised.** The original claim was that $Y$ is dominated by an
*unrecorded* latent component. That was the bug. What is actually true is
narrower and more useful: $Y = H + V$ where $V$ is **fully measurable from the
transcript** and $H$ is thinking, which is genuinely hidden — 97.6% of thinking
blocks are stored as zero-length markers. $H$ is **45.5% of $Y$** on
thinking-enabled calls and **≈0** otherwise. That decomposition is real; the
"we can't see what we're modelling" framing was not.

**The one thing worth building.** Action type is worth **92 pinball/call** if
you know it (vs 593 for the marginal — a 15% reduction, larger than `thinking`'s
10%). But the best pre-call classifier captures only **4.9%** of that. The
signal is confirmed and the bottleneck is now precisely located: it is $\pi_k(x)$,
not the components. See [§4.4](#44-does-the-mixture-actually-pay).

> ⚠️ **Updated 3 August 2026 — read the correction with the claim.** That 92 is
> against the **marginal**. Against the **shipped** `model`+`thinking` predictor
> it is **−50.6 ± 7.8**, so about half of it was already captured. The signal is
> still the biggest one available and it is still worth chasing — but it is
> worth ~9%, not 15%. And it is **concentrated**: on the worst 5% of held-out
> calls, knowing the tool cuts the loss by **30%**, and those calls are mostly
> `Write`. Chase a **`Write` detector**, not a 7-way classifier.
> ([STATE-OF-PLAY.md §6.9](./STATE-OF-PLAY.md#69-re-forecasting-by-loop-depth--mechanism-rejected),
> [§5](./STATE-OF-PLAY.md#5-where-the-error-actually-lives))

---

## 1. Most of the billed output is not in the corpus

> **Status: FALSIFIED, 3 August 2026.** This section was measuring the loader
> bug described in §0. Reproduce with
> `node experiments/evaluation/probe-visible-mass.mjs`.

**What was claimed.** Comparing stored characters to billed output tokens gave a
median of 0.00 chars/token and 93.3% of calls under 2.0 — implying the
transcript stored about one thirteenth of what was billed.

**What the numbers are once rows are merged:**

```
                             n       p10    p50    p90   under 2.0
text only, no thinking blk   257     2.29   2.57   2.80     0.4%   <- was 69.4%
tool_use only              4,242     0.95   1.43   2.12    85.3%
has thinking block         8,143     0.23   0.85   1.78    93.9%
all calls                 13,327     0.34   1.16   2.08    88.0%   <- was 93.3%
```

The segment the original argument leaned on hardest — text-only calls with no
thinking block, where nothing *should* be hidden — went from **69.4% unexplained
to 0.4%**, at 2.57 chars/token. That is an entirely ordinary rate for
markdown-and-code prose.

### 1.1 The decomposition, done without the API

§6 step 1 wanted `POST /v1/messages/count_tokens` on 13.7k calls to measure $V$.
It isn't needed. Calls with no thinking block have $H = 0$ by construction, so
they calibrate the rate directly:

$$Y = a + b_{\text{text}}\cdot\text{textChars} + b_{\text{tool}}\cdot\text{toolChars}$$

Fitted on 4,560 no-thinking calls (time-ordered 80%), graded on the held-out 20%:

| | |
|---|---|
| intercept $a$ | **90.2 tokens per call** |
| prose | **2.81 chars/token** (English reference ~4.0) |
| tool-call JSON | **2.47 chars/token** (dense JSON reference ~2.5–3.0) |
| in-sample $R^2$ | 0.9373 |
| **held-out $R^2$** | **0.9486** |

**This fires §8's falsification condition for §1.** The stated kill criterion was
"real counts land within ~20% of billed output". Visible content explains 95% of
the variance in billed output on calls where nothing is hidden, at plausible
tokenization rates. The premise is wrong.

Applying the fitted rates to the whole corpus gives $H = Y - \hat V$:

| segment | n | med $Y$ | med $V$ | med $H$ | $H/Y$ | $H<0$ |
|---|---|---|---|---|---|---|
| has thinking block | 8,146 | 656 | 265 | **273** | **45.5%** | 2.6% |
| no thinking block | 5,187 | 245 | 233 | **−6** | **−2.2%** | 56.9% |
| all calls | 13,333 | 458 | 253 | 97 | 22.3% | 23.7% |

Read the last two columns as the estimator grading itself. On no-thinking calls
$H$ lands at −6 tokens with 56.9% of calls negative — i.e. symmetric noise
around zero, exactly what you see if $H$ is genuinely 0 and you are only
measuring estimation error. On thinking calls $H$ is 273 tokens and only 2.6%
go negative.

**So the hidden component is real, but it is specifically thinking, not a
general failure to record output.** 97.6% of thinking blocks are stored with
zero-length content. That much of the original §1 survives intact.

> ⚠️ **The one thing this cannot rule out.** Fitting the intercept on
> no-thinking calls forces their *mean* $H$ to zero, so a **constant** hidden
> component on every no-thinking call would be absorbed into $a = 90$ tokens and
> is indistinguishable from per-call billing overhead. The *variance* argument is
> not circular — no linear fit of visible content reaches $R^2 = 0.95$ if hidden
> mass varies call to call — but pinning $a$ independently is the one thing
> `count_tokens` would still buy. It is now a nice-to-have, not a blocker.

---

## 2. ~~The `thinking` flag is detecting the wrong thing~~

> **Status: FALSIFIED, 3 August 2026.** Same loader bug as §1. STATE-OF-PLAY
> §6a called the resulting bias *slight*; this section argued it was not. **§6a
> was right and this section was wrong.**

**What was claimed.** 60.1% of calls labelled `thinking=no` carried token mass
visible content couldn't explain, so the shipped contrast was really "transcript
kept the block vs didn't" rather than thinking on vs off.

**What is true post-fix.** Measuring against the estimated $H$ from §1.1 rather
than a raw character ratio:

```
no-thinking calls with H > 4x the typical |H| (26 tokens):  305 of 5,187  (5.9%)
                                          the pre-fix figure was  60.1%
```

And the direction is decisive:

| | median $H$ | p90 $H$ | p99 $H$ |
|---|---|---|---|
| thinking block present (n=8,272) | **264** | 1,708 | 5,463 |
| thinking block absent (n=5,701) | **−8** | 63 | 284 |

A flag that separates 264 tokens of hidden generation from −8 is **detecting
thinking**. The shipped 2.9× is measuring what it says it measures — re-derived
here at **2.88×** on $Y$.

### 2.1 The alternative explanation was the right one

§8 offered a competing hypothesis for the unexplained mass: *"a systematic
per-call billing overhead — check by testing whether the gap scales with content
or is roughly constant."* That is what it was. The fitted intercept is **90.2
tokens on every call**, and once a model includes it, residuals are flat across
content size:

```
visible chars <200      n=1,860   median residual= -23 tokens
visible chars 200-800   n=2,376   median residual=  +2
visible chars 800-3k    n=1,201   median residual=  +5
visible chars >=3k      n=  264   median residual= +31
```

Against calls whose median output is 245 tokens, a flat ~90-token overhead is
enough to make a naive ratio test scream. It was reading a constant as a
mystery.

### 2.2 What this costs the rest of the document

- **Backlog #11 is *not* more urgent than "blocked".** This section's argument
  for promoting it is withdrawn. The inference `block present ⇒ thinking
  enabled` remains sound-in-one-direction, and the reverse error is now measured
  at **5.9%**, not 60% — genuinely slight, as §6a said.
- **The 2.9× needs no renaming.** §9 point 1 is withdrawn.
- **What survives:** thinking really is invisible in the transcript (97.6% of
  blocks are empty), and $H$ really is ~46% of output on those calls. The
  mechanism was right; the accusation against the flag was not.

> 📌 **Two proposals from this section are withdrawn.** It originally argued
> that backlog #11 was urgent, and that `effort` (§3) was "a strictly better
> proxy than block-presence, because it cannot be destroyed by logging". The
> first is withdrawn because the mislabelling is 5.9%, not 60%. The second is
> withdrawn because `effort` was independently rejected in
> [§3](#3-effort-is-recorded--and-it-does-not-survive-contact-with-the-confound)
> — and because a proxy that cannot be estimated stably is not better than a
> mildly noisy one.

---

## 3. `effort` is recorded — and it does not survive contact with the confound

> **Status: RESOLVED, NEGATIVE.** Measured 3 August 2026 by
> `experiments/evaluation/probe-effort-confound.mjs`. The §8 confound was the
> one most likely to bite, and it bit. The factual half of this section stands;
> the inferential half does not.

**What is still true.** `effort` appears as a **top-level field on the assistant
row**, alongside `sessionId` and `isSidechain`. It is a request configuration —
known before the call, no inference required — and it is populated on 52% of the
corpus. The README's implication that this dimension is unavailable was wrong
and has been corrected.

**What is not true** is that it carries usable signal. The raw contrast:

```
effort=low       n=    96   p50=  264   p90=  972   p99= 1,648
effort=medium    n= 2,433   p50=  376   p90=1,598   p99= 5,897
effort=high      n= 4,570   p50=  392   p90=1,635   p99= 6,382
effort=xhigh     n=   109   p50=  824   p90=3,958   p99= 7,893
effort=max       n=    33   p50=1,214   p90=4,110   p99= 5,668
effort=null      n= 6,618   p50=  480   p90=2,228   p99= 7,316
```

Monotone in the median, **4.6× from `low` to `max`**. Every number reproduces.
The inference drawn from them does not.

### 3.1 The window test §8 proposed is too weak to matter

§8 said: *restrict to the date range where effort is non-null and re-compare.*
Doing that changes nothing at all — **every effort-labelled row is already
inside the window**. `effort` first appears 2026-07-17; the corpus runs
2026-07-04 to 2026-08-03; all 7,241 labelled rows fall after the cutoff, and
only 786 `null` rows leak into the window. The test passes trivially and proves
nothing, because the confound is not *between* the window and the past. It is
*inside* the window.

### 3.2 The real confound: each level occupies almost no (day, model) cells

```
level        n  days  models  cells   cells shared w/ high
low         96     1       1      1                      1
medium    2433    11       4     21                     16
high      4570    13       3     27                     --
xhigh      109     2       1      2                      2
max         33     1       1      1                      1
```

**`low` occurs on exactly one day. `max` occurs on exactly one other day.
`xhigh` occurs on two.** And they are pinned to single models: `low` and `xhigh`
are 100% `claude-opus-5`, `max` is 100% `claude-opus-4-8`.

So the headline "4.6× from `low` to `max`" compares *96 opus-5 calls made on 31
July* against *33 opus-4-8 calls made on 28 July*. There is no day on which both
were used, and no model on which both were used. The comparison is a
day-times-model contrast wearing an effort label.

**Calibrating that against noise.** Draw two random (day, model) cells of the
same sizes and take the ratio of their medians. The typical such ratio is 1.33×,
the p90 is 1.98×, and **P(random pair ≥ 4.61×) = 0.020**. Unadjusted that looks
significant — but `low` and `max` were named as the endpoints *because* they were
the extremes of five levels. Correcting for that selection over the 10 ordered
pairs gives p ≈ 0.18. The headline is inside the noise.

### 3.3 Holding day and model fixed

Stratified rank test within each (day, model) cell, versus `high`. `effect` is
P(Y_level > Y_high) within a shared cell, so 0.50 is no difference:

```
level    cells      n   effect       z   within-cell ratio   (naive)
low          1     96    0.441   -1.65               0.81x    0.67x
medium      16  2,011    0.478   -1.95               0.93x    0.96x
xhigh        2    109    0.653   +4.24               2.74x    2.10x
max          1     33    0.571   +0.85               1.88x    3.10x
```

The monotone ladder is gone: `max` (1.88×) now sits *below* `xhigh` (2.74×).
`low` and `max` — the two endpoints of the headline — are both individually
non-significant. `medium` vs `high` is null, confirming the original caveat.

Only `xhigh` clears |z| > 2. Which brings us to the gate the original analysis
never applied.

### 3.4 The gate that kills the survivor: does it replicate?

`xhigh` has two cells. They disagree:

```
2026-07-27  opus-5  n=41  p50=  581   vs high n=91  p50=406   ratio=1.43x  z=1.44
2026-07-26  opus-5  n=68  p50=1,291   vs high n=77  p50=318   ratio=4.06x  z=4.28
```

Cochran's Q on the per-cell log ratios: **Q=6.3, df=1, p=0.012, I²=84%.** The two
cells are not two measurements of one effect; they are measurements of two
different things. The pooled z=4.24 is almost entirely one day. `medium` is
heterogeneous too (Q=29.4, df=15, p=0.014, I²=49%) even though its pooled effect
is null — so the instability is a property of the whole dimension, not of one
sparse level.

### 3.5 Regression, and why its confidence is fictional

For completeness, OLS on log Y with fixed effects, session-clustered SEs.
exp(coef) is the multiplier on the geometric mean versus `high`:

| specification | low | medium | xhigh | max |
|---|---|---|---|---|
| effort only | 0.70× (t=−9.7) | 0.92× (t=−1.2) | 2.12× (t=3.6) | 2.08× (t=8.9) |
| + model FE | 0.74× (t=−6.2) | 0.94× (t=−0.9) | 2.24× (t=3.8) | 1.81× (t=6.2) |
| + day FE | 0.75× (t=−5.5) | 0.93× (t=−1.2) | 1.76× (t=4.5) | 2.30× (t=8.0) |
| + day + model FE | 0.82× (t=−2.6) | 0.96× (t=−0.7) | 1.91× (t=5.5) | 1.82× (t=4.0) |
| same, day-clustered | 0.82× (t=−2.8) | 0.96× (t=−0.6) | 1.91× (t=4.9) | 1.82× (t=3.4) |

Read naively this says the effect survives everything. **Do not read it naively.**
The rank test and the regression agree on the *point estimate* for `max`
(1.88× vs 1.82×) and disagree wildly on the *uncertainty* (z=0.85 vs t=4.0). The
regression is right about the number and wrong about the confidence, because
additive day and model dummies let it identify `max` partly from days and models
where `max` was never used. That precision is supplied by the functional form,
not by data. Where the design has no support, only the within-cell test is
honest.

### 3.6 The contrast we cannot run

The tightest possible control is *the same session with effort changed
mid-conversation* — same task, same repo, same context. Out of **159 sessions
carrying effort labels, 3 changed effort**, and none of those involve `low`,
`xhigh` or `max`. The experiment that would settle this has essentially never
been run.

### 3.7 Verdict

| level | outcome |
|---|---|
| `low` | rejected — within-cell contrast not significant (z=−1.65), 1 cell |
| `medium` | rejected — not significant (z=−1.95) over 16 cells; genuinely null |
| `xhigh` | rejected — significant pooled (z=4.24) but fails replication (p=0.012, I²=84%) |
| `max` | rejected — not significant (z=0.85), 1 cell |

**No level clears all three gates (comparable → significant → replicates).**
`effort` is not shippable on this corpus, and the §6 program should not spend
anything further on it.

> **What would change this.** Nothing observational. The design is the problem,
> not the estimator: `effort` is chosen *in anticipation of task difficulty*, so
> even a perfectly date-and-model-matched contrast conflates the setting with the
> workload it was chosen for. Note that difficulty confounding is not
> disqualifying for a *forecaster* — the predictor needs correlation, not
> causation, and a feature that proxies unobserved difficulty is a good feature.
> The disqualifying part is that the estimate does not replicate across days, so
> there is no stable number to ship. Fixing it needs **interleaving**: vary
> effort within sessions on comparable tasks. Roughly 8–10 sessions alternating
> `high`/`xhigh` would identify the contrast the whole of §3.6 is missing, and
> that is a cheap experiment to run deliberately.

### 3.8 What this costs the rest of the program

- **§2's proposed fix is withdrawn.** §2 argued `effort` is "a strictly better
  proxy than block-presence, because it cannot be destroyed by logging." The
  first half is true and irrelevant: a proxy that cannot be measured stably is
  not better than a mislabelled one. The `thinking` finding in §2 stands on its
  own evidence and does not depend on this.
- **§6 step 1 is unaffected and becomes the whole critical path.** It never
  relied on `effort`; it recovers H = Y − V by measurement. The one thing it
  loses is the validation-against-effort described in step 1's third bullet.
- **§8's own prediction was correct**, which is the encouraging part: the
  falsification table named this confound as most likely to bite, and it did.
  The lesson to carry forward is that *the window test named there was the wrong
  test* — support, not date range, was the thing to check.

---

## 4. Action type is a 12× signal — backlog #8 is underestimated by 6×

> **Status: CONFIRMED, 3 August 2026** — the only claim in this document that
> survived. Reproduce with
> `node experiments/evaluation/probe-action-type.mjs`.
>
> The loader fix roughly **doubled** the measured population (5,143 → 13,975
> classified calls) because tool blocks were previously being discarded. The
> effect got *larger*, and it then passed every gate that rejected `effort`.

Grouping by the first tool the turn calls:

```
Bash          n= 7,317   p50=   377   p90= 1,462   p99=  4,279
Edit          n= 2,420   p50=   634   p90= 2,102   p99=  6,025
Read          n= 1,999   p50=   181   p90= 1,126   p99=  4,280
Write         n=   455   p50= 2,679   p90= 9,856   p99= 24,291
(no-tool)     n= 1,018   p50=   822   p90= 2,429   p99=  6,307
```

**14.8× at the median.** For comparison, the shipped `thinking` dimension is
2.9× and `model` is 1.35×.

### 4.1 It passes the gates that killed `effort`

This is the test §3 failed. Holding (day, model) fixed:

| action | days | cells | within-cell ratio | naive | z | sign agreement | sign p |
|---|---|---|---|---|---|---|---|
| Edit | 27 | 50 | 1.73× | 1.68× | +20.96 | 38/40 | <0.0001 |
| Read | 27 | 54 | 0.50× | 0.48× | −21.43 | 38/40 | <0.0001 |
| **Write** | 27 | 49 | **7.27×** | 7.11× | **+23.78** | **19/19** | <0.0001 |
| (no-tool) | 27 | 60 | 1.92× | 2.18× | +15.00 | 36/37 | <0.0001 |
| ToolSearch | 26 | 45 | — | 1.16× | −1.39 | — | — |
| (other-tool) | 27 | 55 | 1.25× | 1.14× | +2.12 | 15/25 | 0.42 |

Compare the `within-cell` and `naive` columns: **they are nearly identical.**
Where `effort=low` moved from 0.67× to 0.81× once day and model were held fixed,
`Write` moves from 7.11× to 7.27×. Every class appears on all 27 days and in
45–60 cells. There is no confound to remove.

> **A note on the heterogeneity gate.** Cochran's Q rejects homogeneity for
> every class (all p<0.0001, I² 55–84%), which by STEP 0's literal rule would
> reject them. That rule was calibrated on a 2-cell level where heterogeneity
> meant "one day drives everything". With ~50 cells, Q is testing whether the
> effect *size* is constant — a much stiffer question — and rejecting it only
> says magnitudes vary. The question that actually separates a real effect from
> `effort=xhigh` is whether it keeps its **direction**, so the sign test above
> was added. `effort=xhigh` failed both on 2 cells; `Write` is 19/19.
>
> The `(other-tool)` row is the built-in control: a junk catch-all bucket with
> no coherent meaning, and it correctly fails the sign test at **p=0.42** while
> still showing a "significant" z=2.12. That is the test discriminating.

### 4.2 Backlog #8 is underestimated, but not for the reason given

The backlog scores item #8 — "will this turn call a tool?" — at 2×. The signal
isn't *whether* a tool is called (92.7% of calls emit one; nearly constant, the
same degeneracy that killed the `tools` dimension). It's **which** one.

Not knowable before the call, so it enters as a mixture, multiclass:

$$P(Y \le y \mid x) = \sum_{k} \pi_k(x) \, P(Y \le y \mid A = k)$$

### 4.3 $\pi_k(x)$ is predictable — modestly

Multinomial logistic on strictly pre-call features (previous action, previous
`stop_reason`, agent-loop depth, log previous output, model), graded on 5
rolling-origin folds:

| | model | baseline |
|---|---|---|
| log loss | **1.208** | 1.407 (class priors) |
| accuracy | **56.6%** | 47.7% (majority) |

Real, and comfortably above chance — §8's kill condition ("if the best
classifier is near chance") does not fire. But 0.199 nats is not a lot.

### 4.4 Does the mixture actually pay?

Mean pinball per call across the 5 folds, paired:

| | vs marginal | paired SE | t |
|---|---|---|---|
| **mixture** (uses $\hat\pi_k$) | **−4.53** | ±1.75 | −2.59 |
| **oracle** (told the true action) | **−91.99** | ±19.63 | −4.69 |

Against a marginal forecast averaging 593 pinball/call:

- Knowing the action exactly is worth **92 pinball/call — a 15% reduction,
  larger than the shipped `thinking` dimension's 10%.** §4's core claim is
  vindicated: this is the biggest effect in the dataset.
- The classifier captures **4.9%** of it. The mixture's own gain (0.76%) is
  statistically real but operationally negligible.

**This precisely locates the bottleneck.** It is not the component
distributions — those are tight and confirmed. It is $\pi_k(x)$. Better pre-call
features are worth up to 92 pinball/call; better component modelling is worth
almost nothing on top.

> ⚠️ **Baseline caveat.** This compares mixture vs *marginal* (no features at
> all), which is right for testing §4's claim but **wrong for a shipping
> decision** — the shipped predictor already conditions on model and thinking.
> Some of the 92 is already captured there. Before anyone ships a mixture, it
> must be run against the shipped predictor, not the marginal.

---

## 5. The tail is power-law — which is why Experiment A failed

> **Status: TESTED, 3 August 2026 — SPLIT VERDICT.** Reproduce with
> `node experiments/evaluation/probe-tail-fit.mjs`; write-up in
> [STATE-OF-PLAY.md §6.10](./STATE-OF-PLAY.md#610-fitting-the-tail--half-confirmed-half-rejected).
>
> - ✅ **Heavy-tailed, not log-normal.** Confirmed. A generalized-Pareto shape
>   parameter ξ ≈ 0.37 fits, and it is *stable* across every threshold from p75
>   to p97 — far more stable than the Hill estimator this section relies on.
> - ✅ **Consequence 2 delivered.** The p99 now has a standard error.
> - ❌ **Consequence 1 is wrong.** "α < 2 implies infinite variance, worth
>   auditing the codebase for" reads α off the Hill estimator at large *k*, where
>   it is most biased by non-tail data. The GPD fit puts α ≈ 2.7 (ξ ≈ 0.37, 95%
>   CI 0.32–0.42), and a GPD has finite variance for ξ < ½. **The variance is
>   finite. No audit is needed.**
> - ❌ **Consequence 3 is rejected, by the test this section itself proposes.**
>   Fitted right-truncated below *T* and swept across thresholds, the
>   extrapolation lands inside the observed interval in **3 of 28** tests, and
>   the fitted shape swings from −1.45 to +8.19 depending on a threshold we
>   would have to guess. **Cap risk stays blocked.**

Hill estimator on the $k$ largest order statistics:

$$\hat{\alpha}(k) = k \Big/ \sum_{i=1}^{k} \log\frac{y_{(i)}}{y_{(k)}}$$

```
k=  50   α=2.61
k= 100   α=2.13
k= 200   α=2.24
k= 500   α=2.06
k=1000   α=1.85     (infinite variance)
```

So $P(Y > y) \sim C y^{-\alpha}$ with $\alpha \approx 2$.

**This retroactively explains Experiment A precisely.** STATE-OF-PLAY §5 records
that the log-normal fit was a tie overall but understated the Opus 5 p99 by 38%,
and concludes "Opus 5's tail is fatter than log-normal allows". That's the right
observation with the wrong scope: a log-normal has *all* moments finite, so no
log-normal can ever match a power-law tail. The failure wasn't Opus-5-specific,
it was where the log-normal's thinner tail first got caught.

Three consequences that matter more than the fit quality:

1. **α < 2 implies infinite theoretical variance.** The sample mean of output
   tokens does not converge. Any statistic built on means or standard
   deviations of $Y$ — not $\log Y$ — is unstable no matter how much data we
   collect. Worth auditing the codebase for.

2. **The empirical p99 is fragile.** It's read off ~137 order statistics from a
   distribution with no stable second moment. We have no standard error on it
   today. A fitted tail gives one.

3. **🔓 It unblocks cap risk, which backlog #12 calls impossible.** The current
   position is: zero censored calls out of 14,037, so $P(\text{hit max\_tokens})$
   cannot be fitted. True for an empirical estimator. But a fitted tail gives
   $P(Y > \texttt{max\_tokens})$ by extrapolation — and, crucially, the
   extrapolation is **testable on data we already have**. Fit the tail on
   $y < 2{,}000$, predict $P(Y > 4{,}000)$ and $P(Y > 8{,}000)$, and check
   against the observed counts. If it holds at thresholds we can see, it earns
   the right to be extrapolated to one we can't.

> ⚠️ **Caveat.** $\hat\alpha$ drifts from 2.61 to 1.85 across $k$ with no clean
> plateau, which is the usual Hill-estimator bias–variance tradeoff and means
> "α ≈ 2" is a shape claim, not a precise value. Before relying on it: build a
> Hill plot, and cross-check with a Pickands or generalized-Pareto (POT) fit
> above a chosen threshold. The *shape* conclusion (heavy-tailed, not
> log-normal) is robust across every $k$; the exponent is not.

---

## 5b. One free feature nobody has tested

Previous output length in the same session, which needs no telemetry and no
prompt access:

```
corr(log Y_prev, log Y_next) = 0.152    n=13,475 pairs, SE ~0.009

prev<200        n=2,955   p50=367   p90=1,739   p99= 6,392
prev 200-800    n=6,641   p50=399   p90=1,509   p99= 5,278
prev 800-3k     n=3,190   p50=577   p90=2,500   p99= 7,138
prev>=3k        n=  689   p50=625   p90=4,623   p99=15,685
```

The correlation is modest (t ≈ 18, so real but not large). The interesting part
is that it concentrates **in the tail**: 2.5× p99 separation between the extreme
buckets versus only 1.7× at the median. Sessions have long-output regimes. This
is a natural input to $\pi_k(x)$ in §4 rather than a standalone rung.

---

## 6. The proposed program

> ## 📊 Program status, 3 August 2026
>
> | Step | Status |
> |---|---|
> | 1 — make the latent variable observed | ✅ **Done, locally, for free.** See [§1.1](#11-the-decomposition-done-without-the-api). It falsified its own premise: $V$ is measurable from the transcript and $H$ is ~46% of $Y$ only on thinking calls. The 13.7k `count_tokens` spend is **not needed**. |
> | 2 — fit the tail properly | ⏳ Untouched. Now the highest-value remaining item. |
> | 3 — mixture over action type | ⚠️ **Built and measured.** Works, pays 0.76%. Bottleneck is $\pi_k$, not the components — see [§4.4](#44-does-the-mixture-actually-pay). |
> | 4 — quantile regression | ⏳ Untouched, and its stated rationale changed: it was to be run "on $H$ and $V$ separately". That is now possible, since both are measured. |
>
> The steps below are the *original* proposal, kept for the record.

### Step 1 — Make the latent variable observed

Decompose each call:

$$Y = H + V, \qquad V = \underbrace{\text{tok}(\text{text})}_{\text{prose}} + \underbrace{\textstyle\sum_j \text{tok}(\text{args}_j)}_{\text{tool calls}}$$

$V$ is measurable today: tokenize the stored content with
`POST /v1/messages/count_tokens` (the `@token-forecaster/anthropic` adapter
already wraps it). Then $H = Y - V$ is the hidden/thinking component, recovered
**per call across the whole corpus** rather than inferred from a flag.

This is the highest-leverage step because everything else depends on it:

- It replaces the broken `thinking` binary (§2) with a measured quantity.
- ~~It lets `effort` (§3) be validated against what it actually controls.~~
  Dropped — §3 is rejected. This step is now the only live route to a usable
  hidden-component signal, which makes it the whole critical path.
- $H$ and $V$ have different distributions and different drivers — $V$ is
  largely determined by action type (§4) — so modelling them separately is both
  more accurate and more interpretable than modelling $Y$. What drives $H$ is
  now an open question rather than "effort", and answering it is a deliverable
  of this step rather than an assumption going in.

Cost note: 13.7k `count_tokens` calls. Batch them, cache by content hash, and
respect the privacy rule — content goes to the counting endpoint and the
*count* is retained, never the text.

### Step 2 — Fit the tail properly

Peaks-over-threshold: choose $u$, fit a generalized Pareto to $Y - u \mid Y > u$,
and use it for every quantile above ~p95 while keeping empirical quantiles
below. Deliverables: a p99 **with a standard error**, a p99.9 we currently
cannot produce at all, and cap risk validated as described in §5.

### Step 3 — Mixture over action type

Fit $\pi_k(x)$ by multinomial logistic regression on pre-call features (last
tool result type, loop depth, session lag), take the component distributions
from §4, and invert the mixture CDF numerically for quantiles.

`effort` was in that feature list and is struck from it. Note the asymmetry
though: $\pi_k$ needs *correlation*, not causation, so §3's rejection does not
automatically disqualify it here — what disqualifies it is that the estimate
does not replicate across days, so there is nothing stable to fit. If it is
readmitted, the bar is out-of-sample classification gain on days it was not
fitted on.

### Step 4 — Only then, quantile regression

Backlog #10 proposes gradient-boosted quantile regression. It's the right tool,
but running it on today's features would learn the same mislabelled `thinking`
contrast. It belongs after steps 1–3, on $H$ and $V$ separately, with the
mixture handling action type.

### Optional — the hazard framing

If a cleaner unification is wanted: model generation as discrete-time survival,
$h(t) = P(\text{stop at } t \mid \text{reached } t)$, giving
$S(t) = \prod_{s \le t}\big(1 - h(s)\big)$. Quantiles come from inverting $S$;
right-censoring at `max_tokens` is handled natively rather than by exclusion;
covariates enter through the hazard. This subsumes steps 2 and 3 but is a
larger build — worth it only if censored data eventually arrives.

---

## 6b. Killing "vs static" — grade against the outputs

Three quantiles scored against a fixed baseline can't show *where* a forecast is
wrong. Replace the headline with instruments that read the actual held-out
outputs:

**1. PIT histogram (the primary diagnostic).** For each held-out call compute
$u_i = \hat{F}(y_i)$. If the forecast distribution is correct, $u_i \sim
\mathrm{Uniform}(0,1)$. The *shape* of the histogram names the failure:

| Shape | Meaning |
|---|---|
| Flat | Calibrated ✅ |
| U-shaped | Forecast too narrow — real outputs keep landing outside it |
| Hump in the middle | Too wide — over-hedging, wasting reserved context |
| Skewed left/right | Biased in that direction |

This needs a full predictive CDF, not three quantiles — which is itself an
argument for §6's parametric components.

**2. CRPS, in tokens.** $\int_0^1 \text{pinball}_p \, dp$ — the whole
distribution scored as one number, in units you can reason about, with no
baseline needed.

**3. Reliability curve over ~19 levels** (p05…p95), not 3. Plot nominal against
empirical coverage. The current 3-point coverage table is a 3-pixel version of
this plot.

**4. Worst-miss table.** The actual held-out calls with the largest pinball
contribution — model, effort, first tool, forecast, actual. Individual failures,
not aggregates. This is what "see errors from the actual outputs" means
concretely, and it's how the §4 finding would have surfaced a month ago.

Keep total pinball as the ranking scalar for continuity with existing results.
Drop the "vs static" *column*.

---

## 7. Reproducing all of this

```sh
# §1-§5b: the original measurements (now post-loader-fix)
node experiments/evaluation/probe-latent-structure.mjs \
  --json experiments/artifacts/latent-structure-probe.json

# §3: the confound test that rejected `effort`
node experiments/evaluation/probe-effort-confound.mjs \
  --json experiments/artifacts/effort-confound-probe.json

# §1, §2: the Y = H + V decomposition that falsified both
node experiments/evaluation/probe-visible-mass.mjs \
  --json experiments/artifacts/visible-mass-probe.json

# §4: the gates, the classifier, and the mixture payoff
node experiments/evaluation/probe-action-type.mjs \
  --json experiments/artifacts/action-type-probe.json
```

All four read `~/.claude/projects` and share one population definition
(`experiments/evaluation/lib/load-history.mjs`) and one set of statistics
(`lib/stats.mjs`), so no probe can quietly apply a weaker standard than the one
that rejected `effort`. Privacy: counts, quantiles and ratios only — character
counts are computed and discarded, no text is retained or written.

The probes are seeded, so placebo and bootstrap figures reproduce exactly on a
re-run over the same history.

Numbers in this document are from runs on 3 August 2026 over ~430 transcripts /
~14.0k unique API calls, all **after** the loader fix described in §0. They will
drift with your own history.

---

## 8. What would falsify this

Stated up front so the program can be killed cheaply if it's wrong:

| Claim | Falsified if |
|---|---|
| ~~Output is mostly hidden (§1)~~ | ✅ **FALSIFIED.** The condition was "stored content lands within ~20% of billed output". Held-out R² = 0.949 at 2.81/2.47 chars per token. The gap was a loader bug, not a tokenizer artifact. |
| ~~`thinking` is mislabelled (§2)~~ | ✅ **FALSIFIED, by the exact alternative this row named.** It *was* "a systematic per-call billing overhead" — 90.2 tokens — and the gap is roughly constant, as the prescribed check predicted. |
| ~~`effort` carries signal (§3)~~ | ✅ **FALSIFIED, 3 Aug 2026.** Confounded not with the date *range* but with the (day, model) *support*: `low` and `max` each occupy one day and one model, with no overlap. Within shared cells the ladder collapses and the only significant level (`xhigh`) fails a replication test at I²=84%. See [§3](#3-effort-is-recorded--and-it-does-not-survive-contact-with-the-confound). |
| Action type is 12× (§4) | ⚠️ **HALF-FIRED, and this row called it.** The effect survives conditioning decisively (7.27× within cells, 19/19 sign agreement). $\pi_k(x)$ is not *near chance* — 56.6% vs 47.7% — so the mixture does not collapse entirely, but it captures only **4.9%** of the oracle's 92 pinball/call. Buys 0.76%. |
| Tail is power-law (§5) | A generalized-Pareto fit is rejected, or the extrapolation test in §5 fails at observable thresholds. |

The §3 confound is the one most likely to bite, and it's cheap to check first.

---

## 9. Where this leaves the shipped predictor

Nothing here says the current predictor is broken as a *reservation hint* — it
beats the static guess by 43% and that result stands. What it says is:

1. ~~The 2.9× thinking result should be **renamed**.~~ **Withdrawn.** It measures
   what it says it measures; the mislabelling rate is 5.9%, not 60%. See §2.
2. The README claim that `outputEffort` is unpopulated was **wrong** and has been
   corrected — but the correction now reads "populated, measured, and rejected"
   rather than "free win available". See §3.
3. ~~"Slicing metadata is exhausted" is false in general — `effort` and action
   type were both sitting in the transcripts unread.~~ **Partly retracted.**
   `effort` was unread and produced nothing. **Action type was the real one**
   (§4) — worth 92 pinball/call to an oracle, larger than any shipped dimension.
   But it is not *slicing metadata*: it is unknowable pre-call, so it needs a
   classifier, and the classifier is where the value is currently lost.
   STATE-OF-PLAY §9.4 stands.

## 10. Scoreboard

| # | Claim | Verdict |
|---|---|---|
| §1 | Output is mostly unobserved | ❌ Falsified — loader bug |
| §2 | `thinking` is mislabelled | ❌ Falsified — loader bug; the flag is correct |
| §3 | `effort` carries signal | ❌ Rejected — (day, model) artifact |
| §4 | Action type is the biggest signal | ✅ **Confirmed, and bigger than we said** — ~**−90** (~17%) against what ships, not 50 |
| §5 | Tail is power-law, not log-normal | ⚖️ **Split** — heavy tail confirmed, infinite variance wrong, extrapolation rejected |
| §5b | Previous output length is a free feature | ⚖️ **Real in direction, not separable from zero** — −8 to −13/call, 95% CI includes 0 |

**All five claims tested; one and a half survived.**

> **Added 3 August 2026, and corrected 4 August.** Two corrections that matter
> more than the verdicts:
>
> - **§4's 92 pinball/call was measured against the marginal**, as §4.4's own
>   caveat warned. ~~Re-measured against the shipped `model`+`thinking`
>   predictor, the same oracle is worth −50.6 ± 7.8.~~ **That re-measurement was
>   itself wrong, in the opposite direction.** The oracle it used was a single
>   joint `model|thinking|action` rung at a 100-sample floor, which cannot fire
>   on `Write` — 3% of the corpus, one of six cells clears the floor, and that
>   cell is a model leaving the workload. So the "ceiling" was measured with the
>   oracle switched off on ~68% of `Write` calls. With a pooled `action=` rung
>   added below the joint one, the ceiling against the shipped predictor is
>   **~−90 pinball/call, ~17%** (median over 12 corpus endpoints; range −50 to
>   −126). **Quote −90/−17%, not −50/−9% and not −92/−15%.** Evidence:
>   [STATE-OF-PLAY.md §4.2a](./STATE-OF-PLAY.md#42a-the-49-ceiling-was-a-sample-floor-artifact).
>   §4's own 92-against-the-marginal, and §12's −112.6 mixture oracle, are the
>   two figures this correction leaves standing — neither had a joint rung to
>   suppress.
> - **§5b was the sleeper — and then it was refused.** It is one paragraph,
>   marked "one free feature nobody has tested", and it was the only thing
>   measured on 3 August that beat the shipped predictor. On 4 August the
>   *statistic* that said so was found to be broken: under a paired block
>   bootstrap over per-call losses in session blocks, it reads **−8.2/call, 95%
>   CI [−18.4, +2.1]** — real in direction, not separable from zero on a sample
>   that is 54 sessions rather than 14,663 calls. Built, gated, switched off.
>   Meanwhile the loop-structure features it was supposed to
>   feed — previous action, loop depth, previous `stop_reason` — are worth
>   nothing at all under either statistic. See
>   [STATE-OF-PLAY.md §6.9](./STATE-OF-PLAY.md#69-re-forecasting-by-loop-depth--mechanism-rejected). The document's central thesis —
that $Y$ hides a large unrecorded component we must model — was mostly our own
bug. What replaced it is narrower and more actionable: the biggest available
signal is *which action the turn takes*, it is real and unconfounded, and the
entire difficulty is predicting it before the call.

**The most valuable thing here turned out to be §8.** Every rejection above was
caught by a falsification condition written *before* the measurement, and two of
them (§2's "per-call billing overhead", §4's "$\pi_k$ turns out unpredictable")
named the eventual failure mode almost exactly. The document was wrong about
most things and right about how to find out.

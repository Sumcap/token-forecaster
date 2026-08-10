# Follow-up prompt — the cold-start audit is done; guard what shipped

> **Paste this into a fresh session.** Written 9 August 2026 (evening), after
> the cold-start audit session. The previous version of this file is archived
> at `docs/archive/NEXT-PROMPT-2026-08-09.md`; its five tasks are all resolved
> and folded into STATE-OF-PLAY §6.18–§6.22 and the §7.3 status flag.

---

You are picking up the output-token forecaster in this repo. The 9 August
audit finished the fresh-eyes pass: every assumption it targeted is now
measured, one thing shipped, and four doors are closed. Read the results
before inventing work — most of what looks open is closed.

## Read first, in this order

1. `docs/STATE-OF-PLAY.md` — the new header block (afternoon 9 Aug), then
   §6.18–§6.22 (the audit results), §7.3's status flag, §8 house rules.
   **Do not re-propose anything in §6 without qualitatively new evidence.**
2. `docs/BACKLOG.md` — the ⚠️ PORT NOTE at the top of Phase 3 still governs.
3. `README.md` — the integration contract, updated for the new fallback rows.

## What the 9 August session established (all gated, all in artifacts)

1. **Shipped: the pooled `thinking=yes|no` tier + pooled-rung reorder.** An
   unknown-model caller (`usedFallback: true`) that declares `thinkingEnabled`
   now gets thinking-conditioned quantiles instead of the `overall` blend:
   −43.2/call [−65.4, −21.3] leave-one-model-out, metric-robust under every
   reservation variant. The gate lives in `eval-claude-code-history.mjs` and
   re-runs each regeneration. Predictor change: `["thinking"]`-family rungs
   now outrank pooled `["promptPath"]` (−55/call for fallback callers, zero
   in-profile changes). `probe-cold-start.mjs` has the evidence.
2. **`promptPath` fell out of the profile on its own gate** (+7.63
   [−9.72, +25.96] at the 15,374-call endpoint, after −8.66 [−16.59, −2.32]
   that same morning). It is endpoint-sensitive like `previousOutputTokens`.
   Nothing to do — the eval re-adopts it automatically if it re-clears. Do
   not hand-restore it.
3. **The P50/P90 over-coverage mechanism is within-group workload drift**
   (fitted P50 overshoots the present ~25%; corpus P50 by fortnight
   510→429→345). Estimator is unbiased. Split-conformal on the trailing slice
   REFUSED (one variant provably worse); exponential decay directionally right
   at every half-life but never separable from zero. `probe-calibration.mjs`.
4. **Total pinball survived its audit as the score.** Both standing adoptions
   pass under every reservation metric (`L_k = waste + k·excess`, k=1…49, and
   per-quantile pinball). Divergence found: recency-family candidates become
   provably worse at k≥19 — §6.8's rejection is strengthened. Product-terms
   calibration: p90 reservation overflows 7.9% (promise ≤10%), p99 0.9%
   (promise ≤1%). `probe-reservation-metric.mjs`.
5. **Closed permanently:** the static action-type mixture (§6.21 — every
   variant provably worse, band widens) and `maxTokens` as a signal (§6.22 —
   transcripts never record it; zero support corpus-wide).

## Standing decisions (unchanged)

- **The predictor must be excellent cold** (9 Aug). Telemetry is
  production-optional, wired only at the sheep-manager port, never
  load-bearing. Clarification (user, 9 Aug evening): sheep-manager machines
  WILL have request context — it composes the calls, so prompt and agent-loop
  state are available and the bundled boosted correction can fire there.
  "Cold" means no local history corpus, opt-in-only telemetry, and often a
  model the bundled profile has never seen. That fallback path is the product
  surface graded on every regeneration (the eval prints the LOMO report).
- The corpus is a **rolling ~30-day window** of one user and it is **live** —
  it grows while you work, and this repo's own development sessions feed it.
  Point estimates move ±10/call between mornings and afternoons; only paired
  CIs mean anything. Freeze comparisons with `--as-of` (now supported by the
  new probes) when you need two runs to grade the same exam.

## Tasks, in priority order

### TASK 1 — Drift-guard the shipped coverage promise

§6.19 found monotone within-group drift and refused every cold fix at today's
session count. What remains unanswered: **how bad can the coverage promise get
before something must ship anyway?** Add to the eval (house rule 11) a
per-regeneration drift report: fitted-vs-holdout quantile ratio per group and
the product-terms overflow/waste rates (the §6.20 numbers). If p90 overflow
ever exceeds the 10% promise — drift currently errs in the safe direction,
but it has flipped sign in this corpus's history — the decay ladder
(`probe-calibration.mjs` part C, best CI [−4.91, +0.28] at 7d) is the
candidate to re-gate first; it may separate as sessions accumulate.

### TASK 2 — Re-examine the boosted correction's context-free complement

The boosted correction only fires with complete agent-loop context.
Sheep-manager will have that context (it composes the calls — see the
clarification above), so this is NOT blocking for the primary port; it serves
other integrations that cannot track loop state, and turn-opening calls where
no loop exists yet. The untested question: does a *context-free* subset of
the boost's 36 features (model, thinking, prompt aggregates alone — no loop
state) clear a gate as a second correction stage? `lib/quantile-boost.mjs`
already trains on whatever features you give it; mask the loop features to
−1/absent and gate the result against the base ladder. A null closes it.
Watch house rule 14: prompt-conditioned effects are indexed by turns (~120 in
holdout), so expect wide CIs.

### TASK 3 — Session accumulation check on the two refused near-misses

`previousOutputTokens` (§7.1) and the 7-day decay ladder (§6.19) are both
"real in direction, not separable at ~57 session blocks". The corpus gains
session blocks as days pass even though calls roll off. Once the eval reports
>70 session blocks in the holdout, re-read their auto-retested gates before
starting anything new — either adopting itself would be worth more than a new
feature hunt.

### Housekeeping (only if a task lands, or time remains)

- `buildHistoricalProfile()` still materialises `prevOutput` groups ungated —
  the gate lives only in the eval (flagged 4 August, still true; now also true
  of nothing else — `thinking` groups are legitimately ungated there since the
  ladder always carried the rung).
- `probe-action-type.mjs` only writes JSON with `--json`;
  `probe-latent-structure.mjs` writes none.
- STATE-OF-PLAY's TL;DR table and §3 group table still show 5-August single
  -split numbers; the header supersession covers them, but a full refresh
  would help the next reader.

## Closed doors — do not reopen without new evidence

Everything in the 5-August list, plus: static action-type mixtures in any
weighting (§6.21), `maxTokens` as a corpus-measurable signal (§6.22),
split-conformal recalibration on a trailing slice (§6.19), hard recency
windows (§6.8, now also worse under the product metric), and the broad
prompt-feature ladder. The `Write` ceiling (~17% of shipped loss) remains
real and remains unreachable without the caller-declared intent signal that
arrives with the sheep-manager port.

## Rules of engagement

- House rules in STATE-OF-PLAY §8 are binding; adoption needs the 95% paired
  session-block bootstrap CI upper bound strictly below zero on held-out data.
- Rebuild before evaluating: `pnpm build && pnpm evaluate:claude-history`
  (this now runs the cold-start LOMO gate and re-attaches the boosted
  correction automatically).
- Probes live in `experiments/evaluation/`; artifacts in
  `experiments/artifacts/`. The 9-Aug probes accept `--as-of` to freeze the
  live corpus.
- Negative results get written up with the same care as positive ones.

## Deliverables

1. Code + probes for whatever you tested, graded with the shared statistic.
2. STATE-OF-PLAY updated with supersession notes.
3. A regenerated profile *only* if something passed its gate.
4. Rewrite this file for the session after you.

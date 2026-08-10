# Follow-up prompt — re-evaluate the output-token forecast with fresh eyes

> **Paste this into a fresh session.** Written 9 August 2026, right after the
> corpus refresh and the cold-start decision below. The previous version of
> this file (5 August) is archived at
> `docs/archive/NEXT-PROMPT-2026-08-05.md`; its conclusions are folded into
> STATE-OF-PLAY §4.2a, §7.3 and §7.6.

---

You are picking up the output-token forecaster in this repo. Your job this
session: **audit what we might have missed when projecting future output
tokens — as an adversarial fresh-eyes reviewer, not as a feature miner.** The
broad feature search is closed (STATE-OF-PLAY §7.6); what has *never* been
audited is the set of assumptions underneath it, and the paths that were never
the graded target. Start there.

## Read first, in this order

1. `docs/STATE-OF-PLAY.md` — the TL;DR, §5 (where the error lives), §6 (the
   ledger of everything tested and rejected), §7 (what is open), §8 (house
   rules). **Do not re-propose anything in §6 without qualitatively new
   evidence.**
2. `docs/BACKLOG.md` — including the ⚠️ PORT NOTE at the top of Phase 3.
3. `README.md` — the integration contract callers actually see.

## The standing decision that reframes everything (9 August 2026)

**The predictor must be excellent cold.** It will ship inside sheep-manager and
run locally on machines that have *no* telemetry, *no* local history corpus,
and often *no* agent-loop context. Telemetry stays production-optional (wired
only at the sheep-manager port — see the BACKLOG port note) and **must never be
load-bearing**. The boosted correction and every context-hungry rung are
bonuses that activate when context exists; the product lives or dies on the
**zero-context path**, and that path has never been the thing we optimized or
even reported separately.

## Where the numbers stand (eval regenerated 9 August 2026)

- Corpus: 14,872 calls / 302 sessions / 420 transcript files, still one user.
  **The corpus is a rolling window** — Claude Code prunes transcripts after
  ~30 days, so it shrank vs 6 August despite three new days. Waiting does not
  grow it.
- Rolling-origin: ladder 511.8 → boosted 495.5 pinball/call, diff −16.2
  (~3.2%), 95% paired session-block CI [−21.5, −11.3]. Adopted.
- Coverage (rolling, boosted): P50 **57.0%**, P90 91.6%, P99 99.1%.
- `promptPath` re-cleared its gate (−8.66 [−16.59, −2.32]);
  `previousOutputTokens` was auto-retried and refused again (CI touches 0).
- Absolute losses are **not comparable** to the 671→650 figures in older prose:
  the rolling window changed the exam. Some doc numbers are stale (see
  Deliverables).

## Tasks, in priority order

### TASK 1 — Grade the cold-start path as a first-class citizen

Simulate the caller sheep-manager will actually be on day one, and score the
shipped profile with **only** the fields such a caller has:

- (a) `{model, maxTokens}` alone;
- (b) `{model, maxTokens, thinkingEnabled}`;
- (c) each of those for a model **not** in the profile (`usedFallback: true` —
  the `overall` blend).

Report loss, coverage, and band width for each tier **separately**, next to
the full-context path, in the same rolling-origin harness. Questions that have
never been answered: Is the `overall` fallback actually calibrated, or merely
labelled `low` confidence? How much of the shipped headline is earned by rungs
a cold caller can never reach? If tier (a) or (c) is badly calibrated, fixing
*that* is worth more to the product than any further boosted gain. Consider
whether the eval should report these tiers on every regeneration (house rule
11: gates and reports live in the eval, not in prose).

### TASK 2 — Chase the P50 miscalibration and the coverage drift nobody chased

P50 coverage is 57% against a 50% target — the medians run systematically
high — and the 4 August snapshot recorded P90 coverage drifting 90.2 → 88.6 →
87.4% monotonically with an explicit note that nobody had chased it. Find the
mechanism, not just the number: quantile estimator bias in small groups?
clamping interactions with `maxTokens`? session-mix shift inside the rolling
window? Then evaluate the cheapest fix that works cold: a per-group or
per-model **split-conformal / additive recalibration layer** on top of the
ladder — untested here, data-cheap, needs no caller context, and directly
targets the product promise ("90% of outputs land under p90"). Gate it like
everything else.

### TASK 3 — Audit the target itself

Total pinball summed over p50/p90/p99 has been the score since Baseline 0.
Nobody has checked it is the *product's* loss. The product use is a
**reservation**: over-reserving wastes context budget; under-reserving
overflows a window or a cap. Define the reservation-oriented metric (e.g.
expected wasted-reservation tokens at p90 + overflow rate), re-score the
shipped ladder and the boosted variant under it, and check whether any past
adopt/reject verdict in §6/§7 **flips**. If pinball and the product metric
agree everywhere, write that down and close the question; if they diverge,
that divergence is the most important finding available this session.

### TASK 4 — `maxTokens` as a *signal*, not just a clamp

Callers choose `max_tokens`, and they may choose it larger when they expect
longer output. It is pre-call, cold-start-available, and — check the ledger —
it was only ever used as a clamp, never tested as a conditioning feature.
Beware the confound before believing anything: agentic harnesses often pin it
to a constant, so first measure its support and variance per (day, model) cell
(house rule 3), and remember the effective sample is the unit the feature is
indexed by — likely *workloads*, not calls (house rule 14). A null here is
fine; an untested obvious signal is not.

### TASK 5 — A static action-type mixture for the tail

§6.12 measured the action-type mixture at −112.6/call against the marginal
**with oracle weights** and shipped nothing because weights aren't knowable
pre-call. The untested middle ground: **unconditional (or model|thinking-
conditioned) static mixture weights** — pure corpus priors, no per-user data,
fully cold-start. The question is narrow: does blending per-action tails with
fixed priors buy a narrower P99−P50 band at equal coverage vs the pooled
empirical tail? If not, close §6.12 permanently with that number.

### Housekeeping (do these only if a task above lands, or time remains)

- `buildHistoricalProfile()` still materialises `prevOutput` groups ungated —
  the gate lives only in the eval (flagged 4 August, still true).
- `probe-action-type.mjs` only writes JSON with `--json`;
  `probe-latent-structure.mjs` writes none.
- Refresh stale prose numbers (README "Status"/forecast example, STATE-OF-PLAY
  header) to the 9 August eval, keeping the supersession style.

## Closed doors — do not reopen without new evidence

Input size, tool count, `effort`, recency windows, log-normal quantiles, the
loop-depth re-forecast mechanism, the broad prompt-feature ladder (kill
condition fired: combined R² 0.244 < 0.25), semantic `Write` detection (0.584
AUC), and `previousOutputTokens` (the eval auto-retests it every regeneration;
it will adopt itself the day it passes). The `Write`/long-artifact ceiling
(~17% of shipped loss) is real but unreachable without a caller-declared
intent signal, which arrives only with the sheep-manager port + telemetry —
**do not** try to conjure it from the corpus again.

## Rules of engagement

- House rules in STATE-OF-PLAY §8 are binding. In particular: adoption needs
  the upper end of the 95% paired **session-block** bootstrap CI strictly
  below zero on held-out data (rule 1/10); unknown ≠ false (rule 5); every
  input must be knowable before the call (rule 4); grade with the shared
  statistic in `lib/stats.mjs` (rule 13).
- Rebuild before evaluating: `pnpm build && pnpm evaluate:claude-history`.
  Probes live in `experiments/evaluation/`; artifacts in
  `experiments/artifacts/`.
- Negative results get written up with the same care as positive ones.

## Deliverables

1. Code + probes for whatever you tested, graded with the shared statistic.
2. STATE-OF-PLAY updated: new sections for what you found, supersession notes
   on anything you refuted, stale numbers refreshed.
3. A regenerated profile *only* if something passed its gate.
4. Rewrite this file for the session after you: what you found, what you
   closed, what is next.

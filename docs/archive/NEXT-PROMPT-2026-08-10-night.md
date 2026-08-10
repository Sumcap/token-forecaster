# Follow-up prompt — session totals, on top of the 10 August ships

> **Paste this into a fresh session.** Written 10 August 2026 (night), after
> the missing-signals / capacity / turn-totals session. The previous version
> is archived at `docs/archive/NEXT-PROMPT-2026-08-09-evening.md`; its tasks
> are resolved into STATE-OF-PLAY §6.23–§6.25.

---

You are picking up the output-token forecaster in this repo. The 10 August
session shipped three things; your job is ONE new capability plus two gate
watches. Read before inventing work — most of what looks open is closed.

## Read first, in this order

1. `docs/STATE-OF-PLAY.md` — the 10 Aug header block, then §6.23 (missing
   signals: six closed, image gated), §6.24 (boost capacity: exhausted, do
   not re-sweep), §6.25 (turn totals: shipped coarse; finer rungs failed
   endpoint stability), §8 house rules. **Do not re-propose anything in §6
   without qualitatively new evidence.**
2. `experiments/artifacts/missing-signals-probe.json` and
   `turn-totals-probe.json` — the numbers behind §6.23/§6.25.

## Where the model stands (10 Aug regeneration, corpus ~15,960 calls)

- Per call: static 885 → base ladder 507 → **boosted 483.2** (−23.8
  [−32.4, −15.9]). Boost = `portable-precall-v2` (37 features, image at
  index 36), trainer defaults depth 3 / 48 iters / lr 0.08.
- Per turn: `historicalTurnTotalForecast()` ships `overall` +
  `thinking=yes|no` (P50 4,952 / P90 31,133 / P99 102,070; coverage
  49.5/91.7/97.9 on 62 holdout sessions).
- Ceiling: ~405/call with a perfect tool oracle. Below that requires a
  caller-declared `expectedOutputKind` (TELEMETRY.md), not corpus work.

## The task: whole-SESSION totals

§6.25 delivered Σ over one turn. The session question remains: given a
session so far, forecast the TOTAL remaining output — N remaining turns with
N random. This is the number a context-budget UI actually wants.

1. Build a session dataset in a new `probe-session-totals.mjs` from
   `lib/load-history.mjs` (reuse the turn construction in
   `probe-turn-totals.mjs`). One record per session: turn count, total
   output, per-turn series in order.
2. First grade the DUMB forecasts before anything clever (house rule:
   the cheap move captures almost everything): (a) unconditional session
   totals; (b) turns-so-far × median turn total; (c) a "remaining total
   after turn k" curve fitted per k bucket. Pinball at p50/p90/p99 per
   session, block bootstrap by session — note the effective sample is
   ~300 sessions TOTAL, so expect wide CIs and say so honestly.
3. Kill condition, pre-committed: if no conditional forecast separates
   from the unconditional session distribution at 95%, ship the
   unconditional quantiles only (mirror §6.25's shape: a
   `sessionTotals` profile field + `historicalSessionTotalForecast()`),
   and write the negative result into §6.26.
4. Whatever ships: eval emits it every regeneration, predictor reads it,
   tests in `historical.test.ts`, ledger entry in STATE-OF-PLAY.

## Standing gate watches (no action unless they fire)

- **`promptImage` rung** — self-adopting, last read −4.19 [−10.59, +0.51].
  If a regeneration prints ADOPTED, update §6.23 and the README contract.
- **`promptPath` / `prevOutput`** — same machinery, same rule. Never
  hand-restore.

## Guardrails

- House rules §8 all apply; the two that bite here: effective sample is
  SESSIONS (~300, ~60 in holdout) — house rule 14 — and adopt only on a
  95% CI fully below zero against the incumbent (house rule 1).
- The corpus is live; absolute numbers drift between regenerations. Paired
  comparisons are the only stable statements.
- Do not add turn-level or session-level conditioning rungs beyond what
  clears endpoint-stability at ≥3 `--as-of` endpoints (the §6.23/§6.25
  lesson: one endpoint's ADOPTABLE is not a finding).
- Aggregates only in committed artifacts (house rule 9).

## Commands

```sh
pnpm build && pnpm evaluate:claude-history   # regenerate everything shipped
node experiments/evaluation/probe-turn-totals.mjs [--as-of <instant>]
node experiments/evaluation/probe-missing-signals.mjs [--as-of <instant>]
pnpm -r test
```

# Making the single-user profile defensible for a stranger

*Written 26 August 2026. The file references were checked against the tree on
that date: `load-history.mjs:453` (`workloadId`), `stats.mjs:381`
(`blockBootstrapDifference`) and `:343` (`bootstrapBlocks`),
`historical.ts:813` (the confidence rule), `format.ts:77` (`caveatCode`).*

## The problem

The shipped profile (`packages/predictor/src/bundled-profile.ts`, id
`claude-code-local-2026-08-12`, 16,687 calls) was fitted on one person's
`~/.claude`. `docs/TELEMETRY.md` states it: "only one identifiable user", and a
holdout of "thousands of calls but only 49 correlated session blocks and one
user". Every quantile, every conditioned rung, and the trained boost trees
inherit that. Those numbers now ship to strangers, compiled into the Chrome
extension's content script and exposed through the README's integration
contract. This document is the plan to bound the damage, disclose it, and
retire it.

## 1. How bad is it, measurably, today

The corpus already carries a between-user proxy nobody has used:
`loadRequests` in `experiments/evaluation/lib/load-history.mjs:453` hashes the
project directory into `workloadId` on every record. The live tree holds 29
project directories, of which roughly eight have enough sessions to act as a
pseudo-user (project A 257 session files, project B 121,
project C 92, token-forecaster 74, project D 43,
project E 21, Projects 19, project F 15). That gives 6 to 8
pseudo-users against the frozen 402-session, 21,160-call corpus in
`experiments/artifacts/reviewer-checks.json`.

Three probes, all reusing `lib/load-history.mjs`, `lib/stats.mjs`
(`bootstrapBlocks`, `blockBootstrapDifference`) and the rescale bisection
already written in `probe-reviewer-checks.mjs`.

- **`probe-workload-transfer.mjs`, leave-one-project-out. The main probe.** For
  each pseudo-user with at least 15 sessions and 300 calls: fit the full
  profile (ladder plus boost, same pipeline as `eval-claude-code-history.mjs`
  and `eval-winning-boost.mjs`) on every other project, then score the held-out
  project chronologically. Report per project: pinball delta against a
  within-project fit, P50/P90/P99 coverage with a session-block bootstrap CI,
  and the single multiplicative factor that restores 90% coverage. Run it twice,
  ladder only and ladder plus `boostedCorrection`, because the second run is
  what says whether the trained trees are more personal than the rungs. Expect
  they are: the shipped ensembles spend 52/78/57 splits on
  `priorMaxOutputTokens` and 38/41/75 on `sessionPosition`, and loop shape is a
  property of how one person's agents run.
- **`probe-user-variance.mjs`, variance decomposition.** Inside each populated
  (model, thinking) cell, and inside (model, thinking, fortnight) to control the
  known drift, decompose the spread of log output tokens into between-project,
  between-session-within-project, and within-session components. Method of
  moments is enough. Report the intraclass correlation at project and session
  level and the spread of per-project medians as a ratio. The comparison number
  exists already: the band spans 4x to 15x. Per-project medians inside 0.8x to
  1.3x means the shape travels. Projects 2x to 3x apart at the median means the
  P50 is personal.
- **Time era as a free pseudo-user, no new code.** `probe-calibration.mjs`
  already measured this user drifting: corpus P50 of 510, then 429, then 345 by
  fortnight, with fitted quantiles overshooting their own group holdout by 1.25x
  at P50 and 1.37x at P99 (STATE-OF-PLAY 6.19). Read it as a floor. Between-user
  variation is almost certainly not smaller than one user's own monthly drift,
  so any widening factor proposed later must be at least this.
- **Turn and session totals get the same LOPO, and are expected to fail it.**
  `turnTotals` rests on about 1,182 turns and `sessionTotals` on 311 sessions,
  all one user, and session length is a property of how this user runs agent
  loops.

**Thresholds, stated before running.** Generalizes better than feared: every
eligible project holds LOPO P90 coverage at or above 85%, every restore-scale
factor sits inside [0.75, 1.35], and project-level ICC is small next to the
model and thinking effects. Mostly personal: any project needs a rescale beyond
1.5x, or covers under 80% at P90, or the boost trees make transfer worse than
the bare ladder.

**What a pseudo-user cannot prove.** All 29 projects share one person's
prompting style, one toolchain, one machine, one Claude Code version, one model
mix, one era, one account. LOPO measures workload transfer with the person held
fixed. A pass is a lower bound on trouble, never a clearance. A fail is
conclusive in the other direction: a fit that does not survive a project change
by the same person will not survive a person change. This asymmetry belongs in
the artifact header.

## 2. The statistics of the fix

Judged at 50, 500 and 5,000 personal calls. At this user's density, 50 calls is
roughly 5 to 10 sessions and 500 calls is roughly 40 to 80 sessions.

- **Per-user multiplicative scale on the pooled shape. Ship first.** One scalar
  `s_u`, the median of `actual / predicted_p50` over the user's completed
  sessions, shrunk toward 1 by `n_sessions / (n_sessions + k)`, with `k` fitted
  by replaying the estimator on the Phase 1 pseudo-users. Clamp to [0.5, 2.0].
  Apply to P50 and P90 of any model-conditioned rung; apply to P99 only past 30
  sessions, because a wrong tail shrink is the expensive direction. It is the
  only parameter estimable at 50 calls, the reviewer-checks work already showed
  one multiplicative constant restores coverage across models, and the failure
  mode is bounded because `s_u` returns to 1 with no data. Failure mode: an
  unrepresentative first week biases it; the shrinkage, the clamp and
  session-level blocks are the mitigations. Note 6.19 refused a multiplicative
  split-conformal for a specific reason, a trailing window of a few sessions
  being noise rather than drift. This estimator differs by shrinking toward 1
  and gating on session count, and the LOPO replay has to confirm the
  difference matters.
- **Per-rung personal quantiles shrunk toward the bundled prior. Ship second,
  at 500 or more calls.** The discrete form is free: `selectHistoricalGroup`
  plus `minSamples` already implements "personal rung if populated, else
  bundled". Prefer it before any continuous blend. Gate per rung on the user's
  own chronological holdout, bundled profile as the fallback, `usedFallback`
  semantics untouched. Failure mode: an empirical P99 at n=100 is noise; keep
  the bundled P99 until the personal rung clears roughly 500 samples.
- **Per-user split-conformal on P90. Third layer, at 500 or more calls, never
  at 50.** It buys the actual product promise with a guarantee, but needs on
  the order of 50 exchangeable points for P90 and about 500 for P99, and a
  corpus that drifts 30% per month breaks exchangeability. 6.19 already proved
  the small-window version worse than nothing. Gate it exactly as 6.19 did.
- **Hierarchical partial pooling with user random effects. Correct end state,
  wrong first ship.** It cannot be fitted without multiple real users, and it
  replaces an audited lookup ladder with a new estimator class. At 50 personal
  calls its user effect is the same shrunk scalar as the first option wearing
  more machinery. Adopt it in Phase 5, in its cheapest form: a random
  location-scale effect per user on log tokens, which is again a per-user scale
  on a pooled shape. The boost trees stay population-fitted at every stage; the
  trainer's 150-row leaf minimum already forbids personal trees below thousands
  of rows.

Adoption keeps the house gate: the whole 95% session-block CI below zero,
simulated on pseudo-users now and on held-out users later. With 6 to 8
pseudo-users the gate has to be stated honestly as pooled CI clear plus a
negative direction for every eligible pseudo-user.

## 3. Where the data comes from

- **Path (a), opt-in telemetry to the ingest VM.** The client shipped in
  the host app, and `userIdHash` and `workloadIdHash` are already in the
  observation schema. It fixes the population prior and enables
  leave-one-user-out. It cannot fix a fresh user's first session, and it carries
  recruitment bias: people who consent to a forecasting tool's telemetry are
  power users, so segment composition gets published with every refit. One hard
  caveat: the Chrome extension cannot observe true `output_tokens` on
  claude.ai, only an estimate from rendered DOM. The extension is therefore a
  weak telemetry source; the exact-usage sources are the host app, CLI users
  and orchestrator integrations. If extension rows are ever collected, tag them
  as estimated and exclude them from quantile fitting by default. Minimum
  recruitment in the repo's own units: today's single-user CIs sit at about plus
  or minus 10 pinball per call and 1 to 2 coverage points at roughly 50 session
  blocks; for a between-user claim the block is the user, so the floor is 15 to
  20 users with 20 or more sessions each, and each reported segment needs at
  least 8 populated users before its number is published. Timeline: consent UI
  and docs one to two weeks, recruitment months and human-gated.
- **Path (b), purely local training on the installing user's own `~/.claude`
  through a native messaging host.** It fixes personal calibration completely
  and uploads nothing. It cannot fix the population prior, cannot validate any
  transfer claim, and does nothing for a claude.ai-only user with no Claude Code
  history, who is exactly the cold-start user the product promises to serve. Its
  blockers are the three in BACKLOG Phase 6. The 30-day retention default is
  real, and a stranger must not be asked to edit settings: the host's first run
  featurizes the whole existing corpus into privacy-safe aggregate state
  immediately and appends incrementally, so raw-transcript deletion stops
  mattering after day one. Raising `cleanupPeriodDays` is then optional rather
  than load-bearing. Minimum per user: about 10 sessions before `s_u` moves off
  1, and 50 to 100 sessions per rung before a personal rung clears a floor.
- **Path (c), aggregate-only contribution.** Behind a second explicit opt-in,
  the local trainer uploads only per-user sufficient statistics: bucketed
  log-token histograms per rung plus counts, never rows. Histograms are
  aggregates under house rule 9, they are sufficient for pooled quantile
  estimation and for the hierarchical fit, and the consent bar is far lower than
  per-call telemetry. This is the cheapest route to a multi-user prior.

## 4. What ships this week

The evidence cannot change this week, so the release changes what the numbers
claim, not the numbers.

- **Provenance copy, three edits.** `apps/extension/src/lib/format.ts:77`
  currently reads "Fitted on Claude Code agent traffic, which is the work this
  page does." It names the workload and hides the user; it must state both, and
  match the sentence `apps/extension/src/lib/profile-info.ts` already carries.
  `README.md` "The data" says "471 transcript files" and never says one user;
  add the sentence `docs/TELEMETRY.md` already contains. `README.md`
  "Integration contract" documents that `calibration.profileId` and
  `profileScope` denote a single-user corpus, backed by a new optional
  `provenance: "single-user-corpus"` field on `HistoricalForecastProfile`,
  emitted by the eval and present in `bundled-profile.ts`, so a headless
  consumer can render honesty without hardcoding a profile id.
- **Do not touch `usedFallback`.** It means "group selection fell off the
  model-conditioned ladder" and callers branch on it. Overloading it to also
  mean "cross-user prior" breaks the one contract that works. The cross-user
  fact belongs in the provenance field and in confidence.
- **Confidence: decide with the probe in hand, cap in the extension now.**
  `historical.ts:813` grants "medium" at rung sample size 500 or more with the
  boost applied. Those 500 samples are one person's, so "medium" is unearned for
  a stranger, but the library change should be made with the LOPO number in
  hand. This week, cap the displayed confidence at "low" in
  `apps/extension/src/lib/engine.ts`, the same one-line pattern the chat surface
  already uses. If the transfer probe later shows every project inside 85 to 93%
  P90 coverage, restore "medium" and cite the artifact.
- **Withdraw nothing numeric, but demote the session line.** Do not hand-widen
  quantiles: a typed widening constant violates the founding rule, and the
  honest factor is unknown until the probe reports the between-project scale
  spread. The one output too personal to defend is the session and turn total
  surface: `sessionTotals` rests on 311 sessions from one user, and loop length
  is a property of this user's harness. Keep the line this week with the
  provenance qualifier; if LOPO shows per-project turn-total coverage
  collapsing, drop it from the view model until a personal or multi-user fit
  exists.
- **`docs/STATE-OF-PLAY.md` gets a section 6.29** recording this decision set,
  so the gate lives beside the others.

## 5. Validation that would close this

- **Protocol.** Freeze a profile fitted on all users except u. Replay user u's
  entire stream chronologically through the shipped code path, with the
  personalization layer running as it would live, `s_u` starting at 1 and
  updating per session. Score per call.
- **Blocks, two levels.** Within a user the block is the session
  (`bootstrapBlocks`). Across users the block is the user: resample whole users
  with replacement for every published cross-user number.
- **Published per segment** (model by thinking, plus cold-start tier b, plus the
  turn-total surface): per-user P50/P90/P99 coverage with within-user
  session-block CIs, user-block pooled coverage with CI, matched-coverage width
  against the pooled band, and pinball against the current bundled profile.
  Artifact: `experiments/artifacts/louo-report.json`, salted user hashes only.
- **The numbers that make the claim true.** With 15 or more held-out users at 20
  or more sessions each: every such user's P90 coverage CI intersects [85, 95];
  the user-block pooled P90 coverage CI lies inside [88, 93]; and the frozen
  multi-user prior beats today's bundled profile on pinball with the user-block
  95% CI entirely below zero. A breakthrough label additionally needs 5% or more
  loss reduction, or materially narrower matched-coverage widths with no
  coverage damage. The personalization layer earns its place separately: at each
  user's 50th and 500th call, the personalized forecast must beat the frozen
  prior on that user's subsequent calls, user-block CI below zero.

## 6. Sequenced plan

| Phase | What | Blocked on | Size |
| --- | --- | --- | --- |
| 1 | `probe-workload-transfer.mjs`, `probe-user-variance.mjs`, re-read the drift artifacts. Artifact `experiments/artifacts/workload-transfer.json`. Opens the confidence decision and any measured widening. | Nothing | 3 to 5 days |
| 2 | The section 4 edits: copy, provenance field, extension confidence cap, STATE-OF-PLAY 6.29. Ships before Phase 1 finishes, except the confidence restore. | Nothing | 1 to 2 days |
| 3 | `packages/trainer`: move profile fitting, boost training and the total emissions out of `experiments/evaluation/`; make `engine.ts` and the headless contract take a profile as data. Gate: the extracted trainer regenerates today's bundled profile byte-identically from the same corpus. | Nothing | 1 to 2 weeks |
| 4 | Local personalization MVP: native messaging host, first-run featurize-and-archive, the shrunk `s_u` estimator, the discrete per-rung personal override, `ProfileSummary.personal` flips true. Entry gate: the Phase 1 replay shows the estimator CI-clear on pseudo-users. Internal gate: each user's own chronological holdout with the bundled profile as fallback. | Nothing | 2 to 3 weeks |
| 5 | Multi-user prior: consent UI and privacy page for paths (a) and (c), recruitment of 15 to 20 users, the hierarchical refit, the section 5 protocol. Artifact `louo-report.json` and a bundled profile whose provenance finally says multi-user. | Recruitment and consent | Months |

Only Phase 5 retires the problem. Everything before it bounds and discloses it.

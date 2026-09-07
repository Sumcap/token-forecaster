# Backlog

Phased plan. Each phase ships something usable and each predictor step must
beat the previous baseline in evaluation before it replaces it.

See [STATE-OF-PLAY.md](./STATE-OF-PLAY.md) for what the evaluation currently
measures, which features were tested and rejected, and the prioritized next
steps behind the Phase 4/5 items below.

## Done (Phase 1 foundations, plus the Phase 2 skeleton)

- Monorepo scaffold (pnpm workspaces, TypeScript strict, Vitest)
- Shared Zod schemas: count quality, forecasts, thinking usage, observations
- Versioned Anthropic model registry with pricing provenance, covering all
  three models the shipped forecast profile is fitted on (Fable 5, Opus 4.8,
  Opus 5). Lookup resolves dated snapshot ids onto their canonical entry, and
  the profile's `modelAliases` map is generated from the registry rather than
  hand-written, so a caller holding a dated id cannot silently degrade to the
  blended `overall` group.
- Pure context-budget module with explainable, configurable warnings + tests
- Anthropic adapter: count_tokens, streaming with usage normalization,
  registry-backed metadata
- Local estimator (character heuristic) + race-safe CountReconciler +
  fixture-driven race tests
- Static forecast Baseline 0 (labelled, clamped, low confidence)
- Playground: model selector, system/user prompts, Web Worker local counts,
  debounced Anthropic verification, count-source label, context bar,
  reserved-output input, warning panel, forecast panel, projected cost
- Express server route for POST /api/count-tokens (server-side key only)
- README, competitive analysis, literature review, ADRs 0001-0005

## Phase 2 completion: live input meter hardening

- [ ] Reverify triggers: model change, tools change, documents/images, explicit
      "verify now" button, and immediately before execution
- [ ] Conversation-history editor in the playground (multi-turn requests)
- [ ] Tool-definition editor included in counts
- [ ] Latency metrics: local count latency, verification latency, API call volume
- [ ] Optional live check of registry limits against GET /v1/models/{id}
      (drift detection for contextWindow / maxOutputTokens)

## Phase 3: execution and telemetry

> **⚠️ PORT NOTE (decided 9 August 2026): live telemetry wiring happens at the
> the first consumer integration, not before.** For now the model is developed and tested
> locally against the mined Claude Code history corpus
> (`pnpm evaluate:claude-history`). When this repo is finally ported into
> **the consumer app**, that integration must wire up the already-built collection
> pipeline as part of the import: call `JsonlTelemetryWriter` (or POST to the
> ingest server in `examples/telemetry-server.mjs`) around every provider call,
> and — critically — have the consumer declare `expectedOutputKind` +
> `expectedOutputKindSource` *before* each call, per `docs/TELEMETRY.md`. That
> caller-declared intent signal is the one thing the local corpus cannot
> provide and the prerequisite for every "blocked on Phase 3 telemetry" item
> below.
>
> **Amendment, same day: telemetry is production-optional and must never be
> load-bearing.** Most users will never contribute history or loop context, so
> the predictor's zero-context cold-start path is the product; telemetry-fed
> improvements are opt-in bonuses on top. The cold-start audit ran the same
> afternoon (STATE-OF-PLAY §6.18–§6.22): the pooled `thinking` fallback tier
> shipped, the eval now grades the zero-context path on every regeneration,
> and the fallback contract in README reflects it.
>
> **Update, 10 August 2026: the port landed.** The predictor has its first real
> consumer: an agent orchestrator that vendors `core`/`predictor`/`telemetry` and
> takes a pre-call forecast on both of its SDK entry points. Behind an opt-in
> setting (default OFF) it writes turn-granularity observations with a
> caller-declared `expectedOutputKind` +
> `expectedOutputKindSource: "orchestrator_declared"`. Those rows are tagged
> `metadata.workflowId = "orchestrator-turn"` — they pair with `turnTotals`, NOT
> the per-call ladder; do not feed them to `buildHistoricalProfile` as per-call
> rows. The Agent SDK exposes no `max_tokens`/`thinking`, so requests record the
> Claude Code default cap (32k) and tri-state unknown thinking.

- [ ] Server-side Messages API execution route with SSE streaming to the UI
- [ ] Streaming usage updates (message_start / message_delta usage events)
- [ ] Final usage reconciliation; finish reason; isCensored flag
- [ ] Thinking-token and cache usage capture where reported
- [x] packages/telemetry: salted identifier hashing, storage modes,
      schema-valid append-only JSONL writer/reader, and accuracy summary. The
      encrypted-VM collection contract is in `docs/TELEMETRY.md`; provider
      execution still needs to call it.
- [ ] Forecast-vs-actual comparison view (before / during / after states)
- [ ] Observation export command (packages/cli: run, export)

## Phase 4: heuristic forecasting

- [x] Baseline 1: constraint extraction ("in one sentence", "20 examples",
      word limits, JSON-only, full-copy tasks) — **one signal adopted,
      5 August 2026.** Constraint extraction was built as `hasLimit` /
      `hasExpansive` in `lib/load-history.mjs` and graded alongside message
      length, verb class, path mention, question-vs-command and requirement
      count. The original ancestry walk incorrectly treated injected `isMeta`
      skill rows as new human turns, hiding the real prompt on 22% of calls.
      After fixing it, prompt coverage is **89.9%** and `promptPath` clears the
      gate: **-10.9 pinball/call, 95% CI [-21.9, -0.4]**. It is now shipped.
      All other prompt ladders remain rejected; combined prompt R^2 is 0.244,
      still below the pre-committed 0.25 programme threshold.
- [x] ~~Task-family classifier (rules first)~~ **Rejected with the above.** The
      verb-class classifier is the rules-first version. Against a 3.2% base
      rate it moves P(`Write`) to 3.7% -- a **1.17x** lift on the one class
      worth detecting (9.8x over-represented among the worst misses). It cannot
      feed a `Write` detector.
- [x] Baseline 2: hierarchical historical p50/p90/p99 groups with
      minimum-sample thresholds, model aliases, rolling-window profile builder,
      and explicit fallback chain. The bundled Claude Code profile contains
      overall, per-model, per-model-by-thinking, and prompt-path groups. Raw
      prompts are never stored; callers pass one derived boolean.
- [x] Baseline 2a: extended thinking as a conditioning dimension. Measured
      -10.1% pinball loss against per-model alone on the chronological holdout
      (2.9x median / 3.3x p99 separation). An omitted `thinkingEnabled` is
      treated as unknown, not as disabled, and falls back to a broader group.
- [x] Rolling-origin cross-validation (5 forward-looking folds) reported as
      mean +/- spread, alongside the original single 80/20 split. Fold-to-fold
      spread is +/-70 total pinball, which retired every previously reported
      +/-1-2% difference as noise. Only two effects survive it: learning from
      history at all (-36%), and conditioning on thinking (-10% on top).
- [x] Recency-window sweep (7 / 14 / 30 / 90 / all days) against the rolling
      CV, compared to the full history fold-by-fold. **Rejected**: 7d is
      significantly worse (t=+3.8), 14d is a coin flip (t=-0.1), and 30d/90d
      are identical to the full history because the corpus is under 30 days
      wide. A window is adopted only on a paired improvement of >=2 standard
      errors; the machinery stays wired up and is re-swept on every run.
- [x] Narrow the backoff ladder to model / thinking / effort / task. `tools`
      was degenerate (constant for an agent workload, never recorded in
      transcripts, and conflated an omitted count with "no tools") and `input`
      had hurt p99 in five independent tests. Neither had ever produced a
      shipped group, so removal left every holdout number unchanged.
- [x] `previousOutputTokens` (the previous call's output size) as a conditioning
      dimension: request field, `previousOutputBucket()`, the
      model+thinking+prevOutput ladder rung, and a paired adoption gate wired
      into the eval. **Built but NOT adopted.** It measured -16.4 +/- 4.4
      (t=-3.8) on 3 August and -7.2 +/- 4.1 (t=-1.8) on 4 August, off 1.3% more
      data; two independent implementations agree on the second number. The gate
      re-tests it on every regeneration and will emit the tier the moment its
      95% CI clears zero, so there is nothing left to build if the effect
      returns. Under the corrected statistic (a paired block bootstrap over
      per-call losses in session blocks, which replaced the 5-fold t on
      4 August) it read **-8.2/call, CI [-18.4, +2.1]** in the morning and
      **-3.7/call, CI [-15.1, +8.1]** that evening, on a corpus 1% larger. The
      point estimate wanders and the verdict does not: real in direction, not
      separable from zero on an effective sample of ~54 sessions.
      See STATE-OF-PLAY.md 7.1.
- [x] The oracle ceiling re-measured. The published "-49 pinball/call (~8%)"
      was a **sample-floor artifact**: the oracle was a single joint
      `model|thinking|action` rung at a 100-sample floor, and `Write` is 3% of
      the corpus, so exactly one of six cells cleared the floor -- a model that
      has left the workload. The oracle was scored as knowing nothing on ~68%
      of `Write` calls. With a pooled `action=` rung added beneath the joint
      one, the ceiling is **~-90/call (~17% of shipped loss)**, median over 12
      corpus endpoints, range -50 to -126. A **binary** "is this a `Write`?"
      detector is worth ~71% of it. See STATE-OF-PLAY.md 4.2a.
- [ ] Forecast-vs-actual dashboard with rolling error and coverage

## Phase 5: trained forecasting

- [x] **Baseline 3 portable quantile correction (6 August 2026).** Three
      24-tree depth-2 ensembles correct the historical p50/p90/p99 residuals
      from privacy-safe prompt aggregates and exact completed parent-chain
      history. Five-fold rolling origin: 671.2 → 650.4 pinball/call (−3.1%,
      paired session-block CI [−30.2, −14.0]); coverage
      49.6/86.9/98.6% → 49.2/87.8/98.7%. Adopted because the full CI is below
      zero, but explicitly not called a breakthrough because it is below 5%.
      Incomplete context skips the trained correction and returns low
      confidence.
- [x] Hurdle/mixture, semantic prompt, workload, session-history, online
      conformal, and structured/hashed quantile candidates measured with oracle
      ceilings first. Only the portable booster cleared the adoption gate;
      none cleared the breakthrough gate. Full table:
      `experiments/artifacts/breakthrough-probe.json`.

- [ ] experiments/: Python pipeline (pandas, scikit-learn, Parquet export)
- [ ] Curated Anthropic benchmark dataset (task families from the design doc;
      one primary Sonnet model; repeated sampling on 5-10% of prompts)
- [ ] Baselines B4-B6: linear / structured-feature / quantile regression
- [ ] Cap-risk classifier trained on censored observations
- [x] Online rolling conformal calibration tested at 64/128/256/512 call
      windows. Best standalone effect −6.2/call, CI [−15.9, +3.7]: rejected.
- [ ] Dataset splits: random, template-group, unseen-task, temporal, snapshot
- [ ] Metrics: chronological empirical coverage and pinball loss are shipped;
      add MAE / median AE / log1p AE, interval width, Brier score, and
      calibration curves
- [ ] Predictor artifact versioning + drift warnings (coverage regression)

## Phase 6: integration package

- [ ] packages/react: useTokenCount, useTokenForecast, useContextBudget,
      meter and warning components extracted from the playground
- [ ] Headless TypeScript API + middleware interface for the agent
      orchestration app (the consumer connection). The forecast half of
      this contract is already stable and documented in the README
      ("Integration contract"): pass model id, maxTokens and thinkingEnabled;
      branch on `calibration.usedFallback`.
- [ ] packages/cli: count, forecast, evaluate
- [x] apps/extension: a Chrome MV3 extension that puts the live count and the
      forecast in the claude.ai composer (26 August 2026). It is a pure
      cold-start consumer: the bundled profile ships inside the content script,
      nothing leaves the browser by default, and the panel states that the
      profile is Claude Code traffic while the surface is chat, so the
      confidence is capped at `low`. The optional Anthropic `count_tokens` path
      is off until the user supplies a key. See `apps/extension/README.md`.
- [x] apps/extension: install-time onboarding (26 August 2026). `onInstalled`
      opens a welcome page on a fresh install only, never on an update. The
      page states what the three numbers are, that nothing leaves the browser
      by default, and the provenance of the profile: fitted on one corpus, so a
      prior for this kind of work rather than a calibration of the installing
      user. `onboardingSeenVersion` records what was shown.
- [ ] **Single-corpus provenance is the top priority.** The shipped profile was
      fitted on one user. The measurement, the statistics, the release copy, and
      the validation protocol that retires it are planned in
      `docs/MULTI-USER-PLAN.md`. Phase 1 there (`probe-workload-transfer.mjs`,
      `probe-user-variance.mjs`) is pure engineering and gates the rest.
- [ ] apps/extension: per-user pre-training. The extension cannot read
      `~/.claude`, so a local trainer has to run outside the browser and reach
      it over a native messaging host (chosen over a localhost server: the
      browser starts the host on demand, so there is no always-on daemon, no
      open port for other local processes, and the extension-to-binary binding
      is enforced by the browser rather than by an auth token we invent).
      Blocked on three things: (a) the fitting pipeline still lives in
      `experiments/evaluation/*.mjs`, and `buildHistoricalProfile` alone
      produces only the quantile groups, not the boost trees, `turnTotals`, or
      `sessionTotals`, so it has to move into a shipped package; (b) the engine
      imports `BUNDLED_CLAUDE_CODE_PROFILE` directly and has to take the
      profile as data; (c) adoption has to stay gated per rung on sample count
      and on the chronological holdout, with the bundled profile as the
      fallback, and the installer has to raise `cleanupPeriodDays` or a fresh
      user's corpus is deleted at 30 days before it can ever clear a gate.

## Phase 7: workflow forecasts (out of MVP)

- [ ] workflowId / agentId / stepId / attemptNumber / parentCallId telemetry
- [ ] Call-count and loop-count distributions, branch probabilities,
      context growth modeling

## Issue, 2 September 2026: does the prompt TEXT beat prompt FEATURES?

Measured (STATE-OF-PLAY §6.32, plan in `docs/SEMANTIC-PLAN.md`). On turn
totals, prompt words beat the shipped feature vector on one chronological
split (−10.6%) and fail to on five pooled session folds (+0.8%, folds swing
−10.5% … +28.8%). A λ=0.35 shrink toward the metadata model is the only
configuration with its whole CI below zero (−2.0% [−3.1%, −0.7%]). Text hurts
the opener call (+5.0%). What the text model reads is length, conjunctions
and ack-versus-instruction, which the features already mostly carry.

- [x] Step A/B (2 Sep 2026): 35k public developer-prompt turns harvested;
      hashed-n-gram head −0.9% public, −2.6% local as FEATURES into the local
      GBM (blended prediction fails on a ~10× label-scale mismatch). Tables in
      `docs/SEMANTIC-PLAN.md`.
- [x] Stage 1 (2 Sep 2026): base head shipped in the predictor
      (`baseTextHead`, 13 bits × 48 dims, 1.3 MB, bit-identical parity),
      schema `portable-precall-v4`, `textHead` on the turn-total request,
      `textHeadQuantiles` telemetry column. **v4 turnTotalBoost NOT adopted**:
      −0.31% [−1.54%, +0.76%] vs v3 on five folds, and the typing trajectory
      gains two dips. Shipped correction stays v2; extension wiring reverted
      (+1.3 MB bundle for an ignored head). Tables in `docs/SEMANTIC-PLAN.md`.
- [x] Text-head asset behind a subpath (4 Sep 2026): the 1.3 MB asset moved to
      `packages/predictor/src/text-head/`, exported as `./text-head`, off
      `src/index.ts`'s import graph. Main entry 1.7 MB → 412 KB reachable.
- [ ] Base profile regeneration: corpus doubled since 12 Aug (16,687 →
      32,268 calls); the pipeline's own gates now adopt the per-call
      `promptPath` ladder and drop the pooled thinking groups, breaking 5
      predictor tests that pin the cold-start contract. Separate change.
- [ ] Stage 1b: boost trainer into `packages/personal` so other users
      post-train the head locally. Blocked until a v4 correction adopts.
- [ ] Telemetry: add the head's local prediction as a field; keep `hash_only`.
- [ ] Stage 2: more TURNS. Public agent trajectories for pretraining;
      multi-user turns via the client-side head; a synthetic-developer loop
      whose prompts are run through the real agent for labels.
- [x] Stage 3 (3 Sep 2026): MiniLM fine-tuned as a quantile head on the
      35k public coding turns lands where the hashed head did (−0.9%
      [−3.0%, +1.3%] with meta; frozen embedding −1.6% [−2.4%, −0.9%]);
      as features into the local GBM −3.9% [−6.1%, −1.6%], every fold
      negative. "Global ranks, local rescales" refused (no rank advantage,
      one fold +16–52%). **Encoder does not replace the hashed head; prompt
      text closed at this turn count.** Tables in `docs/SEMANTIC-PLAN.md`.
- [ ] Forecasting effort moves to context/repo signals (what the agent will
      touch, not what the user typed). Plan, gates and the oracle-ceiling
      stop rule in `docs/CONTEXT-SIGNALS-PLAN.md` (3 Sep 2026): session-
      so-far counts and repository state at the nearest commit, graded on
      five local session folds before anything ships. **Measured 3 Sep:**
      oracle −62.9% but it is loop duration, not files; session-so-far
      −1.6% [−3.0%, −0.05%] passes by a hair on turn index + previous
      turn's output; repository state +3.3% and memorises projects under
      leave-one-project-out. The two S columns went through the real v5
      trainer gate and were refused (+0.28% [−0.39%, +0.96%]); schema v5
      exists in the predictor, nothing wired. **Context signals closed**
      (STATE-OF-PLAY §6.33). Next lever: re-forecast-as-you-go (§6.9, §7.1)
      and a multi-user corpus.
- [x] Re-forecast-as-you-go (3 Sep 2026): turn total re-forecast at k = 1,
      2, 3, 5 completed calls vs a dip-free clamp control, −4.7% → −10.2%
      with whole CIs below zero but under the pre-registered −10%/−15%
      margin; oracle −62% at every k (the ceiling is how the loop ends);
      raw path dips on a third of steps, ratchet is free. **Not adopted**;
      plan and tables in `docs/REFORECAST-PLAN.md`, STATE-OF-PLAY §6.34.
      Single-user turn-total work is closed; next is the multi-user corpus.
- [ ] `export-turn-text.mjs` writes the 42-wide v4 vector with head columns
      38–41 unfilled (all zero); either populate them or export 38 columns.
- [ ] If an encoder is ever revisited: frozen MiniLM embedding as GBM
      features behind the companion daemon only (22M params), and only
      after the Stage 1 boost-trainer gate, which shrank the hashed head
      from −3.06% to −0.31%.

## Issue, 11 August 2026: prompt-aware boost is flat at chat turn roots

Live repro in the consumer app (turn root, `sessionPosition=1`, `loopDepth=0`,
`priorCallCount=0`, `claude-opus-4-8`, thinking on, cap 64k): opposite drafts
forecast the same median.

| draft | features fired | p50 / p90 |
|---|---|---|
| `let's summarize it` | analysis | 523 / 1914 |
| `summarize this briefly in one sentence` | analysis, hasLimit | 523 / 1923 |
| long "comprehensive report about everything, step by step" | analysis, hasExpansive | 499 / 2215 |
| `write a new file src/foo.ts implementing the parser and tests` | artifactIntent, code | 530 / 2231 |

Prompt wording moves p50 only 499-530 (±3%). The levers that do move it are
thinking on/off (523 vs 164) and deep sessionPosition (644 at position 30),
both constant while a user types. Actuals for two real "summarize it" turns:
337 and 132 tokens against p50 523.

Not broken: feature extraction (flags flip as designed), boost application
(`applied`), band-level calibration (both turns graded "shorter than
typical"). Root cause is regime collapse: the correction was trained on the
per-call ladder, where loop-shape features dominate the residual. Split
counts in the shipped ensembles (p50/p90/p99): `priorMaxOutputTokens`
52/78/57, `sessionPosition` 38/41/75, `loopDepth` 36/43/46, versus `hasLimit`
6/5/0 and `hasExpansive` 0/3/9. At a turn root the loop features are all
zero, so every chat draft lands in the same few leaves and never reaches the
prompt-wording splits. A second gap compounds it: "summarize it" as a
compression follow-up (shrink the previous answer) does not exist in the
Claude Code corpus, where "summarize X" means "read things, then write 800
tokens"; no feature separates the two regimes.

Fix directions: (1) ⚫ **done, refused — see STATE-OF-PLAY §6.27.** The
compression-follow-up feature and schema `portable-precall-v3` are implemented
and gated; the feature fires on 2 of 987 turn prompts corpus-wide, which cannot
train a split, so the shipped profile stays v2. (2) 🟢 **done, landed one level
up — see STATE-OF-PLAY §6.28.** The literal version (per-call correction
retrained on turn-root rows) was tried and refused: every config graded worse
than shipped v2, because the opening CALL genuinely does not lengthen with
typed intent — the TURN does. Shipped instead: pooled `thinking|promptPath` /
`thinking|promptImage` turn-total rungs plus a `turnTotalBoost` correction
trained on per-turn totals, where loop features are definitionally zero and
prompt features own the splits. The turn forecast now moves ~2.5x across a
draft typed phrase by phrase. (3) consumer-side, remaining: the orchestrator's
chip should surface the TURN total (the number that reads the draft,
`promptCorrectionApplied=true`) rather than the per-call p50, and fit local
turn rungs from its opt-in telemetry once sample counts clear a gate,
cold-start falling back to the bundled profile.

## Status, 6 August 2026: Baseline 3 adopted; breakthrough blocked on telemetry

The live corpus invalidated the stale 623.7/call headline: the current ladder
reproduces at 678.6 on the latest chronological holdout and 671.2 on rolling
origin. Baseline 3's portable correction is a real, repeatable 3.0% gain, but
the remaining failure mode is a rare long artifact/action regime that prompt
semantics does not identify accurately enough. A future `Write` label has an
11.1% oracle ceiling; the leakage-free semantic detector reaches only 0.584
AUC. The smallest unblocker is a caller-declared pre-call
`expectedOutputKind`, paired with post-call observed kind/action and stable
salted user/workload ids. The collection plan is in `docs/TELEMETRY.md`.

## Superseded status, 5 August 2026: Phase 4 closed with one prompt feature

Phases 5-7 below are unchanged, but read STATE-OF-PLAY.md 7.6 before starting
any of them. The central prompt hypothesis still fails its broad R² threshold,
but the corrected ancestry join exposed one narrow, useful bit: naming a path
predicts a heavier tail and improves held-out pinball. What remains is a
**calibrated reservation heuristic that knows its own ceiling**: it beats a
static guess by 32%, tells a caller when it is guessing
(`calibration.usedFallback`), and uses the only prompt feature that cleared the
adoption gate.

Phase 5's trained models are not blocked on modelling capacity -- prompt
features explain 0.007 of the variance in log output on their own, and no
functional form fixes that. They are blocked on **observing something new**. The
one measurement that would justify resuming is a corpus with materially more
*human turns* (not more calls): the depth-0 prompt effect is real and only
failed to demonstrate out-of-sample because 104 turn-openers reached the
holdout.

## Known gaps / notes

- The bundled historical profile describes output tokens per Claude Code API
  call. It is not a full-task forecast, and a model with fewer than 100
  observations uses the visible `overall` fallback (`calibration.usedFallback`
  is the caller's signal; see the README integration contract). Replace it with
  first-party direct-API telemetry before claiming workload-conditional
  calibration.

- The `thinking` dimension is inferred from emitted content blocks, not from the
  recorded request configuration: a thinking block implies thinking was enabled,
  but a thinking-enabled request that emits no thinking block is labelled "no".
  This slightly inflates the no-thinking quantiles, which makes the measured
  2.9x/3.3x separation a mild understatement rather than an overstatement. Not
  fixable from transcripts — they never record the request's thinking config.
  Blocked on Phase 3 telemetry; do not work around it in the eval script.

- `probabilityOfOutputCap` remains unavailable and cannot be fitted: the corpus
  has zero censored calls out of 13,644, so there is no signal to learn from,
  and three quantiles cannot imply a cap probability. Blocked on Phase 3
  execution telemetry run with a deliberately low `max_tokens`.

- `pnpm evaluate:claude-history` requires `pnpm build` first: it generates the
  profile's model aliases from the built model-registry dist.

- The server requires `pnpm build` before `pnpm dev:server` (imports built
  dists). Note: the script is deliberately not named `server`; `pnpm server`
  is a pnpm built-in command that silently shadows a script of that name.
- Sonnet 5 intro pricing ($2/$10 through 2026-08-31) is recorded in the
  registry note but not modeled in cost projection; decide whether projected
  cost should use intro or list price.
- The local estimator is a plain character heuristic; a WASM tokenizer
  approximation could upgrade quality from `character_heuristic` to
  `local_estimate` without violating ADR 0002.

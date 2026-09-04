# Token Forecaster: OpenAI SWE meeting brief

**Prepared:** 1 September 2026
**Purpose:** Explain the current system accurately, identify the decisions that matter most, and get actionable feedback from an OpenAI software engineer.

## The 30-second explanation

Token Forecaster is a local system that estimates how many output tokens an agent turn may consume **before the user sends it**. It does not call another LLM to make the prediction. It learns what comparable historical calls and turns consumed, then returns three empirical quantiles:

- **p50:** half of comparable outcomes finished below this value.
- **p90:** approximately nine out of ten finished below this value.
- **p99:** an extreme tail reservation estimate.

The important product idea is not “predict an exact token count.” It is:

> Give the user a resource envelope before an agent starts, so they can decide
> whether to run normally, lower effort, split the task, summarize context, or
> impose a budget.

The most useful question for OpenAI is therefore:

> Should agent systems expose a pre-execution resource envelope, a hard
> execution budget, or both?

## The three prediction scopes

| Scope | Meaning | Why it matters |
| --- | --- | --- |
| **Call** | One model request inside an agent loop. | Useful to an API client or orchestrator, but often invisible to the user. |
| **Turn** | All model calls caused by one human prompt. | Usually the right user-facing prediction: one prompt may trigger many model and tool calls. |
| **Session** | All turns in a working session. | Useful for longer-range planning, but highly dependent on personal working style. |

![One turn spanning five model calls separated by tool calls; the TURN scope brackets the total, the CALL scope brackets one call](report-assets/meeting-brief/03-call-vs-turn.png)


This distinction is critical. A request such as “implement authentication and test it” can start an agent loop containing many internal calls. Forecasting only the first response can seriously understate what the user experiences as the cost of that request.

## What p50, p90, and p99 mean

Suppose a whole-turn forecast is:

```text
p50: 4,000 tokens
p90: 30,000 tokens
p99: 100,000 tokens
```

The interpretation is:

- Comparable historical turns were below 4,000 tokens half the time.
- Approximately 90% were below 30,000.
- Approximately 99% were below 100,000.

![A right-skewed distribution of output tokens with P50, P90 and P99 marked; the actual outcome lands between P50 and P90, a miss for P50 and a hit for P90 and P99](report-assets/meeting-brief/01-quantiles.png)


It does **not** mean there is a 90% probability that the current turn will use exactly 30,000 tokens. The quantiles describe a historical conditional distribution, and their reliability depends on whether the current user and workload resemble the reference data.

P90 is currently the main reservation target. At p90, under-forecasting is penalized nine times as strongly as over-forecasting by quantile, or “pinball,” loss. That matches the product assumption that a truncated agent action is more harmful than reserving some unused capacity.

## End-to-end architecture

```text
Codex and Claude transcript files
                │
                ▼
Provider-specific importers
  - find user-turn boundaries
  - read exact provider usage events
  - deduplicate repeated usage updates
  - convert prompt text into numeric features
  - immediately discard the raw text
                │
                ▼
Local SQLite observations
  partitioned by provider and scale:
  OpenAI/Anthropic × call/turn
                │
                ▼
Chronological evaluation
  fit on earlier history, score on later history
                │
                ▼
Personal empirical profile
  historical p50/p90/p99 groups
                │
draft features + model + reasoning
                ▼
Authenticated loopback /forecast API
                │
                ▼
Terminal status bar / menu bar / dashboard
```

![The same flow as two loops: the live path from keystrokes through tf-claude, the companion daemon and the predictor to the status line; the learning path from provider usage through ingest, the SQLite store, a candidate profile and the chronological gate back into the predictor; the telemetry VM as an opt-in side branch](report-assets/meeting-brief/02-pipeline.png)


### 1. Capturing the draft

Neither CLI exposes the prompt currently being typed through the interfaces used here. The `tf-claude` and `tf-codex` launchers therefore sit between the keyboard and the CLI process.

The launcher holds the draft in memory, derives only numeric features such as character count, path count, question/imperative flags, and estimated input tokens, then publishes those numbers to a private local file. The text is discarded when the prompt is submitted.

### 2. Reading completed usage

For Codex, the importer reads `~/.codex/sessions` rollout JSONL files. It uses:

- `session_meta` for session identity and CLI version.
- `turn_context` for model and reasoning effort.
- `user_message` for the turn root and privacy-safe prompt features.
- `token_count` for exact usage.

Codex can emit the same usage information multiple times for UI refreshes, so the parser deduplicates events before creating observations. It emits one observation for each internal call and one aggregate observation for the whole human turn.

The main implementation is [`packages/ingest-codex/src/parse.ts`](../packages/ingest-codex/src/parse.ts).

### 3. Persisting privacy-safe observations

The companion stores derived observations in local SQLite. The schema has no column for raw prompt or response text. It stores token counts, provider, model, reasoning, turn position, numeric prompt features, and a per-install salted prompt hash.

OpenAI and Anthropic observations are never pooled. Individual calls and whole turns are also kept separate.

The storage implementation is [`packages/personal/src/store.ts`](../packages/personal/src/store.ts).

### 4. Training a personal profile

For every `provider × scale` slice, the companion builds empirical quantile groups using combinations of:

- Model.
- Reasoning configuration.
- Prompt-size bucket.
- Coarse prompt kind: task, task with code, question, or other.

At forecast time it walks from a specific group to a broad group until it finds enough observations. A normal conditioned group requires at least 60 observations. The personal unconditional fallback requires at least 30.

The personal forecast ladder is in [`packages/personal/src/forecast.ts`](../packages/personal/src/forecast.ts).

### 5. Deciding whether personalization is safe to serve

Observations are ordered chronologically. The earlier 70% are used to fit and the later 30% are used to compare four candidates:

1. Cold start with no personal profile.
2. The user's unconditional distribution.
3. Model/reasoning-conditioned groups.
4. Model/reasoning plus prompt-conditioned groups.

A personal slice must lower held-out mean pinball loss by at least 2% compared with cold start before it is served. If it fails, the profile is retained for the dashboard but the fallback continues answering forecasts.

This gate is implemented in [`packages/personal/src/evaluate.ts`](../packages/personal/src/evaluate.ts).

### 6. Rendering the live result

The daemon exposes an authenticated API bound only to `127.0.0.1`. The status line sends model, reasoning, scale, and numeric prompt features to `/forecast`. While a turn runs, it also reports actual output growth to `/turn` so the menu bar can compare the frozen forecast with the emerging outcome.

Claude Code can execute a status-line command. Codex cannot execute an arbitrary external renderer in its built-in status line, so `tf-codex` reserves the terminal's bottom row and paints the same shared status line from outside Codex.

The integration is in [`apps/companion/src/statusline.ts`](../apps/companion/src/statusline.ts) and [`apps/companion/bin/tf_wrap.py`](../apps/companion/bin/tf_wrap.py).

## Two predictor generations exist today

### Bundled Claude research predictor

The older and more sophisticated predictor is compiled into the package as a frozen Claude Code profile. It:

1. Selects the most specific sufficiently populated historical group.
2. Reads empirical p50/p90/p99 values.
3. Optionally applies shallow quantile-correction trees using privacy-safe
   prompt and agent-loop state.
4. Returns source, confidence, sample size, and fallback information.

The current bundled artifact contains 16,687 Claude calls, about 1,182 whole turns, and 346 sessions. Every one came from one identifiable user.

This predictor is in [`packages/predictor/src/historical.ts`](../packages/predictor/src/historical.ts), with its generated data in [`packages/predictor/src/bundled-profile.ts`](../packages/predictor/src/bundled-profile.ts).

### Personal companion predictor

The newer companion supports both Codex and Claude history, but it uses the simpler personal empirical ladder described above. It does not currently train the bundled predictor's shallow correction trees per user.

This means the repository has two related but different forecasting systems:

| Property | Bundled predictor | Personal companion |
| --- | --- | --- |
| Providers | Claude only | OpenAI and Anthropic |
| Population | One user's frozen corpus | Installing user's local history |
| Forecast groups | Model/thinking and optional historical dimensions | Model/reasoning/prompt size/prompt kind |
| Trained correction | Yes | No |
| Main role | Claude cold start and extension | Local terminal/menu forecasting |

Consolidating these into one profile and evaluation abstraction would reduce documentation drift and make product claims easier to understand.

## The critical OpenAI limitation

Codex integration exists, but data-backed OpenAI cold start does not.

When there is not enough personal history:

- Anthropic requests can fall back to the bundled Claude profile.
- OpenAI requests fall back to fixed values: p50 1,000, p90 4,000, and p99
  12,000.

The implementation deliberately refuses to apply Anthropic quantiles to OpenAI. This is statistically honest, but it means a new Codex user does not yet receive an empirical OpenAI forecast.

The accurate claim is:

> Codex support learns a personal forecast from local history. Its initial
> OpenAI forecast is currently a clearly labelled static prior.

## What is already strong

- The result is a distribution instead of false precision.
- Individual model calls and whole human turns are separated.
- OpenAI and Anthropic histories are never pooled.
- Evaluation is chronological rather than randomly mixing past and future.
- Unknown values remain unknown instead of being converted to false or zero.
- Forecast source, fallback, and provenance are exposed.
- Raw prompts and responses are not persisted.
- Candidate predictors are compared against a baseline before being served.
- The current working tree passes 521 tests, with 2 skipped, and all TypeScript
  packages type-check.

These strengths matter because forecasting errors are easy to hide. A very large p90 can appear perfectly calibrated while being useless. Separating coverage, interval width, loss, provenance, and fallback makes the result auditable.

## How useful and reliable is it today? The evidence

Measured on 1 September 2026. Three sources, kept apart because they answer different questions and have very different weight. The first is the only one that carries statistical weight; the other two show the pipeline works end to end and how little multi-user data exists.

![Rows of evidence on a log axis: 46,000 personal observations, 21,160 reviewer-run calls, 4,232 held-out calls, 297 Codex rollout files, 39 sheep-manager turns, 30 VM rows, 1 installation, 0 other users](report-assets/meeting-brief/09-evidence-volume.png)

### Source A: chronological backtests on exact provider usage (the real evidence)

Every number here is scored against `usage` fields the providers wrote themselves, never against DOM estimates. The forecast is always made from data strictly earlier in time than the call it scores.

**Bundled Claude predictor, frozen reviewer run (20 Aug 2026, 13:50 UTC).** 21,160 Claude Code calls in 402 sessions on this machine; 4,232 calls in 48 whole held-out sessions.

| Claim | Result |
|---|---|
| P90 coverage on held-out sessions | **90.5%**, 95% CI [89.6, 91.7] |
| Band width vs pooling all calls, matched at 90% coverage | rung ladder −6.8%, rungs + correction **−9.8%** |
| Same, matched at 92% coverage | −11.7% / **−14.1%** |
| P99 band width vs pooled, matched at 99% coverage | **−16.6%** |
| Coverage inside the heaviest fifth of the workload | pooled 74.1% → rungs + correction **85.8%** |
| Coverage inside the lightest fifth | pooled 99.6% → **90.1%** |

Reading: the headline calibration holds, and the conditional table is the part worth showing. A pooled band passes the same 90% headline test while covering only 74% of the heavy calls and wasting width on the light ones; the conditioned band spreads coverage roughly evenly. That is the difference between "calibrated on average" and "useful on the calls that matter".

![Same coverage, narrower band: pooled 2,007 vs rungs plus correction 1,810 tokens at 90% coverage; 2,412 vs 2,073 at 92%](report-assets/meeting-brief/05-band-width.png)

![P90 coverage inside each fifth of the workload: pooled falls from 99.6% to 74.1%, rungs plus correction stays between 85.8% and 93.8%](report-assets/meeting-brief/06-conditional-coverage.png)

**Personal profile, chronological holdout on 46k local observations (28 Aug 2026).**

| Slice | Baseline → conditioned | Decision |
|---|---|---|
| openai · turn | pinball 5,263 → **2,902 (−45%)**, P90 coverage 47% → **93%** | adopted |
| anthropic · turn | small gain, within margin | flat rung kept |
| both providers · call | conditioning **loses** to the user's own flat distribution | flat rung kept |
| prompt/draft features | anthropic turn P50 −1.1%, P90 −1.4%, mean incl. P99 **+0.5% worse**; 1 of 4 slices clears the 2% margin | rejected by gate; `draftConditioning` forced on for this install only |

Reading: for OpenAI the flat per-user baseline is badly under-covered (47%), and model+reasoning conditioning fixes it. The "cold-start" gain on the Anthropic side looks small only because the bundled profile was trained on this same user's Claude history. The draft-aware bar the user sees is a deliberate override of a gate that failed by a hair, and the brief should say so.

![OpenAI turn scale: P90 coverage 47% flat baseline vs 93% conditioned; pinball 5,263 vs 2,902](report-assets/meeting-brief/07-openai-turn.png)

**Local corpus available for more of this:** ~2,065 Claude Code transcript files (`~/.claude/projects`) and 297 Codex rollout files, 291 of them carrying `token_count` events, spanning January to September 2026 (`~/.codex/sessions`). All one user, one machine.

### Source B: telemetry ingest VM (`sheep-manager-token-forecaster`, GCP)

Pulled over SSH on 1 Sep 2026. The service is `active`, `/healthz` returns 204.

| File | Rows | What it says |
|---|---|---|
| `observations.jsonl` | **30** | 10–13 Aug 2026, all from the sheep-manager smoke test, 28 claude-opus-4-8 + 2 claude-haiku-4-5 |
| `installations.jsonl` | 2 | one installation registered and revoked within 200 ms on 27 Aug (an install/uninstall test) |
| `extension-events.jsonl` | 0 | nothing has ever been sent |

Nothing has arrived since 13 August. Distinct installations with real observations: **one (this one)**. The VM has proven the contract (202/401/400 paths, TLS, hardened unit), not the product.

### Source C: sheep-manager turn-level telemetry (local + VM, deduplicated)

Union of the VM file and `sheep-manager/data/telemetry/observations.jsonl`: **39 unique rows** (29 shared, 9 local-only because the client posts fire-and-forget with no retry, 1 VM-only). 32 sessions, one workflow (`sheep-manager-turn`), 10–13 Aug 2026. 37 rows have a completed `actual`; 2 are forecast-only and are excluded, not counted as hits or misses. 0 rows censored; 2 finished with `error`.

Scored on the 37 completed rows (Anthropic, predictor `baseline-3-boosted/0.3.0`):

| Quantile | Coverage | Mean pinball |
|---|---|---|
| P50 | 21/37 = 57% | 304 |
| P90 | 36/37 = 97% | 302 |
| P99 | 36/37 = 97% | 142 |

Actual output: median 328 tokens, mean 603, max 2,354. Median P50 forecast 519; median actual/P50 ratio 0.63; median absolute P50 error 86% of actual. `expectedOutputKind` was `unknown` on 38 of 39 rows, so none of the kind-conditioning was exercised.

Reading: with n = 37 a 97% P90 hit rate is one miss away from 94% and two from 92%; it says the band is not absurd, nothing more. The P50 running high on tiny orchestration calls (median input 2 tokens after caching) is expected for a prior trained on interactive Claude Code, not on `sheep-manager` sub-turns. Do not quote these three rows as accuracy figures; quote them as "the pipeline round-trips forecast, actual, and censoring correctly".

![Sheep-manager telemetry, 37 completed turns in time order: P50 to P90 band per column with a P99 tick and the actual as a dot; 36 of 37 under P90, one above](report-assets/meeting-brief/10-sheep-manager-telemetry.png)

### The honest one-paragraph answer

The predictor is well validated for **one user's Claude Code history** at the call and turn scale: 90.5% P90 coverage on held-out sessions with tight confidence intervals, 10–17% narrower bands than the naive control at matched coverage, and coverage that stays above 85% even in the heaviest fifth of calls. Personalisation is proven to matter most exactly where the OpenAI story needs it: the flat OpenAI turn baseline covers 47% and conditioning lifts it to 93%. Everything multi-user is at n = 1: the telemetry VM holds 30 rows from a single smoke test, no second installation has ever reported, and the OpenAI forecast for any other user is a labelled static prior. The engineering is reliable; the population evidence does not exist yet.

## Current weaknesses and why they matter

### 1. The real product target is not settled

The system predicts output tokens, but the motivating user question is closer to “How much of my remaining Codex usage will this consume?” Those are not necessarily equivalent. Subscription usage may depend on model, reasoning, cached input, tools, compaction, and internal accounting.

**Why important:** A statistically excellent prediction of the wrong target does not help the user make the intended decision.

### 2. Codex rollout files are an internal artifact

The Codex importer is defensive because the rollout format is not treated as a published third-party API.

**Why important:** A routine Codex update could silently change event shapes, turn boundaries, token semantics, or deduplication behavior and corrupt the training data before visible failures appear.

### 3. There is no OpenAI population prior

A fresh Codex installation uses fixed values until personal history becomes sufficient.

**Why important:** Cold start is when users have the least context for judging the forecast and when the product most needs a defensible prior.

### 4. The bundled profile is one person's Claude history

Thousands of calls are still correlated observations from one person, one toolchain, one account, and a limited set of projects and model eras.

**Why important:** The forecast can be well calibrated for the original user and systematically wrong for another user. Call count cannot substitute for independent users.

The retirement plan is documented in [`docs/MULTI-USER-PLAN.md`](./MULTI-USER-PLAN.md).

### 5. The personal adoption gate needs stronger uncertainty handling

The bundled research pipeline uses session-block bootstrap intervals. The personal companion currently uses a single chronological split and a 2% point-estimate margin.

**Why important:** Calls inside one session are correlated. Treating 100 calls as 100 independent pieces of evidence can promote a noisy personal profile, especially after comparing several candidate configurations.

### 6. P99 needs much more data than P50 or P90

At a group size of 100, an empirical p99 is controlled by approximately one observation.

**Why important:** P99 is presented as the extreme safety estimate, but it is the least stable number. It needs a much higher sample threshold, partial pooling, or a separately validated tail estimator.

### 7. Truncated responses are excluded rather than modelled

Excluding capped responses keeps normal output quantiles from being trained on false completion lengths. However, it removes precisely the observations needed to answer “Will this run hit its cap?”

**Why important:** Avoiding truncation is one of the primary reasons to reserve output capacity. The system needs a separate censored-data or survival model for completion risk.

### 8. Overall calibration can hide conditional failure

The reviewer audit found that a model targeted to 90% overall coverage covered the heaviest predicted fifth at about 85.8%.

**Why important:** The most expensive turns are where under-forecasting hurts most. Overall coverage can look healthy by over-covering easy calls and missing heavy ones.

### 9. The UI may become wallpaper

A correct p50/p90/p99 chip is not automatically useful.

**Why important:** The product succeeds only if it changes a decision or prevents an undesirable outcome. It should be tested against actions such as splitting the task, lowering reasoning, or imposing a budget.

### 10. Documentation has drifted from the current working tree

Examples include the README's “Anthropic only” statement, old corpus counts, and cold-start language that does not distinguish Claude from OpenAI.

**Why important:** In the meeting, stale claims can make the project look less careful than its code actually is. The artifact, evaluation date, provider, scope, and provenance should accompany every headline metric.

## Recommended improvement order

### Priority 0: Define the user-facing target

Decide whether the main outcome is:

- Output tokens.
- Total input plus output tokens.
- Context consumed.
- Subscription quota consumed.
- API cost.
- Wall-clock time.
- Tool-call count.
- Probability of completing within a budget.

**Why first:** The target determines the data schema, loss function, UI, and whether OpenAI cooperation is required. No modelling improvement compensates for the wrong objective.

### Priority 1: Obtain a supported Codex event contract

The ideal event stream would expose stable call and turn identifiers, model, reasoning, exact usage, context window, compaction, retries, finish reason, and subagent relationships.

**Why second:** This changes the system from transcript reverse-engineering into a dependable integration and prevents silent training-label corruption.

### Priority 2: Build a real OpenAI cold-start prior

Collect opt-in, privacy-safe, provider-exact Codex observations from multiple users. Freeze users for leave-one-user-out evaluation. Keep browser DOM estimates separate from provider-exact usage.

**Why third:** An OpenAI-facing product needs an OpenAI reference population. Personalization should improve a population prior, not rescue arbitrary fixed constants.

### Priority 3: Strengthen statistical validation

- Bootstrap whole sessions within users.
- Bootstrap whole users for population claims.
- Report conditional coverage by predicted-risk bucket.
- Use higher sample requirements for p99.
- Add drift alarms and model/CLI-version segmentation.
- Require confidence intervals to clear zero before promotion.

**Why important:** These changes turn a promising local result into evidence that can support claims about other users and future traffic.

### Priority 4: Model truncation and completion risk

Record the requested cap and exact finish reason, preserve censored outcomes, and fit a separate cap-risk model.

**Why important:** Quantiles of naturally completed responses cannot answer the probability that a constrained response would have continued.

### Priority 5: Add fast online calibration

Start with a shrunken per-user multiplier based on completed sessions. Keep it near 1 with little data and allow it to adapt gradually. Move to personal quantile groups only after their own holdout gate passes.

**Why important:** It can correct systematic “this user runs 1.4× longer than the population” differences well before there are enough observations for a stable personal p99.

### Priority 6: Turn predictions into controls

Possible UI actions:

- Run normally.
- Lower reasoning effort.
- Use a cheaper or faster model.
- Split the task into stages.
- Summarize or compact context first.
- Ask for confirmation above the predicted p90.
- Set token, tool-call, time, or cost budgets.

**Why important:** A resource forecast creates value only when it improves a decision. Controls also make it possible to measure prevented overruns rather than merely charting predictions.

## Questions for the OpenAI engineer

If the meeting is short, ask questions 1 through 6 first.

### 1. How does Codex subscription usage relate to observable token usage?

> How does Codex usage accounting depend on input tokens, cached input, output
> tokens, reasoning tokens, tool calls, model choice, reasoning effort,
> compaction, and internal retries? Is there a supported quota or remaining-
> usage interface?

**Why this is important:** This establishes whether output tokens are a useful proxy for the user's actual concern. If quota accounting is materially different or intentionally opaque, the product should target context, API- equivalent cost, time, or completion risk instead of “remaining plan usage.”

**What the answer changes:** The forecast target, telemetry fields, UI labels, and strongest product claim.

### 2. Is there a supported Codex event stream for third-party tools?

> Can a supported interface expose user-turn boundaries, internal calls,
> model and reasoning configuration, exact usage, context size, compaction,
> finish reasons, retries, and subagent relationships?

**Why this is important:** The current integration reverse-engineers local rollout JSONL. A stable event stream would remove the largest reliability risk and provide fields the current parser cannot recover safely.

**What the answer changes:** Whether the companion remains a transcript parser or becomes a supported Codex integration.

### 3. Are Codex rollout JSONL files intended to be consumed externally?

> Are `~/.codex/sessions` rollout files a supported integration surface, or
> can their schema and token semantics change without compatibility guarantees?

**Why this is important:** Even if no better event stream exists, knowing the compatibility expectations determines how defensive the importer must be and whether profiles should be segmented by CLI schema/version.

**What the answer changes:** Release risk, schema monitoring, compatibility tests, and how strongly the project can claim Codex support.

### 4. What exactly do Codex token fields mean?

> Is `reasoning_output_tokens` included inside `output_tokens` or additional to
> it? Is `total_token_usage` session-lifetime, turn-lifetime, or reset by
> resume/compaction? Are usage events final or incremental?

**Why this is important:** These fields are the training labels. A semantic mistake here would make every forecast and accuracy calculation internally consistent but wrong.

**What the answer changes:** Parsing, turn aggregation, cost/context calculation, and historical profile regeneration.

### 5. What is the correct unit for a user-facing forecast?

> From Codex's product perspective, should a resource estimate describe one
> model response, the complete agent turn caused by a human prompt, or the
> entire session?

**Why this is important:** API developers think in responses; users think in tasks. Choosing the wrong scope creates a technically correct number that does not match what the user believes they authorized.

**What the answer changes:** The primary training target and the number shown in the composer.

### 6. Would a hard resource budget be more useful than a forecast?

> Would Codex benefit more from “this turn has p90 usage N” or from “complete
> as much as possible within N tokens, M tool calls, or T minutes”? Could the
> agent adapt its plan to a declared budget?

**Why this is important:** Forecasting describes risk; budgeting controls it. If the agent can plan within a limit, a hard budget may solve the user's problem more directly, with the forecast helping select the budget.

**What the answer changes:** The product could evolve from a passive meter into an execution-control primitive.

### 7. Does Codex already make an internal pre-execution estimate?

> Before a turn begins, does Codex internally estimate output/reasoning tokens,
> tool-call count, latency, difficulty, or expected plan usage? Could a coarse
> resource envelope be exposed without revealing sensitive internals?

**Why this is important:** Provider-side information may contain signals that a client cannot infer from the prompt or past history. A provider estimate could also supply a defensible first-turn prior.

**What the answer changes:** Whether the local empirical forecaster is the primary estimate, a calibration layer over a provider estimate, or unnecessary.

### 8. What identifiers are stable for deduplication and hierarchy?

> Which identifiers reliably connect session, human turn, internal response,
> retry, tool call, subagent, resume, and compaction events?

**Why this is important:** Repeated UI usage updates must not become repeated model calls, while legitimate retries and subagents must not be collapsed. These errors directly bias both per-call and whole-turn quantiles.

**What the answer changes:** Observation identity, deduplication, call/turn aggregation, and incremental import correctness.

### 9. How should completion and truncation be identified?

> Can a client distinguish natural completion, output-token cap, context-window
> exhaustion, cancellation, safety stop, tool failure, and internal retry?

**Why this is important:** A capped output is a censored observation: its recorded length is only a lower bound on how long it would naturally have been. It must not be treated as an ordinary completed response.

**What the answer changes:** Eligibility for quantile training and the ability to build a trustworthy completion-risk model.

### 10. Could Codex support an external status-line or extension hook?

> Could Codex expose a supported custom status item, local plugin hook, or event
> subscription so a companion does not need to wrap the terminal and reserve a
> row externally?

**Why this is important:** The PTY approach works, but it must emulate terminal behavior, discover the correct rollout, and remain compatible with TUI changes. A hook would be simpler and more accessible.

**What the answer changes:** Integration complexity, reliability, Windows/macOS parity, and maintenance cost.

### 11. Could OpenAI publish or enable a privacy-safe cold-start baseline?

> Would OpenAI consider aggregate, anonymized output/turn distributions by
> model, reasoning effort, and product surface, or support an evaluation
> program for opt-in client-side research?

**Why this is important:** The project cannot establish population calibration from one user, and a new Codex user currently gets arbitrary fixed quantiles.

**What the answer changes:** The feasibility and timeline of a defensible OpenAI cold-start forecast.

### 12. Where should this primitive live?

> If a pre-execution resource envelope is useful, should it live inside Codex,
> in the Responses API, in an agent SDK, or in third-party orchestrators?

**Why this is important:** Each location has different information, latency, privacy, and control. The provider has internal signals; an orchestrator knows the user's workflow and intent; a client can personalize locally.

**What the answer changes:** The long-term architecture and whether this repository should become a product, an evaluation package, or a prototype for an upstream feature.

### 13. How would OpenAI test whether the feature helps users?

> What user behavior would demonstrate value: fewer abandoned turns, fewer
> truncations, better task completion per quota unit, more appropriate reasoning
> choices, or users changing prompts before send?

**Why this is important:** Accuracy alone cannot tell whether the chip becomes useful decision support or visual wallpaper.

**What the answer changes:** Product metrics, experiment design, and which UI actions should be built next.

## Relevant official OpenAI API boundary

The official Responses API documentation exposes:

- `max_output_tokens`, an upper bound including visible output and reasoning
  tokens.
- `max_tool_calls` for built-in tools.
- Post-response `usage` with token breakdowns.

The meeting question is whether a **pre-generation distribution or resource envelope** belongs beside those controls, or whether execution budgets are the better primitive.

See [Create a model response — OpenAI API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Claims to avoid in the meeting

Do not say:

- “It predicts exactly how many tokens a request will use.”
- “P90 means 90% confidence that this request will use this number.”
- “It has been validated across many users.”
- “A new Codex user gets a data-backed OpenAI forecast.”
- “The Codex integration uses a supported public transcript API.”
- “Output tokens are the same as Codex subscription usage.”
- “Prompt semantics are the main predictive signal.”
- “A large number of calls gives a reliable p99 automatically.”
- “The telemetry VM shows it working for other users.” It holds 30 rows from
  one smoke test by one installation.

Prefer:

> It produces historical conditional quantiles, clearly labels fallback and
> provenance, and currently works best as a local personal forecaster. The
> OpenAI cold-start prior and supported telemetry contract are still missing.

## Suggested meeting flow

### First two minutes

1. Give the 30-second explanation.
2. Explain call versus turn.
3. State the OpenAI limitation before being asked: personal Codex works, but
   OpenAI cold start is still static.

### Main discussion

Ask questions 1 through 6. Spend time on the answers rather than trying to ask every prepared question.

### If there is extra time

Ask about stable identifiers, truncation, status-line hooks, cold-start data, and evaluation criteria.

### Final question

> If you owned this problem, what would you build first—and what would you
> definitely not build?

This often produces a more candid prioritization than asking whether the existing prototype is “good.”

## The strongest framing to use

> I am not claiming that I can predict the exact cost of a task. I built a
> local prototype that gives a calibrated resource envelope before an agent
> turn begins. I want to understand whether this primitive belongs in the
> agent loop, whether a hard budget would be more useful, and what supported
> OpenAI signals would make either approach reliable.


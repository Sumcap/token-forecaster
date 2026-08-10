# Token Forecaster

Real-time token usage monitoring and probabilistic output-length forecasting
for the Anthropic API. While you compose a Claude request, Token Forecaster
shows a live, provider-counted input-token estimate, your context-window
occupancy, and a historical forecast with measured holdout coverage for how
many output tokens the request is likely to use before you send it.

```text
Model                 Claude Opus 5        extended thinking: on
Input                 18,420 tokens        Anthropic counted
Context usage         18,420 / 1,000,000   1.84%
Reserved output       16,000 tokens
Forecast output       p50: ~500 · p90: ~1,870 · p99: ~6,510
Projected total       p50: ~18,920 · p90: ~20,290
Context after p90     ~979,710 tokens
Risk of output cap    unavailable until cap-aware calibration
Estimated cost        $0.0617 to $0.0843
```

## The core idea: two different problems

**Input tokens are a provider-counting problem.** Anthropic exposes an official
endpoint (`POST /v1/messages/count_tokens`) that estimates the tokenized size
of a request, including system prompt, history, tools, images, and documents.
Token Forecaster uses it as the authoritative pre-generation estimate; actual
request usage can differ slightly. A fast local
character heuristic keeps the UI moving while you type, and every number is
labelled with its source:

- `anthropic_verified` (the provider counted this request)
- `local_exact` / `local_estimate` / `character_heuristic` (labelled estimates)

**Output tokens are a prediction problem.** Nothing can tell you exactly how
long a generation will be before it runs. So Token Forecaster never claims
"this will use 7,243 output tokens". It estimates a conditional distribution:

```text
p50: 3,100 tokens     (median)
p90: 7,400 tokens     (likely upper bound)
p99: 15,200 tokens    (extreme bound)
P(hit max_tokens cap) and P(context overflow)
confidence: low | medium | high
```

Forecasts anchor on hierarchical historical quantiles and then apply a small
quantile-specific correction from privacy-safe prompt intent and exact state
already observed in the current agent loop. On the 9 August 2026 (afternoon)
rolling-origin evaluation, the correction reduces total pinball from 505.0 to
485.9 per call (3.8%, 95% paired session-bootstrap CI [-25.7, -13.6]); the
corpus is a live rolling window, so absolute losses drift between
regenerations while the paired verdicts should not. **The predictor is
deliberately excellent cold**: a caller passing only `{model, maxTokens,
thinkingEnabled}` scores within noise of the full base ladder, and a caller
whose model the profile has never seen gets pooled thinking-conditioned
quantiles (adopted 9 August: −43 pinball/call vs the blended fallback,
leave-one-model-out). See [the live investigation
report](docs/STATE-OF-PLAY.md).

The strongest unresolved regime is a long file/artifact response. Knowing the
future `Write` state has an 11.1% oracle ceiling, but that state is not available
before generation and a prompt-semantic detector reaches only 0.584 AUC. The
telemetry contract therefore records caller-declared output intent before the
call and the observed action only after it. A p90 forecast is still judged by
one thing: do roughly 90% of eligible outputs actually fall below it?

Responses truncated at `max_tokens` are treated as right-censored
observations (natural length >= observed length), excluded from ordinary
regression, and fed to a separate cap-risk classifier instead.

## Integration contract

What a calling application passes to `historicalBaselineForecast`, and what it
gets when it passes something the profile does not know about.

### What to pass

```ts
import {
  BUNDLED_CLAUDE_CODE_PROFILE,
  historicalBaselineForecast,
  promptForecastFeatures,
  promptMentionsPath,
} from "@token-forecaster/predictor";

const turnPrompt = "update docs/STATE-OF-PLAY.md";
const { forecast, calibration } = historicalBaselineForecast(
  {
    model: "claude-opus-5",   // required
    maxTokens: 16_000,        // required
    thinkingEnabled: true,    // optional, but pass it — see below
    promptMentionsPath: promptMentionsPath(turnPrompt),
    boostedContext: {
      prompt: promptForecastFeatures(turnPrompt),
      agentLoop: {
        sessionPosition: 12,
        loopDepth: 3,
        priorCallCount: 3,
        priorMaxOutputTokens: 2_840,
        priorArtifactCount: 1,
        priorWriteObserved: true,
        priorArtifactObserved: true,
      },
    },
  },
  BUNDLED_CLAUDE_CODE_PROFILE,
);
```

| Field | Required | What it does |
|---|---|---|
| `model` | yes | Canonical id (`claude-opus-5`) or a dated snapshot. Snapshots are resolved through `profile.modelAliases`, which is generated from the model registry. |
| `maxTokens` | yes | Positive integer. Every returned quantile is clamped to it, so a forecast never promises more than the request allows. |
| `thinkingEnabled` | no, **but pass it** | Selects the thinking-conditioned group. Worth ~10% of total pinball loss. |
| `promptMentionsPath` | no, **but derive it when the turn prompt is available** | Selects the prompt-path dimension when the profile carries it. Use `promptMentionsPath(turnPrompt)`; raw prompt text is not stored in the profile. **The current bundled profile ships no `promptPath` groups** — the feature's own gate refused it on the 9 August afternoon corpus (it is endpoint-sensitive; see STATE-OF-PLAY §7.3) and the eval re-tests it every regeneration. Pass it anyway: it costs nothing and takes effect the moment it re-clears. |
| `boostedContext.prompt` | no | Privacy-safe aggregates from `promptForecastFeatures(turnRootPrompt)`. No raw text enters the profile. |
| `boostedContext.agentLoop` | no, **required for the trained correction** | Exact pre-call session position, parent depth, and completed parent-chain summaries. Every history field is known before this call. If the context is absent or incomplete, the correction is skipped and confidence is `low`. |
| `previousOutputTokens` | no | Output tokens of the previous call in the same agent loop. The ladder rung exists and the eval re-tests it on every regeneration, but **no shipped profile currently contains these groups** — the effect failed its adoption gate on the latest corpus (see [docs/STATE-OF-PLAY.md §7.1](docs/STATE-OF-PLAY.md#-71-previousoutputtokens--implemented-gated-and-currently-refused)). Pass it anyway if you have it: it costs nothing and it takes effect automatically the moment the gate passes. |
| `outputEffort`, `taskType` | no | Accepted, but no shipped profile contains these groups, so passing them changes nothing today. `outputEffort` **is** recorded in Claude Code transcripts (~52% of calls) — it was measured as a candidate dimension and **rejected**: the apparent 4.6× separation between levels does not survive holding date and model fixed. See [docs/GENERATIVE-MODEL.md §3](docs/GENERATIVE-MODEL.md#3-effort-is-recorded--and-it-does-not-survive-contact-with-the-confound). |

Nothing else is read. Input size and tool count are deliberately **not**
parameters: both were measured, both made the p99 worse or carried no signal,
and both were removed from the backoff ladder.

> **`thinkingEnabled` is tri-state on purpose.** Omitting it means *unknown*,
> not *disabled*. The no-thinking groups have roughly a third of the p99 of the
> thinking groups, so defaulting an unknown request to "no" would under-forecast
> a thinking request by about 3x at the tail. An omitted flag instead skips
> every thinking rung and falls back to the broader model-only group: safe, but
> you forfeit the largest single gain the predictor has. Pass `true` or `false`
> explicitly whenever you know.
>
> **`promptMentionsPath` is tri-state too.** Pass `true` or `false` only when
> the human turn-root prompt was observed. Omitting it means *prompt unknown*
> and skips both prompt-path rungs; it must not be coerced to `false`.
>
> **`previousOutputTokens` is tri-state for the same reason.** Omitting it means
> *no previous call / not tracked*, not *the previous call was short*. Turn-
> opening calls have no predecessor and are the **longest** calls in the corpus,
> so filing them under the smallest bucket would poison it in the one direction
> that matters. A previous call that genuinely produced 0 tokens is a
> measurement — pass `0`, and it selects the `lt200` bucket.
>
> **Agent-loop history must be complete.** When `priorCallCount > 0`, all four
> prior-history fields are required. Missing means unknown; the predictor never
> converts it to `false` or zero. The correction also stays off when thinking
> mode is unknown or the selected historical group is a pooled fallback.

### What you get back when the profile does not know your request

There is no silent degradation. `calibration.usedFallback` says the historical
group is not conditioned on your model;
`calibration.boostedCorrectionApplied` and `boostedCorrectionReason` separately
say whether the trained correction had enough forecast-time context to run:

| Situation | `groupKey` | `usedFallback` | `forecast.source` | `confidence` |
|---|---|---|---|---|
| Known model + thinking + complete loop context | most specific populated rung | `false` | `trained` | `medium` at n >= 500 |
| Known model, correction context incomplete | most specific populated rung | `false` | `historical` | `low` |
| Model known, thinking omitted | `model=…` | `false` | `historical` | `low` |
| **Model not in the profile**, thinking known | `thinking=…` | **`true`** | `historical` | `low` |
| **Model not in the profile**, thinking omitted, prompt-path known and shipped | `promptPath=…` | **`true`** | `historical` | `low` |
| **Model not in the profile**, nothing else known | `overall` | **`true`** | `historical` | `low` |
| Even `overall` below `minSamples` | `null` | **`true`** | `default` | `low` |

The fallback rows are the ones to handle. The pooled `thinking=…`,
`promptPath=…` and `overall` groups all blend models the profile *was* fitted
on — Fable 5, Opus 4.8 and Opus 5 — so they are workload-shaped priors, not
statements about the model you asked for. The pooled thinking rung is the best
of them (adopted 9 August 2026: −43 pinball/call vs `overall` on
leave-one-model-out calls), which is one more reason to always pass
`thinkingEnabled`. Treat any `usedFallback` forecast as a rough reservation
hint and say so in your UI; do not present it as calibrated.

Unknown model ids never throw. `historicalBaselineForecast` throws only on a
malformed request: empty `model`, non-positive-integer `maxTokens`, or a
`previousOutputTokens` that is negative or non-finite. `null` and `undefined`
are *not* malformed on any optional field — both mean "not set" and skip their
rung. The
separate `requireModel()` in `@token-forecaster/model-registry` *does* throw
`UnknownModelError`, so add a model there before relying on its context window
or pricing.

### What is not available

`forecast.probabilityOfOutputCap` is always `undefined`. Our corpus contains
zero censored calls, so cap risk cannot be fitted at all — and it cannot be
invented from three quantiles. It stays absent until Phase 3 telemetry collects
calls where `max_tokens` actually binds.

## Anthropic first

The MVP targets the Anthropic API and Claude models only. This is deliberate:

- Input counting uses Anthropic's own endpoint instead of a reimplemented
  tokenizer, so it is provider-counted and may differ only slightly from final
  request usage.
- Model limits and pricing live in one versioned registry
  (`packages/model-registry`) with source and verification dates, not
  scattered constants.
- Output-length distributions are model-specific; one well-instrumented
  provider beats three half-instrumented ones.

The architecture keeps provider-neutral primitives only where they are
natural (schemas, context-budget math). OpenAI, Gemini, OpenRouter, and
open-weight models are out of scope for the MVP.

## Privacy defaults

The tool is also a data-collection instrument for its own research question,
so telemetry is designed for privacy from day one:

- Raw prompts are **not** stored by default. The default storage mode is
  `hash_only`: prompt hash, derived numeric features, token counts, request
  configuration, forecast, and actual usage.
- Storage modes: `none`, `hash_only` (default), `redacted`, `full_opt_in`
  (explicit local development mode only).
- API keys stay server-side. The browser never sees them and they are never
  logged.
- No hosted backend. Observations are append-only local JSONL files you own;
  [the VM collection guide](docs/TELEMETRY.md) covers encrypted deployment and
  chronological user/session-block evaluation.

## Repository layout

```text
token-forecaster/
├── apps/playground/       Vite + React playground; Express count_tokens server
├── packages/
│   ├── core/              Zod schemas, context-budget math, warning logic
│   ├── anthropic/         Server-side adapter: count_tokens, streaming, usage
│   ├── model-registry/    Versioned model limits and pricing with provenance
│   ├── token-counter/     Local estimator, debounce, race-safe reconciliation
│   ├── predictor/         Historical ladder + portable quantile correction
│   ├── telemetry/         Schema-valid privacy-aware JSONL observation logging
│   ├── react/             Hooks and components (Phase 6)
│   └── cli/               count | forecast | run | evaluate | export (Phase 3+)
├── experiments/           Datasets, training, evaluation (Python, later phases)
├── research/              Competitive analysis, literature review, ADRs
├── fixtures/              Race-condition fixtures for count reconciliation
└── docs/BACKLOG.md        Phased plan
```

## Getting started

```sh
pnpm install
pnpm build          # build workspace packages (server imports built output)
pnpm test           # vitest across packages
# Refresh report, JSON profile, and bundled profile. Needs `pnpm build` first:
# the eval generates model aliases from the built model registry.
pnpm evaluate:claude-history

# Start both the count_tokens server and UI on http://localhost:5199.
# Provider verification needs ANTHROPIC_API_KEY or an `ant auth login` profile.
pnpm dev
```

Type into the playground: the count updates instantly from a labelled local
estimate, then flips to `Anthropic counted` after a debounce. Older
verification responses can never overwrite newer counts (see
`fixtures/count-race-conditions.json`).

For separate terminals, use `pnpm dev:server` for the API and `pnpm dev:ui` for
Vite. The UI stops its verification indicator and keeps the local estimate if
the API fails or takes longer than 20 seconds.

## Status

Phase 1/2 foundations plus the adopted Baseline 3 predictor: schemas, model
registry, context-budget engine, race-safe counting, hierarchical quantiles,
portable trained corrections, chronological/rolling evaluation, privacy-safe
JSONL telemetry, and the playground. Provider execution and multi-user data
collection remain; see `docs/BACKLOG.md`, `docs/TELEMETRY.md`, and
`research/decisions/`.

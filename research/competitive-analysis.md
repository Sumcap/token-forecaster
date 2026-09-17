# Competitive analysis

Research notes for Token Forecaster. Surveyed August 2026. Each project below was
checked against its live GitHub page (or marketplace listing); none of the
summaries are speculative unless marked as such.

Token Forecaster's frame, restated for comparison purposes: input token counting
is a solved deterministic problem (call Anthropic's
`POST /v1/messages/count_tokens`), while output length is a prediction problem
that needs quantile estimates, censored-data handling, and post-hoc calibration.
The question for each competitor is which half of that frame they occupy and
how rigorously.

## CodeSarthak/tarmac

Repo exists. TypeScript, ~17 stars, 23 commits on main at time of survey.
Tagline: know what your AI coding task will cost before it runs.

What it does:

- Pre-flight cost estimation for Claude Code tasks. Intercepts the prompt and
  shows a calibrated cost range before execution.
- Extracts 24 hand-crafted features from the prompt: text length metrics, code
  signals (code blocks, file paths, function names), error indicators,
  vocabulary richness, and task-keyword flags ("fix", "refactor", "test").
- Trains separate ridge regression models per Claude model (Opus, Sonnet,
  Haiku), predicting log10(cost) rather than raw cost.
- Wraps the point prediction in distribution-free split conformal prediction to
  produce 80% intervals with no distributional assumptions.
- Validated against 3,381 real tasks (3,000 SWE-bench instances plus 381 local
  sessions), with prediction-vs-actual reconciliation tooling.

What is reusable:

- This is the closest technical baseline to Token Forecaster. The pipeline
  shape (feature extraction, per-model regressor, conformal wrapper,
  reconciliation loop) is exactly the architecture we intend, and it is in
  TypeScript, so patterns transfer directly.
- The 24-feature list is a good starting vocabulary for prompt features.
- Predicting in log space is the right call for a heavy-tailed target and we
  should copy it.
- The SWE-bench-derived validation set idea is worth borrowing for benchmarks.

What it does not solve:

- It predicts a single cost number with one symmetric-ish interval, not a
  quantile set (p50/p90/p99) or a distribution.
- Input tokens are estimated heuristically from features rather than counted
  by the provider API, so its "input" half has tokenizer-proxy error that ours
  avoids.
- Ridge regression on 24 features gives a point estimate of the conditional
  mean (of log cost); it cannot express the asymmetric tail risk that matters
  for budgeting.
- No handling of right-censored observations (runs that hit a cap), no
  cap-probability output, no context-overflow probability.
- Scoped to Claude Code coding tasks specifically, not arbitrary Messages API
  requests.

## kevmo314/tokencap

Repo exists. TypeScript/JavaScript, MIT licensed, but very early: about 10
commits, 0 stars, 0 forks at time of survey. Treat as a positioning statement
more than a proven codebase.

What it does (per README):

- Positions itself as "the only LLM cost tool that predicts costs before
  execution", explicitly contrasting with post-hoc trackers.
- Pre-execution estimates with confidence intervals for input and output
  tokens.
- Budget enforcement: hard caps with auto-kill of over-budget runs.
- Agent-chain tracking across multi-step workflows, including loop detection.
- Claims multi-provider coverage (300+ models) via three integration modes:
  SDK wrapper, proxy server, or pre-flight estimation. Self-hostable, zero
  external dependencies.

What is reusable:

- The product positioning and integration-surface menu (wrapper vs proxy vs
  pre-flight call) is a useful map of how users might want to consume Token
  Forecaster.
- Budget enforcement as a downstream consumer of a forecast (kill or warn when
  p99 cost exceeds budget) is a feature we can support cleanly because we emit
  quantiles; their design validates the demand.
- Agent-chain loop detection is a good idea for a later multi-step forecasting
  mode.

What it does not solve:

- With 10 commits, the estimation methodology is thin; there is no evidence of
  trained models, calibration, or reconciliation against actuals. "Confidence
  intervals" appear to be asserted rather than derived from a calibrated
  procedure.
- Breadth-first (300+ models) rather than depth-first, which precludes exact
  provider-verified input counts and per-model output calibration.
- No censoring treatment, no quantile outputs, no drift handling.

## krulewis/tokencast

Repo exists. Python, MIT licensed, 115 commits, 1 star at time of survey.
Focused on agent workflow cost estimation inside coding assistants.

What it does:

- Pre-execution forecasting for agent workflows with
  optimistic/expected/pessimistic bands.
- Infers task scope (size class, file count, complexity) from conversation
  context and decomposes a task into per-step token budgets.
- Recalibration from completed sessions: after 3+ sessions it adjusts
  correction factors using trimmed means and EWMA with outlier filtering;
  after 10+ sessions it calibrates per size class.
- Ships as a Claude Code plugin (MCP server plus calibration hooks), and as an
  MCP server for Cursor, VS Code + Copilot, and Windsurf. Also a Python API
  and a SKILL.md manual mode.
- Calibration data persists locally in `~/.tokencast/`. Telemetry is anonymous
  and opt-out (session counts, calibration accuracy, framework info).

What is reusable:

- The recalibration loop (compare predicted vs actual per session, adjust with
  robust statistics, require a minimum sample count before trusting the
  correction) is a pragmatic pattern worth mirroring in our conformal
  recalibration cadence.
- Local-first persistence of calibration state is the right privacy posture
  and matches our telemetry-off-by-default stance (note: tokencast's telemetry
  is opt-out, ours should be opt-in).
- The MCP integration surface is a proven distribution channel for exactly our
  audience.

What it does not solve:

- Three named scenario bands (optimistic/expected/pessimistic) are not
  calibrated quantiles; there is no coverage guarantee behind them.
- EWMA factor adjustment is heuristic recalibration, not conformal prediction;
  it corrects bias but does not produce valid intervals.
- Python, so nothing is directly importable into a TypeScript MVP.
- No exact input counting, no cap-hit or context-overflow probabilities, no
  censored-data treatment.

## AgentOps-AI/tokencost

Repo exists and is the most mature of the set: Python, MIT, ~2,000 stars, 105
forks, 473 commits, actively maintained.

What it does:

- Cost estimation for 400+ models: client-side token counting plus a
  maintained USD pricing registry (per-token prompt and completion prices,
  model metadata such as context windows).
- Counts tokens with tiktoken for most models; for Claude 3+ it calls
  Anthropic's official token counting API, falling back to cl100k_base
  approximation for older Claude models. Handles both raw strings and ChatML
  message lists (including per-message formatting overhead).
- Pricing data is scraped/synced from provider documentation via an
  `update_prices.py` script and tracked in `pricing_table.md`.

What is reusable:

- The pricing registry is the reusable asset. It is MIT licensed, and the
  underlying data is effectively the same JSON that LiteLLM maintains; for a
  TypeScript MVP we would consume an equivalent JSON registry rather than port
  the Python package. The registry schema (input price, output price, context
  window, max output) is worth adopting.
- Its Anthropic path independently validates our thesis: even a
  breadth-oriented tool concluded that the best preflight count for Claude
  comes from the provider API, not a local tokenizer.
- Cost normalization conventions (per-token USD, prompt vs completion split)
  are a de facto standard we should stay compatible with.

What it does not solve:

- Zero output forecasting. Completion cost is computed only after you already
  know (or guess) the completion token count; the hard half of the problem is
  left to the caller.
- Pricing freshness depends on manual updates; some entries are incomplete.
  Any registry we adopt needs a staleness check.
- Python-only.

## Context-counter UIs: Tokenlint and OpenWebUI counters

Tokenlint is a VS Code extension (marketplace listing, not a public repo we
could inspect) offering real-time token counting and cost estimation with
optimization suggestions as you edit. The OpenWebUI ecosystem has several
community "functions" in the same vein: taylorwilsdon's context counter
(tiktoken cl100k_base, splits total vs assistant-only tokens, counts turns),
revdarkness/openwebui-token-counter (real-time counts and cost across 25+
models), and the community Context Tracker and Universal Token Counter
functions (status-bar token usage, cost, and performance metrics). There is
also an open-webui discussion (#13082) requesting token counts on document
upload with context-aware warnings, which is a good signal of user demand.

What is reusable:

- The UX grammar: a live context bar, warning thresholds as you approach the
  window, and always labeling numbers as estimate vs actual. Users of these
  tools already expect a visual distinction between measured and predicted
  quantities, which maps directly onto our exact-input vs forecast-output
  split.
- Evidence that a passive, ambient counter is wanted at edit time, not only at
  request time.

What they do not solve:

- All are input-side only, and most use tiktoken as a proxy tokenizer for
  every model, so their Claude counts are approximations of the wrong
  tokenizer. None call Anthropic's count endpoint.
- None predict output at all, let alone as a distribution. "Cost estimation"
  in these tools means multiplying a guessed completion length by a price.

## Differentiation

None of the surveyed projects does pre-generation probabilistic output
forecasting with statistical guarantees. Token Forecaster's specific gaps to
fill:

1. Calibrated quantile forecasts of output tokens (p50/p90/p99) before
   generation, with conformal calibration giving finite-sample coverage,
   rather than a point estimate (tarmac, tokencost consumers), asserted
   intervals (tokencap), or named scenario bands (tokencast).
2. Explicit cap-risk and overflow-risk outputs: probability the response hits
   `max_tokens`, and probability the request plus forecast output overflows
   the context window. No competitor emits either.
3. Censored-observation handling: responses truncated at `max_tokens` are
   treated as right-censored, not as ordinary regression targets. Every
   competitor that learns from actuals (tarmac, tokencast) ingests truncated
   runs as if they were complete, which biases estimates downward exactly in
   the tail that matters.
4. Anthropic-counted input estimates: the input half uses
   `POST /v1/messages/count_tokens`, avoiding a tiktoken approximation while
   allowing for the small difference Anthropic documents between preflight
   count and final usage. Only tokencost does this, and only for the
   already-known input side.
5. Privacy-default telemetry: calibration data stays local; any sharing is
   opt-in (tokencast is the closest but defaults to opt-out telemetry).
6. Depth over breadth: Anthropic-only MVP allows per-model calibrated
   forecasters instead of a shallow 300-model matrix.

The strongest borrowable ideas are tarmac's end-to-end pipeline (features,
per-model regressors in log space, split conformal, reconciliation) and
tokencost's pricing registry schema; the strongest validated demand signals are
tokencap's budget enforcement framing and tokencast's MCP distribution channel.

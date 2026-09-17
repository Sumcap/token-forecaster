# ADR 0001: The MVP is Anthropic-only

Date: 2026-08-01
Status: accepted

## Context

The project needs provider-counted input estimates, normalized usage telemetry, and
model-conditioned output forecasts. Every provider differs in tokenizers,
usage reporting, limits, and pricing. Supporting several providers from the
start multiplies surface area while the core hypothesis (can black-box output
forecasting be made calibrated and useful?) is still unproven.

## Decision

The first releases target the Anthropic API and Claude models exclusively.
Provider-neutral code exists only where it is naturally neutral: schemas,
context-budget arithmetic, warning logic. The adapter interface is
`AnthropicTokenService`, not `ProviderTokenService`.

## Consequences

- Input counting can rely on `POST /v1/messages/count_tokens` instead of a
  third-party tokenizer approximation; final usage may differ slightly.
- The dataset stays homogeneous, which makes the first predictor baselines
  and their evaluation interpretable.
- Adding a second provider later means writing a new adapter package and
  generalizing interfaces at that point, with real requirements in hand,
  instead of guessing them now. Premature abstraction is explicitly rejected.

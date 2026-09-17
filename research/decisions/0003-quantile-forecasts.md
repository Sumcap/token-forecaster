# ADR 0003: Output forecasts are quantiles, not point estimates

Date: 2026-08-01
Status: accepted

## Context

Output length is stochastic even for a fixed prompt, and prompt-conditioned
length distributions are heavy-tailed. A single expected value hides exactly
the information users need for budgeting: how bad the tail can get, and how
likely the generation is to hit the configured cap or overflow the context.

## Decision

Every forecast is a distribution summary:

- p50, p90, and (when supported by data) p99 quantiles
- probability of hitting `max_tokens`
- probability of context overflow
- an explicit confidence label and predictor version

Point-estimate claims ("this will use exactly N output tokens") are banned
from UI copy and API responses. Warnings are phrased probabilistically
("estimated 18% probability of hitting the 4,000-token cap"), never as
certainties.

## Consequences

- Evaluation is honest: a p90 forecast is judged primarily by empirical
  coverage (roughly 90% of eligible outputs below it), plus pinball loss and
  interval width, not by MAE alone.
- Conformal calibration slots in naturally as a later phase because the
  interface already speaks in quantiles and coverage targets.
- Censored observations (responses truncated at max_tokens) are handled
  separately from ordinary regression targets, feeding the cap-risk estimate.

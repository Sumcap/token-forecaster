# ADR 0005: The MVP begins without prompt embeddings

Date: 2026-08-01
Status: accepted

## Context

Prompt embeddings are an obvious feature source for output-length prediction,
but they add a model dependency, inference cost, latency in the composing
loop, and a privacy question (they require raw prompt text at embedding
time). Meanwhile the literature and the closest prior art (tarmac) suggest
that structured features (verified input tokens, explicit length constraints,
task family, requested item counts, model identity, max_tokens) capture much
of the signal.

## Decision

Predictor baselines progress in this order, each evaluated before the next is
added:

```text
B0 static fallback -> B1 rules from explicit constraints -> B2 historical
medians -> B3 structured quantile regression -> B4 conformal calibration
```

Embeddings (B8) are considered only after structured baselines have been
evaluated, and only if the evaluation shows a gap that structured features
cannot close.

## Consequences

- The forecast path stays fast enough to run while the user types.
- Every added model complexity must justify itself against a measured
  baseline, which is the project's core methodological stance.
- The telemetry schema reserves room for richer features without requiring
  raw prompt storage (see ADR 0004).

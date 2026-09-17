# ADR 0004: Raw prompts are not stored by default

Date: 2026-08-01
Status: accepted

## Context

The tool doubles as a data-collection instrument: every request/response pair
becomes a `ForecastObservation` used to train and evaluate predictors. But
prompts routinely contain proprietary code, personal data, and secrets.
Defaulting to raw storage would make the local dataset a liability and the
tool unusable in most workplaces.

## Decision

The default prompt storage mode is `hash_only`. An observation stores: prompt
hash, derived numeric features (token counts, structural counts, extracted
constraints), task classification, language, request configuration, forecast,
and actual usage. Available modes:

```text
none | hash_only (default) | redacted | full_opt_in
```

`full_opt_in` exists for local experiments only and must be enabled
explicitly. Anthropic API keys are never logged and never leave the server
process.

## Consequences

- Predictor baselines are designed to work from derived features rather than
  raw text, which also keeps them cheap and fast.
- Prompt embeddings (which require raw text at embedding time) are deferred;
  when they arrive, embedding happens before storage so raw text still does
  not need to be persisted.
- Datasets can be shared and versioned with far lower risk.

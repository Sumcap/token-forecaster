# ADR 0002: The provider count is authoritative

Date: 2026-08-01
Status: accepted

## Context

Two sources can produce a pre-generation input count: a local
tokenizer/heuristic and Anthropic's count_tokens endpoint. Local counts are
fast but approximate; tokenizer behavior also drifts across model versions
(the Sonnet 5 tokenizer produces roughly 30% more tokens than Sonnet 4.6 for
the same text). After generation, the API's reported `usage` is a bill, not
an estimate.

## Decision

- Before generation: the count_tokens result is the authoritative input
  count. Local counts are UX optimizations, always labelled
  (`character_heuristic` / `local_estimate` / `local_exact`), never silently
  presented as exact.
- After generation: the API-reported `output_tokens` (and input/cache fields)
  are the authoritative usage values and are stored verbatim.
- Race rule: an older verification response can never replace a newer count.
  The reconciliation state machine in `packages/token-counter` enforces this
  and is fixture-tested.

## Consequences

- We never reimplement Anthropic's tokenizer, so the preflight estimate tracks
  provider behavior. Anthropic documents that final request usage can still
  differ slightly from the count_tokens result.
- Verification costs API calls, so it is debounced and re-triggered only on
  meaningful changes (model, system, history, tools, documents, explicit
  request, and immediately before execution).
- The UI must always disclose count provenance; that is part of the schema
  (`CountQuality`), not a styling detail.

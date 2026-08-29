# ADR 0001 — A macOS menu-bar companion with a Node brain

Date: 2026-08-28
Status: accepted, implemented as a vertical slice

## Context

Token Forecaster shipped a forecasting model trained once, on one corpus, and
frozen into `packages/predictor/src/bundled-profile.ts`. Every user got the same
quantiles. The product goal is the opposite: before an agentic task runs,
forecast the output tokens *this* person's setup will actually produce, learned
from *their* Codex and Claude Code history, on their machine.

Two local corpora already exist on a developer's disk:

| Source | Location | This machine |
| --- | --- | --- |
| Codex CLI rollouts | `$CODEX_HOME/sessions`, else `~/.codex/sessions` | 294 files, 320 MB |
| Claude Code transcripts | `~/.claude/projects` | 2,204 files, 1.3 GB |

Both carry exact provider token counts. Neither may be uploaded, and neither
may have its prompt text copied into anything Token Forecaster persists.

## Decision

### The model stays in TypeScript. The menu bar is a thin client.

The single largest risk was ending up with two implementations of the
forecaster — one in TypeScript for the extension and evaluation harness, one in
Swift for the app — that drift apart. So:

- **All** import, storage, training, evaluation and forecasting logic lives in
  TypeScript workspace packages, reusing `@token-forecaster/predictor` for the
  cold-start fallback and `OutputForecast` shape.
- A Node background process (`apps/companion`) owns the database and serves an
  authenticated loopback HTTP API.
- The macOS menu-bar app (`apps/menubar`) is Swift/AppKit and contains **no
  forecasting logic at all**. It reads `/health` and renders it. Deleting the
  Swift app would cost the UI and nothing else.

The Swift app is a SwiftPM executable assembled into an `LSUIElement` `.app`
bundle, because this machine has Command Line Tools but no full Xcode. That
rules out `.xcodeproj`/`xcodebuild` and SwiftUI's `MenuBarExtra` scene lifecycle
in favour of `NSStatusItem` + `NSMenu`, which is also less fragile.

### Codex transcripts are treated as an unstable import format

`$CODEX_HOME/sessions` is an internal CLI artifact, not an API. A survey of all
105,496 rows on this machine found at least five envelope shapes, including
three legacy ones that predate the `{ timestamp, type, payload }` wrapper.

`@token-forecaster/ingest-codex` therefore never throws on a row. Every row is
either used or counted against a named `SkipReason`, and unrecognised event
types are counted by name so format drift shows up as a number in the dashboard
rather than as silently missing data. On the real corpus the accounting is:

```
294 files, 15,941 usable rows
skipped: duplicate_usage=10,030  missing_usage=223
         zero_output=35  unsupported_schema_version=18
```

The 10,030 duplicates are real: the CLI re-emits `token_count` for UI refreshes,
so a call is identified by its cumulative total plus its per-call usage.

### The Claude loader was extracted, not reimplemented

`experiments/evaluation/lib/load-history.mjs` already handled the hard parts —
agent-loop reconstruction by `parentUuid` walk, turn roots, one row per content
block sharing a `requestId`. It moved verbatim to
`packages/ingest-claude/load-history.mjs`, with a re-export shim left at the old
path so all 28 existing consumers and the evaluation suite keep working
untouched. `@token-forecaster/ingest-claude` adds only the typed adapter to
`UsageObservation`.

### Providers and scales are never pooled

A personal profile is partitioned by `(provider, scale)` before any grouping
happens. OpenAI and Anthropic tokens are not interchangeable, and a per-call
distribution is not a per-turn one — on this corpus the per-call P50 is 172
tokens and the per-turn P50 is 5,515. Pooling them would be arithmetic on
incomparable quantities.

Within a slice, hierarchical empirical quantiles back off along
`[model, reasoning] → [model] → [reasoning] → overall`. A dimension whose value
is unknown removes the rung entirely rather than collapsing to a level such as
`"none"`, which would pool "no thinking" with "thinking not recorded".

### Whether to condition at all is a per-slice, held-out decision

This is the part that changed after seeing real numbers. The first
implementation adopted prompt features globally if they won on a majority of
slices — and they "won" two slices by less than 0.1%, which is noise.

Now: every candidate is fitted on the earlier 70% of a slice's timeline and
scored on the strictly later 30%, and a candidate must cut pinball loss by at
least 2% (`ADOPTION_MARGIN`) to be adopted. The decision is recorded per slice
in `PersonalProfile.scales[key].conditioned`. A slice where conditioning lost
keeps only its unconditional rung, and `personalForecast` naturally reports
`source: "personal_overall"` for it.

### Cold start is first-class and never silent

Every forecast reports which data produced it: `personal_group`,
`personal_overall`, `bundled_fallback`, or `static_baseline`. Anthropic cold
starts reuse the bundled Claude Code profile through the existing predictor.
**OpenAI cold starts do not** — there is no bundled OpenAI profile, and
borrowing Anthropic quantiles would be exactly the cross-provider pooling this
design exists to prevent — so they fall to the static baseline and say so.

### Privacy is a schema property, not a policy

Raw prompt and response text never reaches persistence, and this is enforced
structurally rather than by convention:

- `extractPromptFeatures(text, salt)` in `@token-forecaster/core` is the only
  place text is touched. It returns counts plus a salted 16-hex-char hash;
  callers discard the text immediately.
- The `observations` table has no column that can hold text. A test pins its
  exact column set, so a migration that adds one has to change the test on
  purpose.
- The salt is per-install and rotates on reset, so a hash is not comparable
  across machines and survives no reset.
- The dashboard is served with `default-src 'none'` and contains no `<script>`.

### The local API is deliberately small

Loopback bind only, a per-install bearer token compared in constant time, no
CORS header at any origin, `runtime.json` written `0600`, and a 256 KB request
body cap. Seven endpoints: `/health`, `/profiles`, `/forecast`, `/rebuild`,
`/pause`, `/settings`, `/reset`, plus `/dashboard`. Nothing returns text,
because nothing stores text.

### Persistence is incremental by file identity

SQLite via `node:sqlite` (no native build step). Cursors are keyed by
device+inode with size and mtime, so an unchanged transcript is never reopened —
a restart costs one `stat()` per file, not 1.6 GB of reading. A file that grew
is re-parsed from the start but *emits* only rows past its cursor, because turn
roots, the current model and the duplicate set are carried-forward state that a
blind seek would lose.

## Consequences

- Two languages, but one model. The Swift side has no behaviour to keep in sync.
- The Chrome extension can become a client of `/forecast` later without any of
  this changing. It was deliberately not made a dependency of the first slice.
- `node:sqlite` is experimental in Node 22 and prints a warning; `--no-warnings`
  suppresses it. If it moves, the store is the only file that changes.
- The importers run synchronously on the event loop, so the API is unresponsive
  during the ~8 s full scan. Acceptable for a background app at this size; a
  worker thread is the fix if scans grow.

### "How much data is enough" is measured, not asserted

The obvious way to answer this in a UI is to invent a threshold ("you need
1,000 calls"). Instead `measureSufficiency` refits the deployed model on
progressively larger windows of the user's *most recent* history — recent, not
oldest, because the product always has your latest history and the question is
how far back it needs to reach — and scores every fit against the same
strictly-later holdout. Two numbers come out of the curve:

- **`beatsColdStartAtN`** — the smallest measured window at which the personal
  model beat the generic one. The number a new user actually cares about.
- **`saturationN`** — the smallest window within 5% of the best loss on the
  curve. Past this, more history stops buying accuracy.

When `saturationN` falls under a quarter of the available training data the
slice is flagged `recencyDominates`, because that means the archive is not
carrying the forecast — recent habits are.

## Held-out results on this machine

Fitted on the earlier 70% of each slice, scored on the strictly later 30%.
Lower pinball is better; coverage should sit near the nominal quantile.

| Slice | n (holdout) | Best | Pinball vs cold start | P90 coverage |
| --- | --- | --- | --- | --- |
| openai · turn | 248 | `personal_core` | 5,263 → 2,902 (−45%) | 47% → 93% |
| anthropic · turn | 577 | `personal_prompt` | 5,601 → 5,068 (−10%) | 73% → 85% |
| openai · call | 4,728 | `personal_flat` | 304 → 154 (−49%) | 99% → 92% |
| anthropic · call | 8,360 | `personal_flat` | 537 → 511 (−5%) | 83% → 85% |

Read honestly:

- **Personalization clearly wins on turn totals**, which is the number the
  product actually wants — the pre-task "what will this cost" question.
- **Conditioning does not always win.** On both per-call slices, this user's
  unconditional distribution beat the model-conditioned one, so the trained
  profile stores only the flat rung there. That is the evaluation doing its job.
- **Prompt features were rejected** (1/4 slices cleared the 2% margin). They are
  implemented and will be adopted automatically if a future corpus supports
  them.
- The anthropic·call gain is small **because the bundled profile was itself
  trained on this user's Claude history** — the "cold start" baseline is already
  most of the way personalized. On a different user it would be much larger.
  The openai·turn row, where the bundled profile has no relevance at all, is the
  better estimate of what a new user gains.

## How much history is enough

| Slice | Beats the generic profile at | Stops improving at | Available | Verdict |
| --- | --- | --- | --- | --- |
| openai · turn | **36** | 144 | 825 | plateaued |
| anthropic · turn | 336 | 673 | 1,923 | plateaued |
| openai · call | 689 | 689 | 15,759 | plateaued |
| anthropic · call | 1,221 | 1,221 | 27,923 | working |

The surprise is how small these numbers are. Roughly **two days of Codex use**
puts the personal turn-total model ahead of the shipped profile, and a couple of
weeks saturates it. Three of the four slices are `recencyDominates`: the most
recent quarter of the archive forecasts as well as all of it.

Two consequences worth acting on:

1. Onboarding is cheap. A new install is useful almost immediately, which
   removes the argument for shipping a multi-user profile as a stopgap.
2. **More data is not the lever.** Every plateaued slice is limited by what the
   model conditions on, not by volume. The next real accuracy gain has to come
   from better features — task shape, repository, tool mix — and each will have
   to clear the same 2% held-out margin that prompt features just failed.

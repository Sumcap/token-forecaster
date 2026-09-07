# Plan of attack: text telemetry, a public base, local post-training

*Written 4 September 2026. Decision by the user; plan and gates by Fable
5.1; implementation by Opus subagents. Supersedes the sequencing in
`docs/SEMANTIC-PLAN.md` Stages 1–3 and `docs/MULTI-USER-PLAN.md` Phase 5
where they conflict; everything else in those documents stands.*

## The decision

1. **Telemetry gathers prompt text**, behind explicit opt-in, so the pooled
   text head can be trained on real prompts from more than one person.
2. **The shipped model becomes a weaker base trained on public and pooled
   data, post-trained on the installing user's own data on their machine.**
   The single-user bundled profile stops being the cold-start prior.
3. **More data beats exact fit.** Correctness of the agent's work is
   irrelevant to us; a failed run labels a turn as well as a passing one.

## Why now, in one paragraph

Three days of probes closed every pre-call signal on one user's corpus:
prompt text about 1%, repository state refused, session-so-far refused,
re-forecast-as-you-go real but under the margin (STATE-OF-PLAY §6.32–6.34).
The fold spreads in every one of those tables are the signature of one
person's few dozen long turns deciding the number. The corpus, not the
model, is the constraint. The two things that fix it are other people's
turns and other people's prompts, and neither can be collected
retroactively, so collection starts before the next modelling round.

## What already exists and is reused, not rebuilt

| piece | where | state |
|---|---|---|
| Observation schema, features only | `packages/core/src/schemas.ts` `forecastObservationSchema` | shipped; `promptStorageModeSchema` has `none / hash_only / redacted / full_opt_in` but no text field and nothing enforces the mode |
| JSONL writer, HTTP ingest, extension ingest | `packages/telemetry` | shipped; ingest VM live since 10 Aug, 30 rows, one installation ever |
| Telemetry client | sheep-manager PR #33 | ships features + usage per call, opt-in |
| Personal store, trainer, evaluator, sufficiency | `packages/personal` | shipped; post-trains the quantile ladder per slice, gated at 2% margin, bundled profile as fallback |
| Companion daemon, status line, launchers | `apps/companion` | shipped; ingests `~/.claude` and Codex sessions into the store; uploads nothing |
| Public hashed text head + trainer | `packages/predictor/src/base-text-head.ts`, `semantic/train_base_head.py` | built on 35k public turns; v4 correction refused at −0.31% |
| Public harvester | `semantic/harvest_github_chats.py` | 35k turns from specstory/aider/cline; flattens to prompt→reply, tiktoken counts, median 1 call |
| Five-fold session gate, bootstrap, typing check | `eval-winning-boost.mjs`, `probe_semantic_scale.py` | the house gate |

## Track 1: telemetry v2, prompts and loop structure

**Schema.** Add to the observation request side, all optional:

- `promptText`: the cleaned turn-root prompt, harness wrappers removed the
  way `cleanPromptText` in the loader does it, capped at 8,000 characters.
  Present only when `promptStorageMode` is `redacted` or `full_opt_in`.
- `promptStorageMode`: required whenever `promptText` is present; the
  writer and the ingest reject a row that carries text under `none` or
  `hash_only`. This is the enforcement the enum has been missing.
- `redacted` mode applies one redactor on the client before the row is
  built: file paths to `<path>`, URLs to `<url>`, e-mail addresses, long
  hex and base64 runs, and anything matching the secret patterns the
  companion already uses for its own logs. `full_opt_in` sends the cleaned
  text as is. Both keep the features and the head prediction beside the
  text so the server can grade text against features on the same row.
- Loop structure per call, the columns §6.34 needed: `turnRootId`,
  `callIndex`, `toolNames`, `largestToolInputChars`, `stopReason`, and the
  timestamps the schema already has. Per turn root: `turnIndexInSession`.
  These are numbers and short enum strings; they ship under every mode.

**Sources, in order of exactness.** The companion daemon is the main new
source: it already holds every Claude Code and Codex turn in the personal
store with true usage, so uploading is a per-turn POST from the store
behind a setting, with the mode chosen once. sheep-manager keeps shipping.
The Chrome extension stays a weak source (estimated tokens) and is tagged.

**Consent.** One prompt on first launch of `tf-claude` / `tf-codex` and in
the menubar: off, aggregates only (`hash_only`), prompts with paths and
secrets removed (`redacted`), full prompts (`full_opt_in`). A privacy page
lists the exact fields per tier. ADR 0002 records it. Default stays off.

**Server.** Text rows land in a separate file from feature rows, mode 600,
same VM, with the study salt kept in the secret store as today. Retention
and a delete-my-data path by installation id before recruitment starts.

**Gates.** Schema round-trip tests per mode; a leak test that a `hash_only`
row serialised by the writer contains no text field; the redactor graded on
the local corpus with a path and secret detector, zero misses on the 2,245
turn-root prompts. Nothing ships to the VM until the leak test is green.

## Track 2: the corpus, real cycles first, volume second

Census before modelling: turns, sessions, users and calls per source, in one
artifact, before any model is fitted.

- **Tier A, real users, real cycles, native usage.** Rewrite
  `harvest_github_chats.py` to keep session structure and read native usage
  where it exists: Claude Code `.jsonl` (usage per call, parentUuid),
  Cline and Roo task folders (tokens out per request), aider histories
  (tokens received per turn), Codex session dumps where usage is not
  redacted. Output is per-call rows in the loader's schema plus a turn
  table, not prompt→reply pairs. Research input only, gitignored, as now.
- **Tier B, volume with per-step usage, one cycle per session.** The
  mini-swe-agent trajectories in the SWE-bench `experiments` S3 bucket,
  about 30,000 across 60 agent×model configurations on the same 500 tasks,
  with `completion_tokens` split into reasoning and text. Keys are built
  from each submission's `metadata.yaml`. Used for the loop-dynamics prior,
  the re-forecast-at-k question on true per-step tokens, and the ratio of
  hidden thinking to visible text by effort level.
- **Tier C, volume with cycles, no loop.** WildChat and LMSYS-Chat-1M
  multi-turn conversations, already streamable, for turn-index and
  previous-reply structure at scale. Reply length only.
- **Tier A′, the telemetry itself**, once Track 1 ships.

Folds on public data are leave-user-out (repository or installation) and
leave-source-out. Never "chronological": the public corpora have no
timestamps, and `firstMs` there is harvest order.

## Track 3: the base model

The base is fitted by the same trainer as today's profile (extracted to
`packages/trainer`, MULTI-USER-PLAN Phase 3), fed the Tier A, B and C rows
with a `source` column, and emitted with provenance `multi-source-public`.
It carries:

- the turn-total and per-call quantile ladders pooled across sources, with
  source as the first rung so a caller that knows it is Claude Code gets
  Claude Code's shape;
- the hashed text head, retrained on every prompt the corpus holds (the
  existing trainer, wider corpus);
- a loop-dynamics prior: calls-per-turn and the re-forecast-at-k
  correction from Tier B, calibrated to Tier A's scale;
- the thinking-to-visible ratio by model and effort, so text-only labels
  can be corrected to `output_tokens`.

**Gates, stated before the fit.**

1. *Stranger gate.* Leave-user-out on Tier A users with 20 or more
   sessions: the public base beats the current single-user bundled profile
   on pinball with the user-block 95% CI below zero, and P90 coverage per
   held-out user inside [85, 95]. This is the honest cold-start test; the
   single-user profile is expected to lose it.
2. *Owner gate.* On the local corpus, five chronological session folds, the
   public base alone may be worse than today's bundled profile; that is
   what "weaker" means. It is recorded, not gated.
3. *Kill.* A base that fails the stranger gate does not replace the bundled
   profile, whatever it does elsewhere.

## Track 4: post-training on the user's machine

The personal layer already post-trains the ladder. It gains:

- the hashed text head as a residual on the base head, shrunk toward the
  base by `n_sessions / (n_sessions + k)`, `k` fitted by replay on the
  local corpus (SEMANTIC-PLAN Stage 1b, unblocked because the base is no
  longer gated on one user);
- the per-user scale `s_u` from MULTI-USER-PLAN §2, shipped first because
  it is the only parameter estimable at 50 calls;
- later, the re-forecast correction as a personal rung, ratcheted, if the
  Tier B fit says it pays at real per-step tokens.

**Learning-curve gate.** Replay the local corpus chronologically through
the shipped code path, base frozen, personal layer updating per session.
At sessions 10, 50 and 200, base+personal must beat base alone on the
user's subsequent sessions, session-block CI below zero, and must beat
today's bundled profile by session 200. Any layer that fails at a rung
stays at the base for that rung, the same auto-refusal the personal trainer
has now.

## Track 5: the pooled semantic head, once text arrives

When the text file holds 15 or more users at 20 or more sessions, retrain
the hashed head and the encoder on real prompts, leave-user-out, and grade
against the features-only base. This is the experiment §6.32 could not run:
whether prompt semantics is worth 1% because that is what prompts carry, or
because one person's prompts are all alike. Ship as the next base if it
clears the stranger gate. Per-user heads never leave the machine.

## Sequence and owners

| week | work | owner | done when |
|---|---|---|---|
| 0 | Housekeeping: revert the silently regenerated profile, relocate the text-head asset, commit the research split | Opus | branch clean, tests green |
| 1 | Track 1 schema, writer and ingest enforcement, redactor, leak test, ADR 0002, companion upload behind a setting | Opus | leak test green, one redacted row round-tripped to the VM |
| 1 | Track 2 harvester rewrite and census; S3 key builder and a 1-submission smoke pull | Opus | census artifact with turns/sessions/users per source |
| 2 | Track 2 full harvest; Tier B thinking-ratio and calls-per-turn tables | Opus | tables reviewed |
| 2 | Consent UX in the launchers and menubar, privacy page | Opus | copy reviewed |
| 3 | `packages/trainer` extraction (byte-identical regeneration first), then the multi-source base with the stranger gate | Opus | gate artifact |
| 4 | Track 4 text-head residual and `s_u`, learning-curve replay | Opus | replay artifact |
| 5+ | Recruitment; Track 5 when the user count allows | user | |

Fable writes each week's spec with acceptance checks, reviews the tables,
and writes the verdicts. Opus implements. Nothing is adopted on a single
split.

## Risks, named

- **Prompt realism.** Tier B and C prompts are not what people type into a
  terminal. The local corpus and Tier A are the only realism tests; public
  rows never enter a holdout that claims realism.
- **Label mismatch.** Visible text is 1.45 characters per output token on
  the local corpus, so two thirds of the label is hidden thinking. Tier B
  measures the ratio; everything text-only is corrected, and the correction
  is graded, not assumed.
- **Recruitment bias.** People who opt in to prompt upload are power
  users. Segment composition is published with every refit.
- **Censoring.** The OpenHands sets cap at 100 steps; the mini-swe-agent
  runs have their own caps. Fit the loop-length prior as a survival curve.
- **Privacy.** Text telemetry is a new promise. The redactor, the leak test,
  the delete path and ADR 0002 ship before the first recruited user, not
  after.

# ADR 0002 — Prompt text in telemetry, in four tiers, off by default

Date: 2026-09-04
Status: accepted, implemented; nothing is collected until a user opts in

## Context

Every pre-call signal we could measure has now been measured on one person's
corpus, and each one closed at roughly the same place. Prompt text through a
hashed head is worth about 1% (STATE-OF-PLAY §6.32); a shrunk blend at λ=0.35
is the only form of it that clears the house gate. Repository state was refused.
Session-so-far was refused at +0.28%. Re-forecast-as-you-go is real but lands
under the −10/−15% margin. The fold spreads in every one of those tables are
the signature of one person's few dozen long turns deciding the number.

The corpus is the constraint, not the model. And the specific experiment that
would settle the prompt-text question — *is semantics worth 1% because that is
what prompts carry, or because one person's prompts are all alike?* — cannot be
run at all without prompts from more than one person, and cannot be run
retroactively, because nothing has ever stored them.

The telemetry schema has had a `promptStorageMode` enum (`none`, `hash_only`,
`redacted`, `full_opt_in`) since it was written. It has never had a text field,
and nothing has ever enforced the enum: a client could set `hash_only`, attach
a prompt, and every reader would accept the row. The enum described an
intention nobody had implemented.

The other half of the same gap is loop structure. The re-forecast probe
(§6.34) wanted to know where in an agent loop a call sits — which turn, which
call of that turn, what the previous call asked its tools for, why it stopped —
and the observation schema could not say. Those are numbers and short enum
strings, they carry no content, and they ship under every tier.

## Decision

### Four tiers, chosen by the user, default `none`

| tier | usage, model, loop structure | path/image flags | `promptForecastFeatures` | `promptText` |
| --- | --- | --- | --- | --- |
| `none` | — nothing is sent at all — | | | |
| `hash_only` | yes | yes | no | no |
| `redacted` | yes | yes | yes, from the text | yes, redacted |
| `full_opt_in` | yes | yes | yes, from the text | yes, verbatim |

"Loop structure" is `turnRootId`, `callIndex`, `turnIndexInSession`,
`toolNames`, `largestToolInputChars`, `stopReason`, and the timestamps the
schema already had. `turnRootId` and `metadata.sessionId` are salted per
install: they group a turn's calls together and identify nothing outside the
machine that made them.

`promptForecastFeatures` is derived from the prompt text at upload time on the
tiers that have it, rather than mapped from the store's own feature columns.
The two feature sets do not line up — mapping one onto the other would mean
inventing five of the seven fields — and computing both from the same string is
also what lets the collector grade "features only" against "features plus text"
on one row, which is the whole experiment.

Nothing is uploaded until the user names both a tier and a collector. Default
is `none` with an empty URL, and a fresh install stays that way.

### The mode is enforced in three places, not documented in one

- **The schema.** `forecastObservationSchema` carries a `superRefine` that
  rejects a row with `promptText` under `none` or `hash_only`, or with no mode
  at all. Because it is on the schema, the check runs in the writer, in the
  ingest handler and in any reader replaying a file.
- **The writer.** `JsonlTelemetryWriter`'s `mode` is the file's ceiling, not a
  label. A `none`/`hash_only` file strips text and the field name with it; a
  `redacted` file runs the redactor again over whatever it is handed, because
  "I already redacted it" is not a claim a file can check.
- **The ingest handler.** Text rows go to a separate `textWriter`; the feature
  row, minus the text, always goes to the feature writer. With no text writer
  configured, a row carrying text is accepted and the text is dropped — its
  features are still worth keeping, and refusing the row would lose them.

### The redactor is one pure function, graded on a real corpus

`redactPromptText` replaces filesystem paths, URLs and bare hostnames, e-mail
addresses, IPv4 addresses, uuids, long hex and base64 runs, and the token
shapes the major providers issue. It keeps prose, identifiers and code, because
a prompt with those removed carries nothing worth pooling.

It is a redactor, not an anonymiser. A prompt that names a person in a sentence
still names them. That is exactly why `redacted` is a tier somebody chooses and
not a promise that the result is safe to publish.

It is graded, not asserted: `scripts/grade-redactor.mjs` runs it over every
turn-root prompt on the local machine and then runs a second, independently
written detector over the output. On 1,885 turn-root prompts (2.5 M characters)
the detector finds **zero** residual paths, hosts, addresses, keys or opaque
runs. The grading run is what added the bare-hostname, IPv4 and uuid rules; a
redactor written from a list and never measured would have missed all three.

### Text lands in its own file, mode 600

`observations-text.jsonl` beside `observations.jsonl`, both 600, joinable on
`id`. Separate files so retention, permissions and backup can differ, and so
that "who can read the prompts" is an operating-system question with a
one-line answer.

### There is a delete path before there is a recruit

`DELETE /v1/installations/:installationId` appends a tombstone and answers 202.
The rows themselves go when `scripts/purge-installation.mjs` next runs with the
collector stopped: an append-only log cannot be rewritten safely underneath
live appends, and a delete endpoint that pretended otherwise would quietly lose
rows. The same script takes `--retain-days`, which is how retention is applied.

Rows identify their installation in `metadata.userIdHash`: a random opaque id
the client generates on first use, keeps locally, and can show its user. There
is no account, and that string is the whole of the identity.

### The store still has no column that can hold text

Prompt text, on the tiers that send it, is re-read from the transcript at
upload time, redacted, put in the request body, and dropped. The SQLite schema
gained four loop-structure columns and an upload cursor, and the test that pins
the observations table to an exact column list was updated deliberately, which
is what that test is for.

## What is NOT collected, at any tier

- **Tool results.** Nothing a tool returned: no file contents, no command
  output, no error text. `largestToolInputChars` is a length.
- **Tool inputs.** Only the *names* of the tools a call used, from a fixed
  vocabulary of about twenty words.
- **Assistant output.** No reply text, no thinking, no diffs. The response is
  present only as `output_tokens` and a stop reason.
- **File contents, file names or paths**, other than inside a prompt under
  `full_opt_in`, or as `<path>` under `redacted`.
- **Repository, branch, host or account identity.** Salted hashes group rows;
  they name nothing.
- **Anything at all under `none`**, which is the default.

## Consequences

- **The pooled-head experiment becomes possible, and only then.** Track 5 needs
  15 users at 20 or more sessions before the hashed head and the encoder are
  retrained leave-user-out. Until that threshold, this collects and does not
  model.
- **Recruitment bias is now a named risk.** People who opt into prompt upload
  are power users. Segment composition gets published with every refit.
- **A new promise to keep.** Text telemetry is a stronger claim than feature
  telemetry, and the machinery that backs it — redactor, leak test, delete
  path, retention, this ADR — ships before the first recruited user, not after.
- **Consent UX is still owed.** This week ships the setting and a CLI flag
  (`tf telemetry --mode redacted --url … --token …`). The launcher prompt, the
  menu-bar control and the privacy page are week 2.
- **Existing Codex rows keep null loop columns.** The Codex importer is
  incremental by file identity, so a rollout that has not changed is not
  re-read and its rows keep the nulls they were imported with. New sessions
  carry the columns. Backfilling would mean clearing the file cursors, which
  costs a full re-read for a column that only matters going forward.
- **Codex rows carry no `stopReason` at all.** The rollout format does not
  record one. Deriving `tool_use` from the presence of a tool call would be
  reporting our own inference as the provider's word, so the field is absent
  rather than guessed.

# Privacy-safe predictor telemetry

The local Claude Code corpus contains many calls, but only one identifiable
user. It cannot establish per-user calibration or learn the pre-call intent
behind rare long artifact responses. The telemetry schema and JSONL writer in
`@token-forecaster/telemetry` collect the smallest useful replacement dataset.

## What to record

Create the forecast immediately before generation, then append one observation
after usage arrives. Keep forecast-time and post-call fields separate:

- Before generation: model snapshot, requested `maxTokens`, configured thinking
  mode, the returned quantiles, `promptForecastFeatures(prompt)`, path status,
  exact agent-loop context, and caller-declared `expectedOutputKind`.
- After generation only: output tokens, censoring, observed output kind, first
  action, finish reason, latency, and cost.
- For block-resampled evaluation: session id plus stable salted hashes of the
  user and workload. Never replace an unavailable value with `false` or zero.

`expectedOutputKind` is an optional intent declaration, not truth and never a
label derived from the response. Set it before generation to `message`,
`artifact`, `tool_call`, `mixed`, or `unknown`. Also record
`expectedOutputKindSource`: `human_declared`, `orchestrator_declared`,
`prompt_heuristic`, `resolved_context_heuristic`, or `unknown`. A heuristic
prediction must not be presented as a caller declaration.

Collect every call, including `unknown`; never retain only rows where somebody
declared an artifact. `observedOutputKind` and `firstAction` belong only in
`actual` and may never be copied backward into request fields. Train Stage A
against the post-call observed outcome, using declared intent only as one
pre-call feature. Report results separately by intent source to expose a
heuristic that merely repeats prompt bias.

`resolvedFileContext` covers the case where a vague human prompt is resolved by
completed `Read`/`Glob`/`Grep` steps before a later call. It stores counts and a
boolean only—no paths. Omit the entire object when that context was not
observed; missing is not zero.

## The four storage tiers

`promptStorageMode` is no longer a label. Since ADR 0002 it is enforced by the
schema, by the JSONL writer and by the ingest handler, and it decides exactly
which fields a row may carry.

| field | `none` | `hash_only` | `redacted` | `full_opt_in` |
| --- | --- | --- | --- | --- |
| `actual` usage, `model`, `modelSnapshot` | — | yes | yes | yes |
| `metadata.sessionId`, `userIdHash` (salted) | — | yes | yes | yes |
| `turnRootId` (salted), `callIndex`, `turnIndexInSession` | — | yes | yes | yes |
| `toolNames`, `largestToolInputChars`, `stopReason` | — | yes | yes | yes |
| `promptMentionsPath`, `promptHasImage` | — | yes | yes | yes |
| `textHeadQuantiles` (three numbers, not invertible) | — | yes | yes | yes |
| `promptForecastFeatures` | — | — | yes | yes |
| `promptText` | — | — | redacted | verbatim |

`none` means no row is sent at all, not a row with empty fields. It is the
default, and a fresh install stays there until somebody names both a tier and a
collector.

The companion omits `promptForecastFeatures` under `hash_only` rather than
mapping the store's own feature columns onto it: the two feature sets do not
line up, and filling in the difference would mean inventing five of the seven
fields. A client that holds the draft — the extension, the host app — is not
subject to that and sends features under `hash_only` as it always has.

Three checks stand between a client and a text file it did not opt into:

1. `forecastObservationSchema` rejects a row carrying `promptText` under `none`
   or `hash_only`, or with no `promptStorageMode` at all. Because the check is
   on the schema, it runs in the writer, in the ingest handler, and in any
   reader replaying a file.
2. `JsonlTelemetryWriter`'s `mode` is the file's ceiling. A `none`/`hash_only`
   file strips the text and the field name with it; a `redacted` file re-runs
   the redactor over whatever it is handed, whatever the client claims.
3. `createTelemetryIngestHandler` writes text only to a separate `textWriter`;
   the feature row, minus the text, always goes to the feature writer. With no
   text writer configured, a row with text is accepted at 202 and the text is
   dropped.

`packages/telemetry/src/leak.test.ts` asserts all three on file bytes rather
than on parsed objects, because a serialiser that writes a field the schema
dropped would pass an object comparison.

### The redactor

`redactPromptText(text)` is a pure function returning the redacted text and a
count per class. It replaces filesystem paths (`<path>`), URLs, bare hostnames
and IPv4 addresses (`<url>`), e-mail addresses (`<email>`), uuids and long hex
runs (`<hex>`), long opaque runs (`<b64>`), and provider token shapes, bearer
values and `key=value` secrets (`<secret>`). It keeps prose, identifiers and
code. It is idempotent, so running it on the client and again on the server
costs nothing.

Grade it before trusting it:

```sh
pnpm --filter @token-forecaster/telemetry build
node packages/telemetry/scripts/grade-redactor.mjs
```

It reads every turn-root prompt on the machine, redacts, then runs a second and
independently written detector over the output. It prints counts only — for a
residual hit it prints the class and the matched length, never the text. The
target is zero hits; on this machine's 1,885 turn-root prompts (2.5 M
characters) it is zero.

### Deleting an installation's rows, and retention

Rows say which installation sent them in `metadata.userIdHash`: a random opaque
id the client generates on first use and keeps locally. No account exists, so
that string is the whole identity.

- `DELETE /v1/installations/:installationId`, bearer-authed, appends a tombstone
  to `deletions.jsonl` beside the data files and answers 202.
- `packages/telemetry/scripts/purge-installation.mjs` does the physical
  removal. Run it with the collector stopped: an append-only JSONL cannot be
  rewritten safely underneath live appends.

```sh
# dry run: prints what would go
node packages/telemetry/scripts/purge-installation.mjs \
  --file /var/lib/token-forecaster/observations.jsonl \
  --file /var/lib/token-forecaster/observations-text.jsonl

# apply every pending tombstone, and the retention window with it
systemctl stop token-forecaster-ingest
node packages/telemetry/scripts/purge-installation.mjs \
  --file /var/lib/token-forecaster/observations.jsonl \
  --file /var/lib/token-forecaster/observations-text.jsonl \
  --retain-days 400 --apply
systemctl start token-forecaster-ingest
```

The intended cron is that command, nightly, at a quiet hour. It is written down
here and deliberately not deployed by this repository: the retention number is
the operator's decision and belongs beside their own backup policy.

## The old advice, still true for anything that has not opted in

Raw prompts are unnecessary for most of this. Default to `hash_only`: store
privacy-safe prompt features and, if deduplication is needed, a salted prompt
hash. Rotate the salt separately from the data and do not upload it. User and
workload hashes need a stable study salt so the evaluator can resample
correlated blocks; keep that salt in the VM secret store.

Semantic forecasting is what changed this. The measured way to use prompt text
(STATE-OF-PLAY §6.32) is a text head computed on the client and blended
locally, and the only thing worth uploading *from one machine* is that head's
prediction. The reason text collection now exists at all is that the 1% figure
cannot be interpreted without other people's prompts: see ADR 0002 and
`docs/PLAN-OF-ATTACK.md`.

`request.textHeadQuantiles` is an optional three-number tuple, `[p50, p90, p99]` on the `log1p(tokens)` scale, holding
exactly what `baseTextHead(prompt)` returned for the turn root; it sits beside
`promptForecastFeatures` and is written by any client that already sends those
features and still holds the draft. Send it only when the head actually ran --
omit the field otherwise, because "no head" and "a head that predicted a short
turn" are different rows. It carries no text and cannot be inverted into any,
so `hash_only` is unchanged by it and remains the default.

## Minimal integration

```ts
import { promptForecastFeatures } from "@token-forecaster/predictor";
import {
  JsonlTelemetryWriter,
  hashTelemetryIdentifier,
} from "@token-forecaster/telemetry";

const writer = new JsonlTelemetryWriter({
  filePath: "/var/lib/token-forecaster/observations.jsonl",
});

// Capture all request/forecast fields before starting the provider stream.
const preCall = {
  promptForecastFeatures: promptForecastFeatures(turnRootPrompt),
  expectedOutputKind: callerIntent ?? "unknown",
  expectedOutputKindSource: callerIntent ? "orchestrator_declared" : "unknown",
  userIdHash: hashTelemetryIdentifier(userId, studySalt),
  workloadIdHash: hashTelemetryIdentifier(workloadId, studySalt),
};

// Append a ForecastObservation after usage is reconciled.
await writer.append(observation);
```

The writer validates every row, creates an append-only mode-0600 JSONL file,
and serializes concurrent appends. `readTelemetryJsonl` validates rows again;
`summarizeForecastAccuracy` gives a first pinball, coverage, and width check.

For remote clients, the repository also includes a small authenticated ingest
server. Build the packages, set an absolute file path and a long random bearer
token, then run it behind a TLS reverse proxy:

```sh
export TOKEN_FORECASTER_TELEMETRY_FILE=/var/lib/token-forecaster/observations.jsonl
export TOKEN_FORECASTER_INGEST_TOKEN='replace-with-a-secret-manager-value'
export TOKEN_FORECASTER_HOST=127.0.0.1
export TOKEN_FORECASTER_PORT=8787
pnpm telemetry:serve
```

Clients POST either a single `ForecastObservation` or an array of up to 200 of
them as JSON to `/v1/observations` with `Authorization: Bearer …`; `/healthz` is
the only unauthenticated route. The server caps a single row at 256 KiB and a
batch at 2 MiB, returns generic validation errors, never logs bodies, and
strips schema-unknown fields before writing. Bind to loopback and let Caddy,
nginx, or your cloud load balancer handle TLS and rate limiting.

`TF_TEXT_MODE` sets the prompt-text file's ceiling; it defaults to `redacted`
and writes `observations-text.jsonl` beside the feature file at mode 600. Set
it to `none` to run without a text file at all, in which case rows carrying
text are still accepted and their text dropped.

## Uploading from the companion daemon

The companion is the main new source: it already holds every Claude Code and
Codex turn with true provider usage. Uploading is off until it is turned on:

```sh
node apps/companion/dist/cli.js telemetry \
  --mode redacted \
  --url https://telemetry.example.com \
  --token 'keychain:token-forecaster-ingest'   # or a plain string
node apps/companion/dist/cli.js telemetry      # report only
```

`--token keychain:<service>[/<account>]` reads from the macOS keychain, so the
token is not sitting in a SQLite file that gets copied around with the derived
data. The daemon uploads after each index run, in batches of 200, never
blocking the status line; a failed batch does not move the cursor and goes
again next run. `https` is required except on loopback.

Two things on those rows are worth knowing before grading them:

- The `forecast` block is **the installation's own pre-call forecast function
  evaluated at upload time**, not a forecast the user saw, and it is in-sample
  for the personal profile. Grade models on `actual`; treat `forecast` as
  provenance.
- `actual.inputTokens` is optional. Claude Code transcripts record the billed
  output of every call and no per-call input count; a zero there would be an
  invented measurement.

Loop-structure columns are filled in by the importers going forward. Rows
imported before that migration keep null, and the Codex importer is incremental
by file identity, so an unchanged rollout is not re-read and keeps its nulls.
Null there means "imported before the importer looked", never "no tools" — an
empty tool list is what that looks like.

## Chrome extension collector

The public extension must not contain the shared bearer token above. Its
collector mode instead exposes anonymous per-install registration, idempotent
batched events, and deletion:

```sh
export TOKEN_FORECASTER_TELEMETRY_FILE=/var/lib/token-forecaster/extension-events.jsonl
export TOKEN_FORECASTER_INSTALL_REGISTRY_FILE=/var/lib/token-forecaster/installations.jsonl
export TOKEN_FORECASTER_INSTALL_TOKEN_SECRET='at-least-32-random-characters-from-a-secret-manager'
export TOKEN_FORECASTER_HOST=127.0.0.1
export TOKEN_FORECASTER_PORT=8787
pnpm telemetry:serve
```

Build the extension against the public TLS origin, never the loopback binding:

```sh
TF_TELEMETRY_ORIGIN=https://telemetry.example.com pnpm build:extension
```

The built manifest declares that one origin under
`optional_host_permissions`. No request is made and the permission is not
requested until the user explicitly grants diagnostics or research consent.

- `POST /v1/installations` returns random access and deletion credentials. The
  registry persists only keyed token hashes and a random installation hash;
  there is no account identifier or shared credential in the extension.
- `POST /v1/events` accepts at most 25 schema-validated events per batch. Event
  ids are idempotent across retries and restarts. Operational diagnostics are
  enumerated rather than an arbitrary properties bag.
- `DELETE /v1/installations/current` revokes the installation and physically
  compacts its rows out of the event JSONL.
- Browser research outcomes carry
  `actual.outputTokenQuality: "dom_estimate"`, a surface, and a call/turn scale.
  Exclude them from provider-exact fits by default. Use them for a separately
  named visible-surface model only after its own user-blocked gate passes.

The handler includes modest in-memory registration and per-install event limits
as a last line of defence. Enforce durable quotas, request-size limits, and
abuse controls at the TLS edge as well. Do not log request bodies or
authorization headers. The packaged `privacy.html` is not a substitute for the
operator-specific public privacy page required by the store listing.

Generate the privacy-safe readiness/accuracy report without emitting user
hashes:

```sh
pnpm telemetry:report:extension /var/lib/token-forecaster/extension-events.jsonl
```

The report keeps call and whole-turn scales separate, counts independent
installations and sessions, requires 15 installations with at least 20 sessions
before recommending a user-blocked evaluation, and marks segments publishable
only at eight or more users. Passing that data-volume gate does not promote a
model; it opens the frozen leave-one-user-out evaluation described in
`docs/MULTI-USER-PLAN.md`.

## Small VM deployment

A single modest VM is enough for collection; model training stays offline.

1. Mount an encrypted volume at `/var/lib/token-forecaster`. Run the collector
   as a dedicated unprivileged user and permit only append access to its JSONL
   directory.
2. Put the study salt and provider credentials in the VM secret manager, never
   in the JSONL or application logs. Terminate TLS at an authenticated ingest
   endpoint if clients submit remotely.
3. Rotate the JSONL daily. Upload compressed, encrypted files to private object
   storage, verify checksums, then retain the VM copy according to a written
   deletion policy. Do not log request bodies at the proxy.
4. Monitor schema-rejection counts, missing pre-call fields, censoring, rows per
   user/session, and delayed completion events. The extension ingest is
   idempotent on event id; direct API observations should still be deduplicated
   during evaluation.
5. Evaluate chronologically. Bootstrap whole sessions and then whole users;
   publish coverage for every sufficiently populated user and major segment.

Do not judge readiness by raw call count. The present holdout has thousands of
calls but only 49 correlated session blocks and one user. A useful multi-user
study should recruit multiple independent users/workloads and continue until
each reported segment has enough independent sessions for a stable block
bootstrap interval.

## The decision this data must answer

The local study shows that a correct future `Write` label has a large oracle
ceiling, while prompt-only, resolved-path, and prior-context semantic detectors
all have weak ranking power. A simulation indicates that a genuinely new caller
intent signal needs roughly 90% recall at no more than 1% false-positive rate
to clear a 5% loss-reduction gate; false positives make ordinary responses much
too wide. This is a prospective hypothesis, not a promised improvement.

Before adopting it, freeze a detector, score every call in shadow mode, and run
chronological user/session-block evaluation. Adoption still requires the whole
95% CI below zero; “breakthrough” still requires at least 5% loss reduction or
materially narrower intervals without coverage damage.

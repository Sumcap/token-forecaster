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

Raw prompts are unnecessary. Default to `hash_only`: store privacy-safe prompt
features and, if deduplication is needed, a salted prompt hash. Rotate the salt
separately from the data and do not upload it. User and workload hashes need a
stable study salt so the evaluator can resample correlated blocks; keep that
salt in the VM secret store.

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

Clients POST a single `ForecastObservation` as JSON to `/v1/observations` with
`Authorization: Bearer …`; `/healthz` is the only unauthenticated route. The
server caps rows at 256 KiB, returns generic validation errors, never logs
bodies, and strips schema-unknown fields before writing. Bind to loopback and
let Caddy, nginx, or your cloud load balancer handle TLS and rate limiting.

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
   user/session, and delayed or duplicate completion events. Deduplicate on
   observation id during evaluation rather than mutating the append log.
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

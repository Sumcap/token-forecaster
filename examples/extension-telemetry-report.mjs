#!/usr/bin/env node
import {
  readExtensionTelemetryJsonl,
  summarizeForecastAccuracy,
} from "../packages/telemetry/dist/index.js";

const filePath = process.argv[2] ?? process.env.TOKEN_FORECASTER_TELEMETRY_FILE;
if (!filePath) {
  throw new Error(
    "Pass the extension event JSONL path or set TOKEN_FORECASTER_TELEMETRY_FILE",
  );
}

const diagnostics = new Map();
const observations = [];
const seenEvents = new Set();
const userSessions = new Map();
const segmentUsers = new Map();
let duplicates = 0;
let rejectedResearchRows = 0;

for await (const row of readExtensionTelemetryJsonl(filePath)) {
  const event = row.event;
  if (seenEvents.has(event.id)) {
    duplicates++;
    continue;
  }
  seenEvents.add(event.id);
  if (event.kind === "diagnostic") {
    const key = `${event.name}/${event.outcome}/${event.code ?? "none"}`;
    diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1);
    continue;
  }
  const observation = event.observation;
  if (
    observation.actual?.outputTokenQuality !== "dom_estimate" ||
    observation.metadata?.surface === undefined ||
    observation.metadata.forecastScale === undefined
  ) {
    rejectedResearchRows++;
    continue;
  }
  observations.push(observation);
  const sessionId = observation.metadata.sessionId;
  if (sessionId !== undefined) {
    const sessions = userSessions.get(row.installationIdHash) ?? new Set();
    sessions.add(sessionId);
    userSessions.set(row.installationIdHash, sessions);
  }
  const segment = [
    observation.metadata.surface,
    observation.metadata.forecastScale,
    observation.model,
    observation.request.thinkingConfiguration === undefined
      ? "thinking_unknown"
      : JSON.stringify(observation.request.thinkingConfiguration),
  ].join("/");
  const users = segmentUsers.get(segment) ?? new Set();
  users.add(row.installationIdHash);
  segmentUsers.set(segment, users);
}

const accuracyByScale = {};
for (const scale of ["call", "turn"]) {
  const rows = observations.filter((row) => row.metadata?.forecastScale === scale);
  accuracyByScale[scale] =
    rows.length === 0 ? null : summarizeForecastAccuracy(rows);
}

const usersWith20Sessions = [...userSessions.values()].filter(
  (sessions) => sessions.size >= 20,
).length;
const populatedSegments = Object.fromEntries(
  [...segmentUsers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, users]) => [segment, { users: users.size, publishable: users.size >= 8 }]),
);
const readyForUserBlockedEvaluation =
  userSessions.size >= 15 && usersWith20Sessions >= 15 && observations.length > 0;

const report = {
  source: "chrome-extension-visible-dom-estimates",
  generatedAt: new Date().toISOString(),
  events: seenEvents.size,
  duplicateEventIds: duplicates,
  diagnostics: Object.fromEntries([...diagnostics.entries()].sort()),
  research: {
    acceptedRows: observations.length,
    rejectedRows: rejectedResearchRows,
    installations: userSessions.size,
    installationsWith20Sessions: usersWith20Sessions,
    populatedSegments,
    accuracyByScale,
  },
  gate: {
    readyForUserBlockedEvaluation,
    minimum: "15 installations with at least 20 sessions; 8 users per published segment",
    next:
      readyForUserBlockedEvaluation
        ? "Run a frozen leave-one-user-out candidate for a separately named visible-surface model."
        : "Collect more independent consented users; do not train or promote a population profile yet.",
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

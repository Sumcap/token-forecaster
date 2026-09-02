import {
  EXTENSION_TELEMETRY_SCHEMA_VERSION,
  extensionDiagnosticEventSchema,
  extensionResearchEventSchema,
  type ExtensionDiagnosticEvent,
  type ExtensionResearchEvent,
} from "@token-forecaster/core";
import type { Surface } from "./surface.js";
import { TELEMETRY_CONSENT_VERSION } from "./settings.js";
import type { TurnRecord } from "./turn.js";

export type DiagnosticName = ExtensionDiagnosticEvent["name"];
export type DiagnosticCode = NonNullable<ExtensionDiagnosticEvent["code"]>;

function id(): string {
  return crypto.randomUUID();
}

function telemetrySurface(surface: Surface): "claude_code" | "claude_chat" {
  return surface === "code" ? "claude_code" : "claude_chat";
}

export function diagnosticEvent(input: {
  extensionVersion: string;
  name: DiagnosticName;
  outcome: ExtensionDiagnosticEvent["outcome"];
  surface?: Surface;
  code?: DiagnosticCode;
  durationBucketMs?: ExtensionDiagnosticEvent["durationBucketMs"];
}): ExtensionDiagnosticEvent {
  return extensionDiagnosticEventSchema.parse({
    schemaVersion: EXTENSION_TELEMETRY_SCHEMA_VERSION,
    id: id(),
    timestamp: new Date().toISOString(),
    extensionVersion: input.extensionVersion,
    consentVersion: TELEMETRY_CONSENT_VERSION,
    kind: "diagnostic",
    name: input.name,
    outcome: input.outcome,
    ...(input.surface === undefined ? {} : { surface: telemetrySurface(input.surface) }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.durationBucketMs === undefined
      ? {}
      : { durationBucketMs: input.durationBucketMs }),
  });
}

/**
 * Turn outcome to a text-free research row. Returns null for legacy/synthetic
 * snapshots that do not carry the pre-call telemetry fields.
 */
export function researchEventFromTurn(input: {
  extensionVersion: string;
  sessionId: string;
  record: TurnRecord;
}): ExtensionResearchEvent | null {
  const { record } = input;
  const snapshot = record.snapshot;
  if (
    snapshot.inputTokens === undefined ||
    snapshot.inputQuality === undefined ||
    snapshot.promptFeatures === undefined ||
    snapshot.promptMentionsPath === undefined ||
    snapshot.promptHasImage === undefined ||
    snapshot.sessionPosition === undefined ||
    snapshot.predictorVersion === undefined ||
    snapshot.forecastSource === undefined ||
    snapshot.confidence === undefined ||
    record.settledAt === null ||
    record.abandoned
  ) {
    return null;
  }
  const quantiles = record.scale.quantiles;
  const observationId = id();
  const event: ExtensionResearchEvent = {
    schemaVersion: EXTENSION_TELEMETRY_SCHEMA_VERSION,
    id: id(),
    timestamp: new Date(record.startedAt).toISOString(),
    extensionVersion: input.extensionVersion,
    consentVersion: TELEMETRY_CONSENT_VERSION,
    kind: "research",
    observation: {
      id: observationId,
      timestamp: new Date(record.startedAt).toISOString(),
      provider: "anthropic",
      model: snapshot.modelId,
      request: {
        ...(snapshot.inputQuality === "anthropic_verified"
          ? { inputTokensVerified: snapshot.inputTokens }
          : { inputTokensLocal: snapshot.inputTokens }),
        currentUserTokens: snapshot.inputTokens,
        messageCount: snapshot.sessionPosition + 1,
        thinkingConfiguration: {
          enabled: snapshot.thinkingEnabled,
          source: "extension_resolved",
        },
        promptMentionsPath: snapshot.promptMentionsPath,
        promptHasImage: snapshot.promptHasImage,
        promptForecastFeatures: snapshot.promptFeatures,
        agentLoopForecastContext: {
          sessionPosition: snapshot.sessionPosition,
          loopDepth: 0,
          priorCallCount: 0,
        },
      },
      forecast: {
        outputP50: quantiles.p50,
        outputP90: quantiles.p90,
        ...(quantiles.p99 === undefined ? {} : { outputP99: quantiles.p99 }),
        predictorVersion: snapshot.predictorVersion,
        forecastSource: snapshot.forecastSource,
        confidence: snapshot.confidence,
      },
      actual: {
        inputTokens: snapshot.inputTokens,
        outputTokens: record.outTokens,
        inputTokenQuality: snapshot.inputQuality,
        outputTokenQuality: "dom_estimate",
        totalLatencyMs: Math.max(0, record.settledAt - record.startedAt),
      },
      metadata: {
        sessionId: input.sessionId,
        surface: telemetrySurface(snapshot.surface),
        extensionVersion: input.extensionVersion,
        consentVersion: TELEMETRY_CONSENT_VERSION,
        forecastScale: record.scale.kind,
      },
    },
  };
  return extensionResearchEventSchema.parse(event);
}

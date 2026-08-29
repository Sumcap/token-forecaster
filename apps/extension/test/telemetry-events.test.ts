import { describe, expect, it, vi } from "vitest";
import { diagnosticEvent, researchEventFromTurn } from "../src/lib/telemetry-events.js";
import type { TurnRecord } from "../src/lib/turn.js";

describe("extension telemetry events", () => {
  it("keeps diagnostics enumerated and content-free", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const event = diagnosticEvent({
      extensionVersion: "0.1.0",
      name: "extension_ready",
      outcome: "success",
      surface: "code",
      code: "ok",
    });
    expect(event).toMatchObject({
      kind: "diagnostic",
      surface: "claude_code",
      consentVersion: 1,
    });
    expect(event).not.toHaveProperty("properties");
    vi.useRealTimers();
  });

  it("turns a frozen forecast into a DOM-estimated, text-free research row", () => {
    const record: TurnRecord = {
      id: 1,
      snapshot: {
        call: { p50: 100, p90: 500, p99: 1_000 },
        turn: { p50: 300, p90: 900, p99: 2_000 },
        callTuned: true,
        turnTuned: true,
        modelId: "claude-opus-5",
        modelName: "Claude Opus 5",
        maxOutputTokens: 16_000,
        thinkingEnabled: true,
        pooled: false,
        sampleSize: 500,
        profileScope: "test",
        surface: "code",
        inputTokens: 25,
        inputQuality: "character_heuristic",
        promptFeatures: {
          characterCount: 100,
          requirements: 2,
          hasLimit: false,
          hasExpansive: true,
          artifactIntent: true,
          requestedFormat: "code",
          deliverableType: "artifact",
          followupCompression: false,
        },
        promptMentionsPath: true,
        promptHasImage: false,
        sessionPosition: 2,
        predictorVersion: "test/profile",
        forecastSource: "trained",
        confidence: "low",
      },
      scale: { kind: "turn", quantiles: { p50: 300, p90: 900, p99: 2_000 } },
      outTokens: 480,
      band: "p50-p90",
      abandoned: false,
      startedAt: Date.parse("2026-08-27T12:00:00.000Z"),
      settledAt: Date.parse("2026-08-27T12:00:03.000Z"),
    };
    const event = researchEventFromTurn({
      extensionVersion: "0.1.0",
      sessionId: "random-session-id",
      record,
    });
    expect(event?.observation.actual).toMatchObject({
      outputTokens: 480,
      outputTokenQuality: "dom_estimate",
      inputTokenQuality: "character_heuristic",
    });
    expect(event?.observation.metadata).toMatchObject({
      surface: "claude_code",
      forecastScale: "turn",
    });
    expect(event?.observation.request).not.toHaveProperty("maxTokens");
    expect(JSON.stringify(event)).not.toContain("prompt text");
  });

  it("does not invent a row from an old snapshot without pre-call fields", () => {
    const record = {
      id: 1,
      snapshot: {
        call: { p50: 1, p90: 2 },
        turn: null,
        callTuned: false,
        turnTuned: false,
        modelId: "claude-opus-5",
        modelName: "Claude Opus 5",
        maxOutputTokens: 1_000,
        thinkingEnabled: true,
        pooled: false,
        sampleSize: 1,
        profileScope: "legacy",
        surface: "chat" as const,
      },
      scale: { kind: "call" as const, quantiles: { p50: 1, p90: 2 } },
      outTokens: 1,
      band: "under-p50" as const,
      abandoned: false,
      startedAt: 1,
      settledAt: 2,
    } satisfies TurnRecord;
    expect(
      researchEventFromTurn({ extensionVersion: "0.1.0", sessionId: "session", record }),
    ).toBeNull();
  });
});

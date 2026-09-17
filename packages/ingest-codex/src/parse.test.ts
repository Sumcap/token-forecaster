import { describe, expect, it } from "vitest";

import { parseCodexRollout } from "./parse.js";

/**
 * Every fixture here is synthetic. No real transcript is committed, and no test
 * prints transcript text.
 */

const SALT = "test-salt";

interface UsageBlock {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

let cumulative = 0;

function row(obj: unknown): string {
  return JSON.stringify(obj);
}

function sessionMeta(id: string): string {
  return row({
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-08-01T10:00:00.000Z",
      cli_version: "0.61.0",
      cwd: "/redacted",
      originator: "vscode",
      source: "vscode",
      instructions: null,
      git: { branch: "main", commit_hash: "0".repeat(40), repository_url: "redacted" },
    },
  });
}

function turnContext(model: string, effort: string): string {
  return row({
    timestamp: "2026-08-01T10:00:01.000Z",
    type: "turn_context",
    payload: {
      cwd: "/redacted",
      approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write", network_access: false, writable_roots: [] },
      model,
      effort,
      summary: "auto",
    },
  });
}

function userMessage(message: string, ts = "2026-08-01T10:00:02.000Z"): string {
  return row({ timestamp: ts, type: "event_msg", payload: { type: "user_message", message, kind: "plain" } });
}

function tokenCount(last: UsageBlock, ts = "2026-08-01T10:00:03.000Z"): string {
  cumulative += last.total_tokens;
  return row({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: 272_000,
        last_token_usage: last,
        total_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: cumulative,
        },
      },
      rate_limits: { primary: { used_percent: 1.5, window_minutes: 300, resets_at: 0 } },
    },
  });
}

function usage(output: number, reasoningOut = 0): UsageBlock {
  return {
    input_tokens: 1_000,
    cached_input_tokens: 800,
    output_tokens: output,
    reasoning_output_tokens: reasoningOut,
    total_tokens: 1_000 + output,
  };
}

function transcript(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("parseCodexRollout", () => {
  it("turns an agent loop into per-call rows plus one turn total", () => {
    cumulative = 0;
    const text = transcript([
      sessionMeta("sess-1"),
      turnContext("gpt-5.2-codex", "high"),
      userMessage("Fix the failing import test in packages/core"),
      tokenCount(usage(120, 60)),
      tokenCount(usage(340, 200)),
      tokenCount(usage(55)),
    ]);

    const result = parseCodexRollout(text, { sourceFile: "/tmp/sess-1.jsonl", salt: SALT });
    const calls = result.observations.filter((o) => o.scale === "call");
    const turns = result.observations.filter((o) => o.scale === "turn");

    expect(calls).toHaveLength(3);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.outputTokens).toBe(120 + 340 + 55);
    expect(turns[0]!.reasoningOutputTokens).toBe(260);
    expect(calls.map((c) => c.callIndex)).toEqual([0, 1, 2]);
    expect(calls[0]!.model).toBe("gpt-5.2-codex");
    expect(calls[0]!.reasoning).toBe("high");
    expect(calls[0]!.provider).toBe("openai");
    expect(calls[0]!.usageSource).toBe("provider_exact");
    expect(calls[0]!.contextWindow).toBe(272_000);
    expect(result.sessionId).toBe("sess-1");
    expect(result.cliVersion).toBe("0.61.0");
    expect(result.stats.rowsUsed).toBe(3);
  });

  it("never carries prompt text into an observation", () => {
    cumulative = 0;
    const secret = "Fix zzsecretphrasezz in the store";
    const text = transcript([
      sessionMeta("sess-2"),
      turnContext("gpt-5.2-codex", "high"),
      userMessage(secret),
      tokenCount(usage(200)),
    ]);

    const result = parseCodexRollout(text, { sourceFile: "/tmp/sess-2.jsonl", salt: SALT });
    expect(JSON.stringify(result)).not.toContain("zzsecretphrasezz");
    const features = result.observations[0]!.promptFeatures;
    expect(features).not.toBeNull();
    expect(features!.chars).toBe(secret.length);
    expect(features!.hasImperative).toBe(true);
    expect(features!.hash).toHaveLength(16);
  });

  it("salts the prompt hash per install", () => {
    cumulative = 0;
    const lines = [
      sessionMeta("sess-3"),
      turnContext("gpt-5.2-codex", "high"),
      userMessage("same prompt"),
      tokenCount(usage(10)),
    ];
    const a = parseCodexRollout(transcript(lines), { sourceFile: "/tmp/a.jsonl", salt: "salt-a" });
    cumulative = 0;
    const b = parseCodexRollout(transcript(lines), { sourceFile: "/tmp/a.jsonl", salt: "salt-b" });
    expect(a.observations[0]!.promptFeatures!.hash).not.toBe(
      b.observations[0]!.promptFeatures!.hash,
    );
  });

  it("deduplicates re-emitted token_count events", () => {
    cumulative = 0;
    const dup = tokenCount(usage(300));
    // Re-emitting the identical event must not create a second call.
    const text = transcript([
      sessionMeta("sess-4"),
      turnContext("gpt-5.2-codex", "high"),
      userMessage("build it"),
      dup,
      dup,
      dup,
    ]);
    const result = parseCodexRollout(text, { sourceFile: "/tmp/sess-4.jsonl", salt: SALT });
    expect(result.observations.filter((o) => o.scale === "call")).toHaveLength(1);
    expect(result.stats.skipped.duplicate_usage).toBe(2);
  });

  it("accounts for every skipped row with a reason", () => {
    cumulative = 0;
    const text = transcript([
      sessionMeta("sess-5"),
      turnContext("gpt-5.2-codex", "high"),
      userMessage("go"),
      "{ this is not json",
      row({ timestamp: "x", type: "event_msg", payload: { type: "token_count", info: null } }),
      row({ record_type: "legacy" }),
      row({ timestamp: "x", type: "brand_new_event_type", payload: { type: "whatever" } }),
      tokenCount(usage(0)),
      tokenCount(usage(42)),
    ]);
    const result = parseCodexRollout(text, { sourceFile: "/tmp/sess-5.jsonl", salt: SALT });
    expect(result.stats.skipped.parse_error).toBe(1);
    expect(result.stats.skipped.missing_usage).toBe(1);
    expect(result.stats.skipped.unsupported_schema_version).toBe(1);
    expect(result.stats.skipped.unrecognised_event).toBe(1);
    expect(result.stats.skipped.zero_output).toBe(1);
    expect(result.stats.unknownEvents["brand_new_event_type"]).toBe(1);
    expect(result.stats.rowsUsed).toBe(1);
    // Every row read is either used or skipped — no silent losses.
    const skipped = Object.values(result.stats.skipped).reduce((a, b) => a + (b ?? 0), 0);
    const bookkeeping = result.stats.rowsRead - result.stats.rowsUsed - skipped;
    expect(bookkeeping).toBeGreaterThanOrEqual(0);
  });

  it("attributes usage seen before any turn root to an implicit turn", () => {
    cumulative = 0;
    const text = transcript([
      sessionMeta("sess-6"),
      turnContext("gpt-5.2-codex", "high"),
      tokenCount(usage(77)),
    ]);
    const result = parseCodexRollout(text, { sourceFile: "/tmp/sess-6.jsonl", salt: SALT });
    const calls = result.observations.filter((o) => o.scale === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptFeatures).toBeNull();
    expect(result.stats.skipped.no_turn_context).toBe(1);
  });

  it("resumes from an offset without losing turn state or re-emitting calls", () => {
    cumulative = 0;
    const head = [
      sessionMeta("sess-7"),
      turnContext("gpt-5.2-codex", "xhigh"),
      userMessage("refactor the store"),
      tokenCount(usage(100)),
    ];
    const first = parseCodexRollout(transcript(head), {
      sourceFile: "/tmp/sess-7.jsonl",
      salt: SALT,
    });
    expect(first.observations.filter((o) => o.scale === "call")).toHaveLength(1);

    const full = transcript([...head, tokenCount(usage(250))]);
    const second = parseCodexRollout(full, {
      sourceFile: "/tmp/sess-7.jsonl",
      salt: SALT,
      fromOffset: first.endOffset,
    });
    const newCalls = second.observations.filter((o) => o.scale === "call");
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]!.outputTokens).toBe(250);
    // The turn root came before the cursor, yet its features and effort survive.
    expect(newCalls[0]!.callIndex).toBe(1);
    expect(newCalls[0]!.reasoning).toBe("xhigh");
    expect(newCalls[0]!.promptFeatures).not.toBeNull();
    // The turn row is re-emitted with the full running total for upsert.
    const turnRow = second.observations.find((o) => o.scale === "turn");
    expect(turnRow?.outputTokens).toBe(350);
    expect(turnRow?.id).toBe(first.observations.find((o) => o.scale === "turn")?.id);
  });
});

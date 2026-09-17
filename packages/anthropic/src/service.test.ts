import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicTokenService } from "./service.js";

describe("createAnthropicTokenService", () => {
  it("forwards output-shaping request fields and captures thinking usage", async () => {
    let streamedParams: Record<string, unknown> | undefined;
    const stream = {
      on: vi.fn().mockReturnThis(),
      finalMessage: vi.fn().mockResolvedValue({
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 100,
          output_tokens: 900,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens_details: { thinking_tokens: 700 },
        },
      }),
    };
    const client = {
      messages: {
        stream: vi.fn((params: Record<string, unknown>) => {
          streamedParams = params;
          return stream;
        }),
      },
    } as unknown as Anthropic;

    const service = createAnthropicTokenService(client);
    const result = await service.streamMessage(
      {
        model: "claude-opus-5",
        maxTokens: 8_000,
        messages: [{ role: "user", content: "Solve this" }],
        thinking: { type: "adaptive" },
        outputConfig: { effort: "high" },
        stopSequences: ["DONE"],
        topP: 0.9,
      },
      {},
    );

    expect(streamedParams).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 8_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      stop_sequences: ["DONE"],
      top_p: 0.9,
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 900,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      thinkingTokens: 700,
    });
  });

  it("passes thinking and output format to provider token counting", async () => {
    let countParams: Record<string, unknown> | undefined;
    const client = {
      messages: {
        countTokens: vi.fn((params: Record<string, unknown>) => {
          countParams = params;
          return Promise.resolve({ input_tokens: 42 });
        }),
      },
    } as unknown as Anthropic;

    const service = createAnthropicTokenService(client);
    const result = await service.countInputTokens({
      model: "claude-opus-5",
      maxTokens: 8_000,
      messages: [{ role: "user", content: "Return JSON" }],
      thinking: { type: "adaptive" },
      outputConfig: {
        format: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
    });

    expect(countParams).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
    });
    expect(result.tokens).toBe(42);
  });
});


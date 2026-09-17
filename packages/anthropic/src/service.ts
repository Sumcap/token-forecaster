import Anthropic from "@anthropic-ai/sdk";
import { requireModel } from "@token-forecaster/model-registry";
import type {
  AnthropicFinalResult,
  AnthropicInputCount,
  AnthropicModelMetadata,
  AnthropicRequest,
  AnthropicStreamHandlers,
  AnthropicTokenService,
  AnthropicUsage,
} from "./types.js";

/**
 * Server-side only. The client resolves credentials from the environment
 * (ANTHROPIC_API_KEY or an `ant auth login` profile). The key is never
 * accepted from, echoed to, or logged for callers.
 */
export function createAnthropicTokenService(
  client: Anthropic = new Anthropic(),
): AnthropicTokenService {
  return {
    async countInputTokens(
      request: AnthropicRequest,
    ): Promise<AnthropicInputCount> {
      const response = await client.messages.countTokens({
        model: request.model,
        messages: request.messages,
        ...(request.system ? { system: request.system } : {}),
        ...(request.tools && request.tools.length > 0
          ? { tools: request.tools }
          : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.outputConfig
          ? { output_config: request.outputConfig }
          : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      });
      return {
        tokens: response.input_tokens,
        quality: "anthropic_verified",
        countedAt: new Date().toISOString(),
      };
    },

    async streamMessage(
      request: AnthropicRequest,
      handlers: AnthropicStreamHandlers,
    ): Promise<AnthropicFinalResult> {
      const startedAtMs = Date.now();
      const requestStartedAt = new Date(startedAtMs).toISOString();
      let firstTokenAtMs: number | undefined;

      try {
        const stream = client.messages.stream({
          model: request.model,
          max_tokens: request.maxTokens,
          messages: request.messages,
          ...(request.system ? { system: request.system } : {}),
          ...(request.tools && request.tools.length > 0
            ? { tools: request.tools }
            : {}),
          ...(request.thinking ? { thinking: request.thinking } : {}),
          ...(request.outputConfig
            ? { output_config: request.outputConfig }
            : {}),
          ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
          ...(request.stopSequences && request.stopSequences.length > 0
            ? { stop_sequences: request.stopSequences }
            : {}),
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        });

        stream.on("text", (delta) => {
          if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
          handlers.onTextDelta?.(delta);
        });

        stream.on("streamEvent", (event) => {
          if (event.type === "message_delta" && event.usage) {
            handlers.onUsageUpdate?.({
              outputTokens: event.usage.output_tokens,
            });
          }
        });

        const message = await stream.finalMessage();
        const completedAtMs = Date.now();

        const usage: AnthropicUsage = {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.usage.cache_creation_input_tokens != null
            ? { cacheCreationInputTokens: message.usage.cache_creation_input_tokens }
            : {}),
          ...(message.usage.cache_read_input_tokens != null
            ? { cacheReadInputTokens: message.usage.cache_read_input_tokens }
            : {}),
          ...(message.usage.output_tokens_details?.thinking_tokens != null
            ? {
                thinkingTokens:
                  message.usage.output_tokens_details.thinking_tokens,
              }
            : {}),
        };

        const text = message.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text",
          )
          .map((block) => block.text)
          .join("");

        const result: AnthropicFinalResult = {
          model: message.model,
          stopReason: message.stop_reason,
          hitConfiguredOutputLimit: message.stop_reason === "max_tokens",
          usage,
          text,
          requestStartedAt,
          ...(firstTokenAtMs !== undefined
            ? {
                firstTokenAt: new Date(firstTokenAtMs).toISOString(),
                timeToFirstTokenMs: firstTokenAtMs - startedAtMs,
              }
            : {}),
          completedAt: new Date(completedAtMs).toISOString(),
          totalLatencyMs: completedAtMs - startedAtMs,
        };

        handlers.onComplete?.(result);
        return result;
      } catch (error) {
        handlers.onError?.(error);
        throw error;
      }
    },

    async getModelMetadata(model: string): Promise<AnthropicModelMetadata> {
      // Local versioned registry for now; a live GET /v1/models/{id}
      // verification pass is on the backlog (drift handling).
      return requireModel(model);
    },
  };
}

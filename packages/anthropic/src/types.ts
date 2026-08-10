import type { InputTokenCount } from "@token-forecaster/core";
import type { ModelRegistryEntry } from "@token-forecaster/model-registry";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The composed request we count and execute. Mirrors the Messages API shape
 * so count_tokens sees exactly what messages.create would see.
 */
export interface AnthropicRequest {
  model: string;
  system?: Anthropic.MessageCreateParams["system"];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.MessageCreateParams["tools"];
  maxTokens: number;
  thinking?: Anthropic.ThinkingConfigParam;
  outputConfig?: Anthropic.OutputConfig;
  toolChoice?: Anthropic.ToolChoice;
  stopSequences?: string[];
  temperature?: number;
  topP?: number;
}

export type AnthropicInputCount = InputTokenCount;

/** Normalized usage from Anthropic's response. Provider values authoritative. */
export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Reported thinking tokens where the API provides them. */
  thinkingTokens?: number;
}

export interface AnthropicFinalResult {
  model: string;
  stopReason: string | null;
  /** True when stopReason is "max_tokens": a right-censored observation. */
  hitConfiguredOutputLimit: boolean;
  usage: AnthropicUsage;
  text: string;
  requestStartedAt: string;
  firstTokenAt?: string;
  completedAt: string;
  timeToFirstTokenMs?: number;
  totalLatencyMs: number;
}

export interface AnthropicStreamHandlers {
  onTextDelta?(text: string): void;
  onUsageUpdate?(usage: Partial<AnthropicUsage>): void;
  onComplete?(result: AnthropicFinalResult): void;
  onError?(error: unknown): void;
}

export type AnthropicModelMetadata = ModelRegistryEntry;

/**
 * The Anthropic-specific service interface. Deliberately not a generic
 * multi-provider abstraction (see research/decisions/0001-anthropic-only-mvp.md).
 */
export interface AnthropicTokenService {
  countInputTokens(request: AnthropicRequest): Promise<AnthropicInputCount>;
  streamMessage(
    request: AnthropicRequest,
    handlers: AnthropicStreamHandlers,
  ): Promise<AnthropicFinalResult>;
  getModelMetadata(model: string): Promise<AnthropicModelMetadata>;
}

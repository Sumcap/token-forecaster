/**
 * The only messages that cross a context boundary in this extension.
 *
 * Settings deliberately do NOT travel as messages: every context reads
 * `chrome.storage.local` directly and reacts to `chrome.storage.onChanged`,
 * so there is no request/response path that can go stale.
 */

export const COUNT_TOKENS = "tf/count-tokens" as const;
export const COUNT_TOKENS_RESULT = "tf/count-tokens-result" as const;
export const TEST_API_KEY = "tf/test-api-key" as const;
export const OPEN_OPTIONS = "tf/open-options" as const;
export const TEST_API_KEY_RESULT = "tf/test-api-key-result" as const;
export const QUEUE_TELEMETRY = "tf/queue-telemetry" as const;
export const FLUSH_TELEMETRY = "tf/flush-telemetry" as const;
export const TELEMETRY_STATUS = "tf/telemetry-status" as const;
export const DELETE_TELEMETRY = "tf/delete-telemetry" as const;

import type { ExtensionTelemetryClientEvent } from "@token-forecaster/core";

export interface CountTokensRequest {
  type: typeof COUNT_TOKENS;
  /** Correlates with the CountReconciler ticket that issued the request. */
  requestId: number;
  /** A registry-validated model id. The worker never trusts DOM text. */
  model: string;
  /** The draft only. The conversation transcript is never sent anywhere. */
  text: string;
}

export type CountTokensResponse =
  | { type: typeof COUNT_TOKENS_RESULT; requestId: number; ok: true; tokens: number }
  | {
      type: typeof COUNT_TOKENS_RESULT;
      requestId: number;
      ok: false;
      error: string;
      status?: number;
    };

export interface OpenOptionsRequest {
  type: typeof OPEN_OPTIONS;
}

export interface TestApiKeyRequest {
  type: typeof TEST_API_KEY;
  apiKey: string;
}

export interface QueueTelemetryRequest {
  type: typeof QUEUE_TELEMETRY;
  event: ExtensionTelemetryClientEvent;
}

export interface FlushTelemetryRequest {
  type: typeof FLUSH_TELEMETRY;
}

export interface TelemetryStatusRequest {
  type: typeof TELEMETRY_STATUS;
}

export interface DeleteTelemetryRequest {
  type: typeof DELETE_TELEMETRY;
}

export interface TelemetryStatusResponse {
  type: typeof TELEMETRY_STATUS;
  configured: boolean;
  queued: number;
  registered: boolean;
  lastErrorCode: string | null;
}

export type DeleteTelemetryResponse =
  | { type: typeof DELETE_TELEMETRY; ok: true }
  | { type: typeof DELETE_TELEMETRY; ok: false; error: string };

export type TestApiKeyResponse =
  | { type: typeof TEST_API_KEY_RESULT; ok: true; tokens: number }
  | { type: typeof TEST_API_KEY_RESULT; ok: false; error: string };

export function isCountTokensRequest(value: unknown): value is CountTokensRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<CountTokensRequest>;
  return (
    message.type === COUNT_TOKENS &&
    typeof message.requestId === "number" &&
    typeof message.model === "string" &&
    typeof message.text === "string"
  );
}

export function isOpenOptionsRequest(value: unknown): value is OpenOptionsRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === OPEN_OPTIONS
  );
}

export function isTestApiKeyRequest(value: unknown): value is TestApiKeyRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<TestApiKeyRequest>;
  return message.type === TEST_API_KEY && typeof message.apiKey === "string";
}

export function isQueueTelemetryRequest(value: unknown): value is QueueTelemetryRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === QUEUE_TELEMETRY &&
    "event" in value
  );
}

export function isFlushTelemetryRequest(value: unknown): value is FlushTelemetryRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === FLUSH_TELEMETRY
  );
}

export function isTelemetryStatusRequest(value: unknown): value is TelemetryStatusRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === TELEMETRY_STATUS
  );
}

export function isDeleteTelemetryRequest(value: unknown): value is DeleteTelemetryRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === DELETE_TELEMETRY
  );
}

/**
 * Service worker. It owns privileged network boundaries: the strictly opt-in
 * Anthropic count and the separately consented, schema-validated telemetry
 * queue. Forecasting itself remains in the content script and fully offline.
 *
 * It holds no forecast logic. It reads the API key from storage itself so the
 * key never travels through the content script or sits in the page's world.
 */
import { getModel } from "@token-forecaster/model-registry";
import {
  COUNT_TOKENS_RESULT,
  DELETE_TELEMETRY,
  FLUSH_TELEMETRY,
  QUEUE_TELEMETRY,
  TELEMETRY_STATUS,
  TEST_API_KEY_RESULT,
  isCountTokensRequest,
  isDeleteTelemetryRequest,
  isFlushTelemetryRequest,
  isOpenOptionsRequest,
  isQueueTelemetryRequest,
  isTelemetryStatusRequest,
  isTestApiKeyRequest,
  type CountTokensResponse,
  type TestApiKeyResponse,
} from "../lib/messages.js";
import {
  ONBOARDING_VERSION,
  WELCOME_PATH,
  shouldOpenWelcome,
} from "../lib/onboarding.js";
import { loadSettings, saveSettings, subscribeSettings } from "../lib/settings.js";
import {
  TELEMETRY_ALARM,
  deleteTelemetryData,
  enqueueTelemetry,
  flushTelemetry,
  reconcileTelemetryConsent,
  telemetryStatus,
} from "./telemetry.js";

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 20_000;

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Not JSON: fall through to the truncated body.
  }
  return text.slice(0, 200);
}

/**
 * Count one user message. The dated snapshot id is preferred because the API
 * rejects ids it does not know, and the registry holds both forms.
 */
async function countTokens(
  apiKey: string,
  modelId: string,
  text: string,
): Promise<{ ok: true; tokens: number } | { ok: false; error: string; status?: number }> {
  if (apiKey.length === 0) return { ok: false, error: "No API key is set in options." };
  const entry = getModel(modelId);
  const model = entry?.snapshot ?? modelId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: await errorDetail(response), status: response.status };
    }
    const body = (await response.json()) as { input_tokens?: unknown };
    if (!Number.isInteger(body.input_tokens) || Number(body.input_tokens) < 0) {
      return { ok: false, error: "The API returned no usable token count." };
    }
    return { ok: true, tokens: Number(body.input_tokens) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Timed out after ${TIMEOUT_MS / 1_000} seconds.` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isCountTokensRequest(message)) {
    void (async () => {
      const settings = await loadSettings();
      if (!settings.verifyEnabled) {
        const response: CountTokensResponse = {
          type: COUNT_TOKENS_RESULT,
          requestId: message.requestId,
          ok: false,
          error: "Verified counting is off.",
        };
        sendResponse(response);
        return;
      }
      const result = await countTokens(settings.apiKey, message.model, message.text);
      const response: CountTokensResponse = result.ok
        ? {
            type: COUNT_TOKENS_RESULT,
            requestId: message.requestId,
            ok: true,
            tokens: result.tokens,
          }
        : {
            type: COUNT_TOKENS_RESULT,
            requestId: message.requestId,
            ok: false,
            error: result.error,
            ...(result.status === undefined ? {} : { status: result.status }),
          };
      sendResponse(response);
    })();
    return true;
  }

  if (isTestApiKeyRequest(message)) {
    void (async () => {
      const result = await countTokens(message.apiKey, "claude-sonnet-5", "ping");
      const response: TestApiKeyResponse = result.ok
        ? { type: TEST_API_KEY_RESULT, ok: true, tokens: result.tokens }
        : { type: TEST_API_KEY_RESULT, ok: false, error: result.error };
      sendResponse(response);
    })();
    return true;
  }

  if (isOpenOptionsRequest(message)) {
    void chrome.runtime.openOptionsPage();
    return false;
  }

  if (isQueueTelemetryRequest(message)) {
    void enqueueTelemetry(message.event).then((accepted) =>
      sendResponse({ type: QUEUE_TELEMETRY, accepted }),
    );
    return true;
  }

  if (isFlushTelemetryRequest(message)) {
    void flushTelemetry(true).then(() => sendResponse({ type: FLUSH_TELEMETRY, ok: true }));
    return true;
  }

  if (isTelemetryStatusRequest(message)) {
    void telemetryStatus().then((status) =>
      sendResponse({ type: TELEMETRY_STATUS, ...status }),
    );
    return true;
  }

  if (isDeleteTelemetryRequest(message)) {
    void deleteTelemetryData().then((result) =>
      sendResponse({ type: DELETE_TELEMETRY, ...result }),
    );
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

/**
 * Onboarding. A fresh install opens the welcome page once; an update never
 * does, because stealing a tab on an auto-update is a nuisance the user did
 * not ask for. The flag is written only after the tab actually opens, so a
 * browser that refuses the tab leaves the next install able to try again.
 */
chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    const settings = await loadSettings();
    if (!shouldOpenWelcome(details.reason, settings.onboardingSeenVersion)) return;
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PATH), active: true });
    } catch {
      // No tab, no onboarding, and no crash. The chip works either way.
      return;
    }
    await saveSettings({ onboardingSeenVersion: ONBOARDING_VERSION });
  })();
  chrome.alarms.create(TELEMETRY_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TELEMETRY_ALARM) void flushTelemetry();
});

subscribeSettings((settings) => {
  void reconcileTelemetryConsent(settings);
});

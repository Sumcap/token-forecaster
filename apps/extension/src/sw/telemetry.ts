import {
  extensionTelemetryClientEventSchema,
  type ExtensionTelemetryClientEvent,
} from "@token-forecaster/core";
import {
  loadSettings,
  saveSettings,
  TELEMETRY_CONSENT_VERSION,
  type TfSettings,
} from "../lib/settings.js";
import {
  TELEMETRY_ORIGIN,
  telemetryConfigured,
  telemetryOriginPattern,
} from "../lib/telemetry-config.js";

export const TELEMETRY_STATE_KEY = "tf-telemetry-state";
export const TELEMETRY_ALARM = "tf-telemetry-flush";
const MAX_QUEUED_EVENTS = 250;
const BATCH_SIZE = 25;
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_MS = 5 * 60_000;

interface TelemetryCredentials {
  accessToken: string;
  deletionToken: string;
}

export interface TelemetryState {
  queue: ExtensionTelemetryClientEvent[];
  credentials: TelemetryCredentials | null;
  nextAttemptAt: number;
  lastErrorCode: "network_error" | "permission_missing" | "collector_not_configured" | null;
}

export interface TelemetryStatus {
  configured: boolean;
  queued: number;
  registered: boolean;
  lastErrorCode: TelemetryState["lastErrorCode"];
}

const EMPTY_STATE: TelemetryState = {
  queue: [],
  credentials: null,
  nextAttemptAt: 0,
  lastErrorCode: null,
};

let pending: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeState(value: unknown): TelemetryState {
  if (typeof value !== "object" || value === null) return { ...EMPTY_STATE, queue: [] };
  const raw = value as Record<string, unknown>;
  const submittedQueue = Array.isArray(raw.queue) ? raw.queue : [];
  const queue: ExtensionTelemetryClientEvent[] = [];
  for (const candidate of submittedQueue.slice(-MAX_QUEUED_EVENTS)) {
    const parsed = extensionTelemetryClientEventSchema.safeParse(candidate);
    if (parsed.success) queue.push(parsed.data);
  }
  const candidateCredentials = raw.credentials;
  const credentials =
    typeof candidateCredentials === "object" &&
    candidateCredentials !== null &&
    typeof (candidateCredentials as Record<string, unknown>).accessToken === "string" &&
    typeof (candidateCredentials as Record<string, unknown>).deletionToken === "string"
      ? {
          accessToken: (candidateCredentials as Record<string, string>).accessToken!,
          deletionToken: (candidateCredentials as Record<string, string>).deletionToken!,
        }
      : null;
  const lastErrorCode =
    raw.lastErrorCode === "network_error" ||
    raw.lastErrorCode === "permission_missing" ||
    raw.lastErrorCode === "collector_not_configured"
      ? raw.lastErrorCode
      : null;
  return {
    queue,
    credentials,
    nextAttemptAt:
      typeof raw.nextAttemptAt === "number" && Number.isFinite(raw.nextAttemptAt)
        ? Math.max(0, raw.nextAttemptAt)
        : 0,
    lastErrorCode,
  };
}

async function loadState(): Promise<TelemetryState> {
  const stored = await chrome.storage.local.get(TELEMETRY_STATE_KEY);
  return normalizeState(stored[TELEMETRY_STATE_KEY]);
}

async function saveState(state: TelemetryState): Promise<void> {
  await chrome.storage.local.set({ [TELEMETRY_STATE_KEY]: state });
}

function consentAllows(event: ExtensionTelemetryClientEvent, settings: TfSettings): boolean {
  return event.kind === "diagnostic"
    ? settings.diagnosticsConsent === "granted"
    : settings.researchConsent === "granted";
}

async function collectorPermissionGranted(): Promise<boolean> {
  const pattern = telemetryOriginPattern();
  if (pattern === null) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function register(state: TelemetryState): Promise<TelemetryCredentials | null> {
  try {
    const response = await fetchWithTimeout(`${TELEMETRY_ORIGIN}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        extensionVersion: chrome.runtime.getManifest().version,
        consentVersion: TELEMETRY_CONSENT_VERSION,
      }),
    });
    if (!response.ok) throw new Error(`registration failed (${response.status})`);
    const body = (await response.json()) as Partial<TelemetryCredentials>;
    if (typeof body.accessToken !== "string" || typeof body.deletionToken !== "string") {
      throw new Error("registration response was invalid");
    }
    state.credentials = { accessToken: body.accessToken, deletionToken: body.deletionToken };
    return state.credentials;
  } catch {
    state.lastErrorCode = "network_error";
    state.nextAttemptAt = Date.now() + RETRY_MS;
    return null;
  }
}

async function flushUnlocked(force = false): Promise<void> {
  const state = await loadState();
  const settings = await loadSettings();
  state.queue = state.queue.filter((event) => consentAllows(event, settings));
  if (state.queue.length === 0) {
    await saveState(state);
    return;
  }
  if (!telemetryConfigured()) {
    state.lastErrorCode = "collector_not_configured";
    await saveState(state);
    return;
  }
  if (!(await collectorPermissionGranted())) {
    state.lastErrorCode = "permission_missing";
    await saveState(state);
    return;
  }
  if (!force && Date.now() < state.nextAttemptAt) {
    await saveState(state);
    return;
  }
  const credentials = state.credentials ?? (await register(state));
  if (credentials === null) {
    await saveState(state);
    return;
  }
  const batch = state.queue.slice(0, BATCH_SIZE);
  try {
    const response = await fetchWithTimeout(`${TELEMETRY_ORIGIN}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events: batch }),
    });
    if (response.status === 401) state.credentials = null;
    if (!response.ok) throw new Error(`ingest failed (${response.status})`);
    const accepted = new Set(batch.map((event) => event.id));
    state.queue = state.queue.filter((event) => !accepted.has(event.id));
    state.lastErrorCode = null;
    state.nextAttemptAt = 0;
  } catch {
    state.lastErrorCode = "network_error";
    state.nextAttemptAt = Date.now() + RETRY_MS;
  }
  await saveState(state);
}

export function enqueueTelemetry(event: unknown): Promise<boolean> {
  return serialize(async () => {
    const parsed = extensionTelemetryClientEventSchema.safeParse(event);
    if (!parsed.success) return false;
    const settings = await loadSettings();
    if (!consentAllows(parsed.data, settings)) return false;
    const state = await loadState();
    if (state.queue.some((queued) => queued.id === parsed.data.id)) return true;
    state.queue.push(parsed.data);
    if (state.queue.length > MAX_QUEUED_EVENTS) {
      // Diagnostics are cheaper to recreate; preserve research outcomes first.
      const diagnostic = state.queue.findIndex((queued) => queued.kind === "diagnostic");
      state.queue.splice(diagnostic >= 0 ? diagnostic : 0, 1);
    }
    await saveState(state);
    await flushUnlocked();
    return true;
  });
}

export function flushTelemetry(force = false): Promise<void> {
  return serialize(() => flushUnlocked(force));
}

export function reconcileTelemetryConsent(settings: TfSettings): Promise<void> {
  return serialize(async () => {
    const state = await loadState();
    state.queue = state.queue.filter((event) => consentAllows(event, settings));
    await saveState(state);
  });
}

export function telemetryStatus(): Promise<TelemetryStatus> {
  return serialize(async () => {
    const state = await loadState();
    return {
      configured: telemetryConfigured(),
      queued: state.queue.length,
      registered: state.credentials !== null,
      lastErrorCode: state.lastErrorCode,
    };
  });
}

export function deleteTelemetryData(): Promise<{ ok: true } | { ok: false; error: string }> {
  return serialize(async () => {
    const state = await loadState();
    if (state.credentials !== null && telemetryConfigured()) {
      if (!(await collectorPermissionGranted())) {
        return { ok: false, error: "Collector permission is not granted." };
      }
      try {
        const response = await fetchWithTimeout(
          `${TELEMETRY_ORIGIN}/v1/installations/current`,
          {
            method: "DELETE",
            headers: { authorization: `Deletion ${state.credentials.deletionToken}` },
          },
        );
        if (!response.ok) {
          return { ok: false, error: `Deletion failed (${response.status}).` };
        }
      } catch {
        return { ok: false, error: "The collector could not be reached." };
      }
    }
    await chrome.storage.local.remove(TELEMETRY_STATE_KEY);
    await saveSettings({ diagnosticsConsent: "denied", researchConsent: "denied" });
    const pattern = telemetryOriginPattern();
    if (pattern !== null) await chrome.permissions.remove({ origins: [pattern] });
    return { ok: true };
  });
}

/**
 * Options page. Writes the one settings object; the content script picks the
 * change up through `chrome.storage.onChanged` with no reload.
 */
import { listModels } from "@token-forecaster/model-registry";
import {
  DELETE_TELEMETRY,
  FLUSH_TELEMETRY,
  TELEMETRY_STATUS,
  TEST_API_KEY,
  type DeleteTelemetryRequest,
  type DeleteTelemetryResponse,
  type FlushTelemetryRequest,
  type TelemetryStatusRequest,
  type TelemetryStatusResponse,
  type TestApiKeyRequest,
  type TestApiKeyResponse,
} from "../lib/messages.js";
import { profileProvenanceLines, summarizeProfile } from "../lib/profile-info.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { setTelemetryConsent } from "../lib/telemetry-consent.js";
import { telemetryConfigured } from "../lib/telemetry-config.js";
import type { ThinkingSetting } from "../lib/thinking.js";

const ANTHROPIC_ORIGIN = "https://api.anthropic.com/*";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`options.html is missing #${id}`);
  return element as T;
}

const chipEnabled = byId<HTMLInputElement>("chipEnabled");
const startExpanded = byId<HTMLInputElement>("startExpanded");
const showInChat = byId<HTMLInputElement>("showInChat");
const transcriptGaugeEnabled = byId<HTMLInputElement>("transcriptGaugeEnabled");
const liveTrackingEnabled = byId<HTMLInputElement>("liveTrackingEnabled");
const verdictsEnabled = byId<HTMLInputElement>("verdictsEnabled");
const modelOverride = byId<HTMLSelectElement>("modelOverride");
const thinking = byId<HTMLSelectElement>("thinking");
const verifyEnabled = byId<HTMLInputElement>("verifyEnabled");
const apiKey = byId<HTMLInputElement>("apiKey");
const testKey = byId<HTMLButtonElement>("testKey");
const testStatus = byId<HTMLSpanElement>("testStatus");
const saved = byId<HTMLParagraphElement>("saved");
const diagnosticsConsent = byId<HTMLInputElement>("diagnosticsConsent");
const researchConsent = byId<HTMLInputElement>("researchConsent");
const flushTelemetry = byId<HTMLButtonElement>("flushTelemetry");
const deleteTelemetry = byId<HTMLButtonElement>("deleteTelemetry");
const telemetryStatus = byId<HTMLParagraphElement>("telemetryStatus");

function fillModels(): void {
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "Auto (read the page)";
  modelOverride.append(auto);
  for (const entry of listModels()) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.displayName;
    modelOverride.append(option);
  }
}

/** The same provenance the welcome page states, so the two cannot drift. */
function renderProfile(): void {
  const summary = summarizeProfile();
  const [provenance, caveat] = profileProvenanceLines(summary);
  byId<HTMLParagraphElement>("provenance").textContent = provenance;
  byId<HTMLParagraphElement>("provenanceCaveat").textContent = caveat;
  byId<HTMLParagraphElement>("profileId").textContent = `${summary.id} · ${summary.scope}`;
}

let savedTimer = 0;
function flashSaved(): void {
  saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    saved.hidden = true;
  }, 1_500) as unknown as number;
}

async function persist(): Promise<void> {
  await saveSettings({
    chipEnabled: chipEnabled.checked,
    startExpanded: startExpanded.checked,
    showInChat: showInChat.checked,
    transcriptGaugeEnabled: transcriptGaugeEnabled.checked,
    liveTrackingEnabled: liveTrackingEnabled.checked,
    verdictsEnabled: verdictsEnabled.checked,
    modelOverride: modelOverride.value,
    thinking: thinking.value as ThinkingSetting,
    verifyEnabled: verifyEnabled.checked,
    apiKey: apiKey.value.trim(),
  });
  flashSaved();
}

/**
 * The host permission is optional and is only asked for at the moment the user
 * turns verification on. Declining leaves the feature off rather than half on.
 */
async function onVerifyToggled(): Promise<void> {
  if (!verifyEnabled.checked) {
    await persist();
    return;
  }
  const granted =
    (await chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] })) ||
    (await chrome.permissions.request({ origins: [ANTHROPIC_ORIGIN] }));
  if (!granted) {
    verifyEnabled.checked = false;
    testStatus.textContent = "Access to api.anthropic.com was declined.";
    testStatus.className = "status bad";
  }
  await persist();
}

async function onTestKey(): Promise<void> {
  const key = apiKey.value.trim();
  if (key.length === 0) {
    testStatus.textContent = "Enter a key first.";
    testStatus.className = "status bad";
    return;
  }
  const granted =
    (await chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] })) ||
    (await chrome.permissions.request({ origins: [ANTHROPIC_ORIGIN] }));
  if (!granted) {
    testStatus.textContent = "Access to api.anthropic.com was declined.";
    testStatus.className = "status bad";
    return;
  }
  testStatus.textContent = "Testing...";
  testStatus.className = "status";
  const request: TestApiKeyRequest = { type: TEST_API_KEY, apiKey: key };
  const response = await chrome.runtime
    .sendMessage<TestApiKeyRequest, TestApiKeyResponse>(request)
    .catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (response.ok) {
    testStatus.textContent = `Works. The endpoint counted ${response.tokens} tokens for "ping".`;
    testStatus.className = "status ok";
  } else {
    testStatus.textContent = response.error;
    testStatus.className = "status bad";
  }
}

async function refreshTelemetryStatus(message?: string): Promise<void> {
  if (!telemetryConfigured()) {
    telemetryStatus.textContent =
      "This build has no collector configured. Contribution controls stay unavailable.";
    telemetryStatus.className = "status bad";
    diagnosticsConsent.disabled = true;
    researchConsent.disabled = true;
    flushTelemetry.disabled = true;
    deleteTelemetry.disabled = true;
    return;
  }
  const request: TelemetryStatusRequest = { type: TELEMETRY_STATUS };
  const response = await chrome.runtime
    .sendMessage<TelemetryStatusRequest, TelemetryStatusResponse>(request)
    .catch(() => null);
  if (response === null) {
    telemetryStatus.textContent = message ?? "Telemetry status is temporarily unavailable.";
    telemetryStatus.className = "status bad";
    return;
  }
  const parts = [
    response.registered ? "Anonymous collector registration active." : "No data sent yet.",
    response.queued === 0 ? "Queue empty." : `${response.queued} event(s) queued.`,
  ];
  if (response.lastErrorCode !== null) parts.push(`Last delivery: ${response.lastErrorCode}.`);
  telemetryStatus.textContent = message ?? parts.join(" ");
  telemetryStatus.className = response.lastErrorCode === null ? "status ok" : "status bad";
}

async function onTelemetryToggled(kind: "diagnostics" | "research"): Promise<void> {
  const control = kind === "diagnostics" ? diagnosticsConsent : researchConsent;
  control.disabled = true;
  const result = await setTelemetryConsent(kind, control.checked);
  control.checked = result.state === "granted";
  control.disabled = false;
  await refreshTelemetryStatus(result.error);
}

async function onFlushTelemetry(): Promise<void> {
  const request: FlushTelemetryRequest = { type: FLUSH_TELEMETRY };
  flushTelemetry.disabled = true;
  await chrome.runtime.sendMessage(request).catch(() => undefined);
  flushTelemetry.disabled = false;
  await refreshTelemetryStatus();
}

async function onDeleteTelemetry(): Promise<void> {
  if (!window.confirm("Permanently delete this installation's contributed data?")) return;
  const request: DeleteTelemetryRequest = { type: DELETE_TELEMETRY };
  deleteTelemetry.disabled = true;
  const response = await chrome.runtime
    .sendMessage<DeleteTelemetryRequest, DeleteTelemetryResponse>(request)
    .catch(() => ({ type: DELETE_TELEMETRY, ok: false as const, error: "Deletion failed." }));
  deleteTelemetry.disabled = false;
  if (response.ok) {
    diagnosticsConsent.checked = false;
    researchConsent.checked = false;
    await refreshTelemetryStatus("Local queue and contributed server rows were deleted.");
  } else {
    await refreshTelemetryStatus(response.error);
  }
}

async function init(): Promise<void> {
  fillModels();
  renderProfile();
  const settings = await loadSettings();
  chipEnabled.checked = settings.chipEnabled;
  startExpanded.checked = settings.startExpanded;
  showInChat.checked = settings.showInChat;
  transcriptGaugeEnabled.checked = settings.transcriptGaugeEnabled;
  liveTrackingEnabled.checked = settings.liveTrackingEnabled;
  verdictsEnabled.checked = settings.verdictsEnabled;
  modelOverride.value = settings.modelOverride;
  thinking.value = settings.thinking;
  verifyEnabled.checked = settings.verifyEnabled;
  apiKey.value = settings.apiKey;
  diagnosticsConsent.checked = settings.diagnosticsConsent === "granted";
  researchConsent.checked = settings.researchConsent === "granted";

  for (const element of [
    chipEnabled,
    startExpanded,
    showInChat,
    transcriptGaugeEnabled,
    liveTrackingEnabled,
    verdictsEnabled,
    modelOverride,
    thinking,
  ]) {
    element.addEventListener("change", () => void persist());
  }
  apiKey.addEventListener("change", () => void persist());
  verifyEnabled.addEventListener("change", () => void onVerifyToggled());
  testKey.addEventListener("click", () => void onTestKey());
  diagnosticsConsent.addEventListener("change", () => void onTelemetryToggled("diagnostics"));
  researchConsent.addEventListener("change", () => void onTelemetryToggled("research"));
  flushTelemetry.addEventListener("click", () => void onFlushTelemetry());
  deleteTelemetry.addEventListener("click", () => void onDeleteTelemetry());
  await refreshTelemetryStatus();
}

void init();

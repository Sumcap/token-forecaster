/**
 * The page a fresh install opens once.
 *
 * It explains the three numbers, states what never leaves the browser, and
 * names the profile the forecast comes from. The two toggles it offers are the
 * two a new user actually has an opinion about; everything else stays in the
 * settings page. Opening this page is what marks onboarding as seen, so a
 * failed tab open leaves the flag alone and the next install still shows it.
 */
import { ONBOARDING_VERSION } from "../lib/onboarding.js";
import { profileProvenanceLines, summarizeProfile } from "../lib/profile-info.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { setTelemetryConsent } from "../lib/telemetry-consent.js";
import { telemetryConfigured } from "../lib/telemetry-config.js";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`welcome.html is missing #${id}`);
  return element as T;
}

const showInChat = byId<HTMLInputElement>("showInChat");
const transcriptGaugeEnabled = byId<HTMLInputElement>("transcriptGaugeEnabled");
const openOptions = byId<HTMLButtonElement>("openOptions");
const saved = byId<HTMLSpanElement>("saved");
const diagnosticsConsent = byId<HTMLInputElement>("diagnosticsConsent");
const researchConsent = byId<HTMLInputElement>("researchConsent");
const telemetryStatus = byId<HTMLParagraphElement>("telemetryStatus");

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
    showInChat: showInChat.checked,
    transcriptGaugeEnabled: transcriptGaugeEnabled.checked,
  });
  flashSaved();
}

function renderProfile(): void {
  const summary = summarizeProfile();
  const [provenance, caveat] = profileProvenanceLines(summary);
  byId<HTMLParagraphElement>("provenance").textContent = provenance;
  byId<HTMLParagraphElement>("provenanceCaveat").textContent = caveat;
  byId<HTMLParagraphElement>("profileId").textContent = `${summary.id} · ${summary.scope}`;
}

async function onTelemetryToggled(kind: "diagnostics" | "research"): Promise<void> {
  const control = kind === "diagnostics" ? diagnosticsConsent : researchConsent;
  control.disabled = true;
  const result = await setTelemetryConsent(kind, control.checked);
  control.checked = result.state === "granted";
  control.disabled = false;
  telemetryStatus.textContent = result.error ?? (control.checked ? "Contribution enabled." : "Contribution remains off.");
  telemetryStatus.className = result.ok ? "status ok" : "status bad";
}

async function init(): Promise<void> {
  renderProfile();
  const settings = await loadSettings();
  showInChat.checked = settings.showInChat;
  transcriptGaugeEnabled.checked = settings.transcriptGaugeEnabled;
  diagnosticsConsent.checked = settings.diagnosticsConsent === "granted";
  researchConsent.checked = settings.researchConsent === "granted";

  if (!telemetryConfigured()) {
    diagnosticsConsent.disabled = true;
    researchConsent.disabled = true;
    telemetryStatus.textContent =
      "This build has no collector configured, so contribution stays unavailable.";
    telemetryStatus.className = "status bad";
  } else {
    telemetryStatus.textContent =
      settings.diagnosticsConsent === "granted" || settings.researchConsent === "granted"
        ? "Your saved contribution choices are active."
        : "Both contribution choices are off.";
    telemetryStatus.className = "status";
  }

  for (const element of [showInChat, transcriptGaugeEnabled]) {
    element.addEventListener("change", () => void persist());
  }
  diagnosticsConsent.addEventListener("change", () => void onTelemetryToggled("diagnostics"));
  researchConsent.addEventListener("change", () => void onTelemetryToggled("research"));
  openOptions.addEventListener("click", () => void chrome.runtime.openOptionsPage());

  if (settings.onboardingSeenVersion < ONBOARDING_VERSION) {
    await saveSettings({ onboardingSeenVersion: ONBOARDING_VERSION });
  }
}

void init();

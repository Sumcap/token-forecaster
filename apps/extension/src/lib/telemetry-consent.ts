import {
  FLUSH_TELEMETRY,
  type FlushTelemetryRequest,
} from "./messages.js";
import { saveSettings, type TelemetryConsent } from "./settings.js";
import {
  telemetryConfigured,
  telemetryOriginPattern,
} from "./telemetry-config.js";

export type TelemetryConsentKind = "diagnostics" | "research";

export interface ConsentChangeResult {
  ok: boolean;
  state: TelemetryConsent;
  error?: string;
}

/** Runtime host permission is requested only from the user's checkbox click. */
export async function setTelemetryConsent(
  kind: TelemetryConsentKind,
  granted: boolean,
): Promise<ConsentChangeResult> {
  const field = kind === "diagnostics" ? "diagnosticsConsent" : "researchConsent";
  if (!granted) {
    await saveSettings({ [field]: "denied" });
    return { ok: true, state: "denied" };
  }
  if (!telemetryConfigured()) {
    return {
      ok: false,
      state: "denied",
      error: "This build has no telemetry collector configured.",
    };
  }
  const pattern = telemetryOriginPattern();
  if (pattern === null) {
    return { ok: false, state: "denied", error: "Collector configuration is invalid." };
  }
  const permitted =
    (await chrome.permissions.contains({ origins: [pattern] })) ||
    (await chrome.permissions.request({ origins: [pattern] }));
  if (!permitted) {
    await saveSettings({ [field]: "denied" });
    return {
      ok: false,
      state: "denied",
      error: "Access to the telemetry collector was declined.",
    };
  }
  await saveSettings({ [field]: "granted" });
  const request: FlushTelemetryRequest = { type: FLUSH_TELEMETRY };
  await chrome.runtime.sendMessage(request).catch(() => undefined);
  return { ok: true, state: "granted" };
}

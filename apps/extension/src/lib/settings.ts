/**
 * Typed access to the one `chrome.storage.local` key this extension owns.
 *
 * Every default is the conservative one: the chip is on because that is the
 * whole product, and every path that could send text off the machine is off.
 */

export const SETTINGS_KEY = "tf-settings";

import type { ThinkingSetting } from "./thinking.js";

export type { ThinkingSetting };

export type TelemetryConsent = "unset" | "granted" | "denied";
export const TELEMETRY_CONSENT_VERSION = 1;

export interface TfSettings {
  /** Render the chip at all. */
  chipEnabled: boolean;
  /** `auto` reads claude.ai's model picker; anything else is a registry id. */
  modelOverride: string;
  /**
   * `on` by default: extended thinking is how claude.ai ships and how this
   * surface is used almost all of the time, and the thinking group is the
   * longer forecast, so the default errs towards reserving too much context
   * rather than too little. `auto` reads claude.ai's own effort control, then
   * the newest reply, and only then assumes: see `resolveThinking`.
   */
  thinking: ThinkingSetting;
  /**
   * Also render on the chat surface. Off by default: the shipped profile is
   * fitted on Claude Code agent traffic, so `/code` is the surface it
   * describes and chat is out of domain.
   */
  showInChat: boolean;
  /** Count the visible transcript as a context lower bound. */
  transcriptGaugeEnabled: boolean;
  /**
   * Follow the reply while it writes and score it against the forecast that
   * was frozen at send. Local only: it reads the rendered text, nothing else.
   */
  liveTrackingEnabled: boolean;
  /** Leave the score pinned to each scored reply after the turn ends. */
  verdictsEnabled: boolean;
  /** Opt in to Anthropic's count_tokens for an authoritative draft count. */
  verifyEnabled: boolean;
  /** Only read when `verifyEnabled` is true. Stored unencrypted. */
  apiKey: string;
  /** Open the chip expanded on every page load. */
  startExpanded: boolean;
  /**
   * Highest onboarding version this profile has already been shown. Zero means
   * the welcome page has never been opened, which is the state a fresh install
   * starts in.
   */
  onboardingSeenVersion: number;
  /** Anonymous operational events only; no prompt or reply text. */
  diagnosticsConsent: TelemetryConsent;
  /** Derived forecast observations used for research and model evaluation. */
  researchConsent: TelemetryConsent;
}

export const DEFAULT_SETTINGS: TfSettings = {
  chipEnabled: true,
  modelOverride: "auto",
  thinking: "on",
  showInChat: false,
  transcriptGaugeEnabled: true,
  liveTrackingEnabled: true,
  verdictsEnabled: true,
  verifyEnabled: false,
  apiKey: "",
  startExpanded: false,
  onboardingSeenVersion: 0,
  diagnosticsConsent: "unset",
  researchConsent: "unset",
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asVersion(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function asConsent(value: unknown): TelemetryConsent {
  return value === "granted" || value === "denied" ? value : "unset";
}

/** Coerce whatever is in storage into a complete, valid settings object. */
export function normalizeSettings(value: unknown): TfSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Record<string, unknown>;
  const thinking = raw["thinking"];
  return {
    chipEnabled: asBoolean(raw["chipEnabled"], DEFAULT_SETTINGS.chipEnabled),
    modelOverride: asString(raw["modelOverride"], DEFAULT_SETTINGS.modelOverride),
    // "unknown" was the old name for "read the page and accept not knowing",
    // so it maps to `auto` rather than to the new default.
    thinking:
      thinking === "on" || thinking === "off" || thinking === "auto"
        ? thinking
        : thinking === "unknown"
          ? "auto"
          : DEFAULT_SETTINGS.thinking,
    showInChat: asBoolean(raw["showInChat"], DEFAULT_SETTINGS.showInChat),
    transcriptGaugeEnabled: asBoolean(
      raw["transcriptGaugeEnabled"],
      DEFAULT_SETTINGS.transcriptGaugeEnabled,
    ),
    liveTrackingEnabled: asBoolean(
      raw["liveTrackingEnabled"],
      DEFAULT_SETTINGS.liveTrackingEnabled,
    ),
    verdictsEnabled: asBoolean(raw["verdictsEnabled"], DEFAULT_SETTINGS.verdictsEnabled),
    verifyEnabled: asBoolean(raw["verifyEnabled"], DEFAULT_SETTINGS.verifyEnabled),
    apiKey: asString(raw["apiKey"], DEFAULT_SETTINGS.apiKey),
    startExpanded: asBoolean(raw["startExpanded"], DEFAULT_SETTINGS.startExpanded),
    onboardingSeenVersion: asVersion(
      raw["onboardingSeenVersion"],
      DEFAULT_SETTINGS.onboardingSeenVersion,
    ),
    diagnosticsConsent: asConsent(raw["diagnosticsConsent"]),
    researchConsent: asConsent(raw["researchConsent"]),
  };
}

export async function loadSettings(): Promise<TfSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  } catch {
    // A revoked storage permission or a torn-down extension context must not
    // take the chip down with it.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<TfSettings>): Promise<TfSettings> {
  const current = await loadSettings();
  const next: TfSettings = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Fires on every write to the settings key, from any context. */
export function subscribeSettings(listener: (settings: TfSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (change === undefined) return;
    listener(normalizeSettings(change.newValue));
  });
}

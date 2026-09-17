import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings.js";

describe("normalizeSettings", () => {
  it("falls back to the defaults for anything unreadable", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("ships with every path that sends text off the machine turned off", () => {
    expect(DEFAULT_SETTINGS.verifyEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
  });

  it("requires separate affirmative consent for diagnostics and research", () => {
    expect(DEFAULT_SETTINGS.diagnosticsConsent).toBe("unset");
    expect(DEFAULT_SETTINGS.researchConsent).toBe("unset");
    expect(normalizeSettings({ diagnosticsConsent: "granted" }).diagnosticsConsent).toBe(
      "granted",
    );
    expect(normalizeSettings({ researchConsent: "yes please" }).researchConsent).toBe("unset");
  });

  it("defaults extended thinking to on and keeps auto as a choice", () => {
    expect(DEFAULT_SETTINGS.thinking).toBe("on");
    expect(normalizeSettings({ thinking: "auto" }).thinking).toBe("auto");
    expect(normalizeSettings({ thinking: "sometimes" }).thinking).toBe("on");
    // "unknown" was the old stored value for "read the page".
    expect(normalizeSettings({ thinking: "unknown" }).thinking).toBe("auto");
  });

  it("stays on the surface the profile describes until told otherwise", () => {
    expect(DEFAULT_SETTINGS.showInChat).toBe(false);
    expect(normalizeSettings({ showInChat: true }).showInChat).toBe(true);
  });

  it("keeps valid stored fields and repairs the rest", () => {
    const settings = normalizeSettings({
      chipEnabled: false,
      thinking: "on",
      modelOverride: "claude-opus-5",
      apiKey: 42,
    });
    expect(settings.chipEnabled).toBe(false);
    expect(settings.thinking).toBe("on");
    expect(settings.modelOverride).toBe("claude-opus-5");
    expect(settings.apiKey).toBe("");
  });
});

describe("normalizeSettings, the live half of the chip", () => {
  it("turns following the reply on by default", () => {
    expect(DEFAULT_SETTINGS.liveTrackingEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.verdictsEnabled).toBe(true);
  });

  it("keeps a settings object written before the feature existed", () => {
    const old = normalizeSettings({ chipEnabled: false, thinking: "off" });
    expect(old.chipEnabled).toBe(false);
    expect(old.liveTrackingEnabled).toBe(true);
    expect(old.verdictsEnabled).toBe(true);
  });

  it("respects a reader who has turned them off", () => {
    const off = normalizeSettings({ liveTrackingEnabled: false, verdictsEnabled: false });
    expect(off.liveTrackingEnabled).toBe(false);
    expect(off.verdictsEnabled).toBe(false);
  });
});

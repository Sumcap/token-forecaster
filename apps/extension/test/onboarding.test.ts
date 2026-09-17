import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_VERSION,
  WELCOME_PATH,
  shouldOpenWelcome,
} from "../src/lib/onboarding.js";
import { profileProvenanceLines, summarizeProfile } from "../src/lib/profile-info.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings.js";

describe("shouldOpenWelcome", () => {
  it("shows the welcome page on a fresh install", () => {
    expect(shouldOpenWelcome("install", DEFAULT_SETTINGS.onboardingSeenVersion)).toBe(true);
  });

  it("never steals a tab on an update or on a reason it does not know", () => {
    expect(shouldOpenWelcome("update", 0)).toBe(false);
    expect(shouldOpenWelcome("chrome_update", 0)).toBe(false);
    expect(shouldOpenWelcome("shared_module_update", 0)).toBe(false);
  });

  it("does not show it twice for the same onboarding version", () => {
    expect(shouldOpenWelcome("install", ONBOARDING_VERSION)).toBe(false);
    expect(shouldOpenWelcome("install", ONBOARDING_VERSION + 1)).toBe(false);
  });

  it("shows it again once the onboarding version moves past what was seen", () => {
    expect(shouldOpenWelcome("install", ONBOARDING_VERSION - 1)).toBe(true);
  });

  it("treats an unreadable stored version as never shown", () => {
    expect(shouldOpenWelcome("install", Number.NaN)).toBe(true);
  });
});

describe("onboarding settings", () => {
  it("starts a fresh profile at zero and repairs a corrupt value", () => {
    expect(DEFAULT_SETTINGS.onboardingSeenVersion).toBe(0);
    expect(normalizeSettings({ onboardingSeenVersion: "yes" }).onboardingSeenVersion).toBe(0);
    expect(normalizeSettings({ onboardingSeenVersion: -3 }).onboardingSeenVersion).toBe(0);
    expect(normalizeSettings({ onboardingSeenVersion: 1.5 }).onboardingSeenVersion).toBe(0);
    expect(normalizeSettings({ onboardingSeenVersion: 2 }).onboardingSeenVersion).toBe(2);
  });

  it("keeps the welcome page inside the extension", () => {
    expect(WELCOME_PATH).toBe("welcome.html");
  });
});

describe("summarizeProfile", () => {
  it("describes the bundled profile without claiming it is personal", () => {
    const summary = summarizeProfile();
    expect(summary.personal).toBe(false);
    expect(summary.id).toMatch(/^claude-code-/);
    expect(summary.groups).toBeGreaterThan(10);
    expect(summary.calls).toMatch(/^\d{1,3}(,\d{3})*$/);
    expect(summary.fittedOn).not.toBe("an unrecorded date");
  });

  it("survives a profile with an unparseable timestamp", () => {
    const summary = summarizeProfile({
      id: "test",
      generatedAt: "not a date",
      scope: "test scope",
      eligibleObservations: 1_234,
      groups: { overall: { sampleSize: 1_234, p50: 1, p90: 2, p99: 3 } },
    });
    expect(summary.fittedOn).toBe("an unrecorded date");
    expect(summary.calls).toBe("1,234");
  });
});

describe("profileProvenanceLines", () => {
  it("says the bundled numbers are a prior, not a measurement of this user", () => {
    const [first, second] = profileProvenanceLines(summarizeProfile());
    expect(first).toContain("bundled profile");
    expect(second).toContain("not as a measurement of how you personally write");
  });

  it("changes both lines once a personal profile exists", () => {
    const [first, second] = profileProvenanceLines({
      ...summarizeProfile(),
      personal: true,
    });
    expect(first).toContain("this machine's own Claude Code history");
    expect(second).toContain("fall back to the bundled profile");
  });
});

describe("the pages the onboarding wires together", () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("gives the welcome script every element it looks up", () => {
    const html = read("../src/welcome/welcome.html");
    for (const id of [
      "showInChat",
      "transcriptGaugeEnabled",
      "openOptions",
      "saved",
      "provenance",
      "provenanceCaveat",
      "profileId",
      "diagnosticsConsent",
      "researchConsent",
      "telemetryStatus",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('src="welcome.js"');
    // The stylesheet is shared, so a copy step that forgets it breaks nothing
    // else and would be easy to miss.
    expect(html).toContain('href="options.css"');
    expect(html).toContain('href="privacy.html"');
    expect(html).not.toContain("only while the panel is open");
  });

  it("keeps the same provenance elements on the settings page", () => {
    const html = read("../src/options/options.html");
    for (const id of ["provenance", "provenanceCaveat", "profileId"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('href="welcome.html"');
  });

  it("ships the privacy notice linked by both consent surfaces", () => {
    const privacy = read("../src/privacy/privacy.html");
    const options = read("../src/options/options.html");
    const welcome = read("../src/welcome/welcome.html");
    expect(privacy).toContain("Forecast research");
    expect(options).toContain('href="privacy.html"');
    expect(welcome).toContain('href="privacy.html"');
  });
});

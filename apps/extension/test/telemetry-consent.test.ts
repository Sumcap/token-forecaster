import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../src/lib/settings.js";

const stored: Record<string, unknown> = {};
const requestPermission = vi.fn(async () => true);
const containsPermission = vi.fn(async () => false);
const sendMessage = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(stored)) delete stored[key];
  requestPermission.mockClear();
  containsPermission.mockClear();
  sendMessage.mockClear();
  vi.stubGlobal("__TF_TELEMETRY_ORIGIN__", "https://telemetry.example.test");
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (items: Record<string, unknown>) => Object.assign(stored, items),
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
    permissions: {
      contains: containsPermission,
      request: requestPermission,
      remove: async () => true,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("telemetry consent", () => {
  it("requests only the configured collector host and persists affirmative consent", async () => {
    const { setTelemetryConsent } = await import("../src/lib/telemetry-consent.js");
    const result = await setTelemetryConsent("research", true);
    expect(result).toEqual({ ok: true, state: "granted" });
    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["https://telemetry.example.test/*"],
    });
    expect((stored[SETTINGS_KEY] as Record<string, unknown>).researchConsent).toBe("granted");
    expect((stored[SETTINGS_KEY] as Record<string, unknown>).diagnosticsConsent).toBe("unset");
    expect(sendMessage).toHaveBeenCalledWith({ type: "tf/flush-telemetry" });
  });

  it("records denial without asking for host access", async () => {
    const { setTelemetryConsent } = await import("../src/lib/telemetry-consent.js");
    const result = await setTelemetryConsent("diagnostics", false);
    expect(result).toEqual({ ok: true, state: "denied" });
    expect(requestPermission).not.toHaveBeenCalled();
    expect((stored[SETTINGS_KEY] as Record<string, unknown>).diagnosticsConsent).toBe("denied");
  });
});

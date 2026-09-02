import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../src/lib/settings.js";

/**
 * End-to-end wiring test for the content script, with a stub `chrome`.
 *
 * It covers what the unit tests cannot: that typing in the composer actually
 * reaches the engine and moves the pill, and that nothing is sent anywhere
 * while verified counting is off.
 */
const stored: Record<string, unknown> = {};
const sendMessage = vi.fn(async () => ({ ok: false, error: "no worker in this test" }));

const PAGE = `
  <div data-testid="assistant-message"><p>A previous reply.</p></div>
  <fieldset>
    <div data-testid="chat-input-container">
      <div class="ProseMirror" contenteditable="true"><p></p></div>
      <button data-testid="model-selector-dropdown">
        <span>Opus 5</span><span>High</span>
      </button>
    </div>
  </fieldset>
`;

function shadowText(selector: string): string {
  const host = document.getElementById("token-forecaster-chip-host");
  return host?.shadowRoot?.querySelector(selector)?.textContent ?? "";
}

function type(text: string): void {
  const composer = document.querySelector<HTMLElement>(".ProseMirror")!;
  composer.innerHTML = `<p>${text}</p>`;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 300)) as Promise<void>;

beforeAll(async () => {
  // The chip only renders on the Claude Code surface by default.
  vi.stubGlobal("location", { ...window.location, pathname: "/code/session-1" });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      sendMessage,
      openOptionsPage: async () => undefined,
      onMessage: { addListener: () => undefined },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        },
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
    permissions: {
      contains: async () => false,
      request: async () => false,
    },
  });
  document.body.innerHTML = PAGE;
  await import("../src/content/index.js");
  await settle();
});

afterAll(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});

describe("content script", () => {
  it("mounts a chip once the composer is found", () => {
    expect(document.getElementById("token-forecaster-chip-host")).not.toBeNull();
    expect(shadowText(".pill")).toContain("Token Forecaster");
  });

  it("moves the pill when the user types", async () => {
    type("Write a short summary of the forecaster.");
    await settle();
    expect(shadowText(".pill")).toMatch(/\d+ in · ~[\d.k]+–[\d.k]+ out/);
  });

  it("grows the input count with the draft", async () => {
    type("short");
    await settle();
    const small = Number(/^(\d+) in/.exec(shadowText(".pill"))?.[1] ?? "0");
    type("a much longer draft ".repeat(40));
    await settle();
    const large = Number(/^(\d+) in/.exec(shadowText(".pill"))?.[1] ?? "0");
    expect(large).toBeGreaterThan(small);
  });

  it("reads the model from the page, and keeps the page's effort word visible", async () => {
    const host = document.getElementById("token-forecaster-chip-host")!;
    host.shadowRoot!.querySelector<HTMLButtonElement>(".pill")!.click();
    type("what model is this?");
    await settle();
    const panel = shadowText(".panel");
    expect(panel).toContain("Claude Opus 5");
    // Thinking ships on, which is an override, so the panel names the setting
    // and still reports what the page shows rather than hiding it.
    expect(panel).toContain("thinking on (your setting, the page shows High)");
  });

  it("draws the forecast band", async () => {
    type("draw me a band please");
    await settle();
    const host = document.getElementById("token-forecaster-chip-host")!;
    const segments = host.shadowRoot!.querySelectorAll(".band-seg");
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it("hides itself on the chat surface, which the profile does not describe", async () => {
    const host = document.getElementById("token-forecaster-chip-host") as HTMLElement;
    expect(host.style.display).toBe("block");
    vi.stubGlobal("location", { ...window.location, pathname: "/chat/abc" });
    type("still typing");
    await settle();
    expect(host.style.display).toBe("none");
    vi.stubGlobal("location", { ...window.location, pathname: "/code/session-1" });
    type("back on code");
    await settle();
    expect(host.style.display).toBe("block");
  });

  it("sends nothing anywhere while verified counting is off", () => {
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns to the empty state when the composer is cleared", async () => {
    type("");
    await settle();
    expect(shadowText(".pill")).toContain("Token Forecaster");
  });

  it("stores nothing until a setting is changed", () => {
    expect(stored[SETTINGS_KEY]).toBeUndefined();
  });
});

describe("content script, following a reply", () => {
  const composer = (): HTMLElement => document.querySelector<HTMLElement>(".ProseMirror")!;

  const send = (): void => {
    composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    type("");
  };

  const startGenerating = (): void => {
    const stop = document.createElement("button");
    stop.setAttribute("data-testid", "stop-button");
    stop.id = "stop";
    document.body.append(stop);
  };

  const stream = (text: string): void => {
    let node = document.getElementById("streaming");
    if (node === null) {
      node = document.createElement("div");
      node.id = "streaming";
      node.setAttribute("data-testid", "assistant-message");
      document.body.append(node);
    }
    node.textContent = text;
  };

  const badges = (): HTMLElement[] => {
    const host = document.getElementById("token-forecaster-verdicts-host");
    return [...(host?.shadowRoot?.querySelectorAll<HTMLElement>(".badge") ?? [])];
  };

  it("switches the pill to the running turn, then scores it", async () => {
    type("write me a short report about the forecaster");
    await settle();
    expect(shadowText(".pill")).toContain(" in · ");

    send();
    startGenerating();
    stream("The report begins here. ".repeat(40));
    await settle();

    // The turn is in flight: the pill now reads what is being written.
    expect(shadowText(".pill")).toContain("out ·");
    const pill = document.getElementById("token-forecaster-chip-host")!
      .shadowRoot!.querySelector(".pill")!;
    expect(pill.className).toContain("live");

    document.getElementById("stop")!.remove();
    // Past the quiet window, so the turn settles and gets a score.
    await new Promise((resolve) => setTimeout(resolve, 1_800));

    expect(badges()).toHaveLength(1);
    expect(badges()[0]!.textContent).toContain("written");
    // And the panel gains the conversation's running score.
    const host = document.getElementById("token-forecaster-chip-host")!;
    host.shadowRoot!.querySelector<HTMLButtonElement>(".pill")!.click();
    await settle();
    expect(shadowText(".panel")).toContain("FORECAST SO FAR");
  }, 10_000);
});

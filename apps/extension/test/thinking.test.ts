import { describe, expect, it } from "vitest";
import { mapEffortToThinking, resolveThinking } from "../src/lib/thinking.js";
import { findAssistantMessages, findEffortLabel, findThinkingEvidence } from "../src/content/extract.js";

describe("mapEffortToThinking", () => {
  it("reads an effort level as thinking on", () => {
    for (const word of ["Low", "Medium", "High", "Max", "Extended"]) {
      expect(mapEffortToThinking(word)).toBe(true);
    }
  });

  it("reads the off states as thinking off", () => {
    for (const word of ["Off", "None", "Standard", "Instant"]) {
      expect(mapEffortToThinking(word)).toBe(false);
    }
  });

  it("returns null for a level it has never seen", () => {
    expect(mapEffortToThinking("Turbo")).toBeNull();
    expect(mapEffortToThinking("")).toBeNull();
  });
});

describe("resolveThinking", () => {
  it("prefers an explicit override", () => {
    expect(resolveThinking("off", { pageLabel: "High", transcript: true })).toEqual({
      enabled: false,
      source: "override",
      pageLabel: "High",
    });
  });

  it("reads the effort control when set to auto", () => {
    expect(resolveThinking("auto", { pageLabel: "High", transcript: false })).toEqual({
      enabled: true,
      source: "page",
      pageLabel: "High",
    });
  });

  it("falls back to the last reply when the control cannot be read", () => {
    expect(resolveThinking("auto", { pageLabel: null, transcript: true })).toEqual({
      enabled: true,
      source: "transcript",
      pageLabel: null,
    });
    expect(resolveThinking("auto", { pageLabel: "Turbo", transcript: false })).toEqual({
      enabled: false,
      source: "transcript",
      pageLabel: "Turbo",
    });
  });

  it("assumes thinking is on when nothing on the page says", () => {
    expect(resolveThinking("auto", { pageLabel: null, transcript: null })).toEqual({
      enabled: true,
      source: "assumed",
      pageLabel: null,
    });
    expect(resolveThinking("auto").source).toBe("assumed");
    expect(resolveThinking("auto", { pageLabel: "Turbo", transcript: null }).enabled).toBe(true);
  });
});

describe("findEffortLabel", () => {
  it("reads the level out of the model selector, not the model name", () => {
    document.body.innerHTML = `
      <button data-testid="model-selector-dropdown">
        <span>Opus 5</span><span>High</span>
      </button>
    `;
    expect(findEffortLabel(document)).toBe("High");
  });

  it("never mistakes a model name for an effort level", () => {
    document.body.innerHTML = `
      <button data-testid="model-selector-dropdown">Claude Sonnet 4.6</button>
    `;
    expect(findEffortLabel(document)).toBeNull();
  });

  it("prefers a dedicated control when the page has one", () => {
    document.body.innerHTML = `
      <div data-testid="thinking-toggle">Thinking: Max</div>
      <button data-testid="model-selector-dropdown">Opus 5 High</button>
    `;
    expect(findEffortLabel(document)).toBe("Max");
  });

  it("falls back to a small standalone button", () => {
    document.body.innerHTML = `<button>Extended</button><button>New chat</button>`;
    expect(findEffortLabel(document)).toBe("Extended");
  });

  it("returns null when the page shows no level", () => {
    document.body.innerHTML = `<button>New chat</button>`;
    expect(findEffortLabel(document)).toBeNull();
  });
});

describe("findThinkingEvidence", () => {
  it("reads a thinking block in the newest reply", () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message">plain answer</div>
      <div data-testid="assistant-message">
        <button>Thought process</button><p>answer</p>
      </div>
    `;
    expect(findThinkingEvidence(document)).toBe(true);
  });

  it("recognizes the collapsed and the timed headers", () => {
    for (const header of ["Show thinking", "Hide thinking", "Thinking\u2026", "Thought for 8s"]) {
      document.body.innerHTML = `
        <div data-testid="assistant-message"><summary>${header}</summary></div>
      `;
      expect(findThinkingEvidence(document)).toBe(true);
    }
  });

  it("recognizes the block by test id", () => {
    document.body.innerHTML = `
      <div class="font-claude-message"><div data-testid="thinking-block">…</div></div>
    `;
    expect(findThinkingEvidence(document)).toBe(true);
  });

  it("reads thinking off when the newest reply has no block", () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message"><button>Thought process</button></div>
      <div data-testid="assistant-message"><p>answer</p><button>Copy</button></div>
    `;
    expect(findThinkingEvidence(document)).toBe(false);
  });

  it("stays null when there is no reply to read", () => {
    document.body.innerHTML = `<div data-testid="user-message">hello</div>`;
    expect(findThinkingEvidence(document)).toBeNull();
  });

  it("lists replies newest last", () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message">first</div>
      <div data-testid="assistant-message">second</div>
    `;
    expect(findAssistantMessages(document).at(-1)?.textContent).toBe("second");
  });
});

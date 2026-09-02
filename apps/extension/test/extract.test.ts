import { beforeEach, describe, expect, it } from "vitest";
import {
  countAssistantMessages,
  findAssistantMessages,
  findComposer,
  isGenerating,
  tokensOfMessages,
  findModelLabel,
  hasImageAttachment,
  readTranscript,
  textFromEditable,
} from "../src/content/extract.js";

/** A stripped-down copy of the shapes claude.ai renders around the composer. */
const PAGE = `
  <div id="transcript">
    <div data-testid="user-message"><p>What does the forecaster do?</p></div>
    <div data-testid="assistant-message">
      <p>It forecasts output length.</p>
      <p>It also counts the input.</p>
    </div>
    <div data-testid="user-message"><p>And the turn total?</p></div>
    <div data-testid="assistant-message"><p>That is a different question.</p></div>
  </div>
  <fieldset>
    <div data-testid="chat-input-container">
      <div class="ProseMirror" contenteditable="true">
        <p>First line</p>
        <p>Second line</p>
      </div>
      <button data-testid="model-selector-dropdown">Claude Sonnet 4.6</button>
    </div>
  </fieldset>
`;

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

describe("textFromEditable", () => {
  it("turns paragraphs into newlines", () => {
    const composer = findComposer(document);
    expect(composer).not.toBeNull();
    expect(textFromEditable(composer!)).toBe("First line\nSecond line");
  });

  it("turns a line break into a newline", () => {
    document.body.innerHTML = `<div contenteditable="true"><p>a<br>b</p></div>`;
    expect(textFromEditable(findComposer(document)!)).toBe("a\nb");
  });

  it("drops the ProseMirror empty-paragraph placeholder", () => {
    document.body.innerHTML = `<div contenteditable="true"><p>​</p></div>`;
    expect(textFromEditable(findComposer(document)!)).toBe("");
  });
});

describe("findComposer", () => {
  it("prefers the ProseMirror editor", () => {
    expect(findComposer(document)?.className).toBe("ProseMirror");
  });

  it("falls back when the ProseMirror class is gone", () => {
    document.body.innerHTML = `
      <div data-testid="chat-input"><div contenteditable="true">hi</div></div>
    `;
    expect(findComposer(document)?.textContent).toBe("hi");
  });

  it("falls back again to any editable box", () => {
    document.body.innerHTML = `<article><div contenteditable="true">only one</div></article>`;
    expect(findComposer(document)?.textContent).toBe("only one");
  });

  it("returns null when the page has no composer", () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    expect(findComposer(document)).toBeNull();
  });
});

describe("findModelLabel", () => {
  it("reads the picker", () => {
    expect(findModelLabel(document)).toBe("Claude Sonnet 4.6");
  });

  it("falls back to a button that names a model family", () => {
    document.body.innerHTML = `
      <button>New chat</button>
      <button>Opus 5</button>
    `;
    expect(findModelLabel(document)).toBe("Opus 5");
  });

  it("returns null rather than guessing", () => {
    document.body.innerHTML = `<button>New chat</button>`;
    expect(findModelLabel(document)).toBeNull();
  });
});

describe("hasImageAttachment", () => {
  it("is false for a composer with no attachment", () => {
    expect(hasImageAttachment(document)).toBe(false);
  });

  it("is true for a thumbnail in the composer", () => {
    document.querySelector('[data-testid="chat-input-container"]')!.insertAdjacentHTML(
      "beforeend",
      `<div data-testid="file-thumbnail"></div>`,
    );
    expect(hasImageAttachment(document)).toBe(true);
  });

  it("ignores images outside the composer", () => {
    document.querySelector("#transcript")!.insertAdjacentHTML(
      "beforeend",
      `<img src="blob:whatever" />`,
    );
    expect(hasImageAttachment(document)).toBe(false);
  });
});

describe("readTranscript", () => {
  it("counts every visible message once", () => {
    const reading = readTranscript(document);
    expect(reading.messages).toBe(4);
    expect(reading.assistantMessages).toBe(2);
    expect(reading.tokens).toBeGreaterThan(0);
  });

  it("does not double count a message nested in another match", () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message">
        <div class="font-claude-message">Same text, two selectors.</div>
      </div>
    `;
    const nested = readTranscript(document);
    expect(nested.assistantMessages).toBe(1);
  });

  it("reports nothing readable as zero messages, not zero tokens of context", () => {
    document.body.innerHTML = `<div>no messages</div>`;
    expect(readTranscript(document).messages).toBe(0);
  });
});

describe("countAssistantMessages", () => {
  it("is the zero-based session position of the next request", () => {
    expect(countAssistantMessages(document)).toBe(2);
  });

  it("falls back to the class name when the test ids are gone", () => {
    document.body.innerHTML = `
      <div class="font-claude-message">one</div>
      <div class="font-claude-message">two</div>
      <div class="font-claude-message">three</div>
    `;
    expect(countAssistantMessages(document)).toBe(3);
  });
});

describe("isGenerating", () => {
  it("reads claude.ai's own streaming flag first", () => {
    document.body.innerHTML = `<div data-is-streaming="true"></div>`;
    expect(isGenerating(document)).toBe(true);
    document.body.innerHTML = `<div data-is-streaming="false"></div>`;
    expect(isGenerating(document)).toBe(false);
  });

  it("falls back to the stop control that replaces the send button", () => {
    document.body.innerHTML = `<button data-testid="stop-button">Stop</button>`;
    expect(isGenerating(document)).toBe(true);
    document.body.innerHTML = `<button aria-label="Stop response">x</button>`;
    expect(isGenerating(document)).toBe(true);
  });

  it("says no on a page that is simply sitting there", () => {
    document.body.innerHTML = `<button aria-label="Send message">Send</button>`;
    expect(isGenerating(document)).toBe(false);
  });
});

describe("tokensOfMessages", () => {
  it("estimates the rendered text and nothing else", () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message">${"a reply with words ".repeat(20)}</div>
      <div data-testid="assistant-message">short</div>
    `;
    const messages = findAssistantMessages(document);
    expect(tokensOfMessages(messages)).toBeGreaterThan(tokensOfMessages(messages.slice(1)));
    expect(tokensOfMessages([])).toBe(0);
  });
});

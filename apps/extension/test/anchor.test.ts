import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchComposer } from "../src/content/anchor.js";

function composerHtml(id: string): string {
  return `<div class="ProseMirror" contenteditable="true" data-id="${id}"><p></p></div>`;
}

let stop: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = composerHtml("first");
});

afterEach(() => {
  stop?.();
  stop = null;
});

// Real timers: happy-dom delivers mutation records on its own scheduler, and
// the debounce is short enough that waiting is cheaper than faking it.
const DEBOUNCE_MS = 5;

/** Let the MutationObserver deliver, then let the debounce fire. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 8));
}

describe("watchComposer", () => {
  it("reports the composer immediately", () => {
    const seen: Array<string | null> = [];
    const watcher = watchComposer((element) => seen.push(element?.dataset["id"] ?? null), {
      debounceMs: DEBOUNCE_MS,
      pollMs: 10_000,
    });
    stop = watcher.stop;
    expect(seen).toEqual(["first"]);
  });

  it("re-anchors when React swaps the composer node", async () => {
    const seen: Array<string | null> = [];
    const watcher = watchComposer((element) => seen.push(element?.dataset["id"] ?? null), {
      debounceMs: DEBOUNCE_MS,
      pollMs: 10_000,
    });
    stop = watcher.stop;

    document.body.innerHTML = composerHtml("second");
    await settle();

    expect(seen).toEqual(["first", "second"]);
  });

  it("reports null when the composer goes away, and again when it returns", async () => {
    const seen: Array<string | null> = [];
    const watcher = watchComposer((element) => seen.push(element?.dataset["id"] ?? null), {
      debounceMs: DEBOUNCE_MS,
      pollMs: 10_000,
    });
    stop = watcher.stop;

    document.body.innerHTML = `<div>a page with no composer</div>`;
    await settle();
    document.body.innerHTML = composerHtml("third");
    await settle();

    expect(seen).toEqual(["first", null, "third"]);
  });

  it("does not re-report an unchanged composer", async () => {
    const seen: Array<string | null> = [];
    const watcher = watchComposer((element) => seen.push(element?.dataset["id"] ?? null), {
      debounceMs: DEBOUNCE_MS,
      pollMs: 10_000,
    });
    stop = watcher.stop;

    document.body.insertAdjacentHTML("beforeend", "<div>unrelated churn</div>");
    await settle();

    expect(seen).toEqual(["first"]);
  });

  it("stops observing after stop()", async () => {
    const seen: Array<string | null> = [];
    const watcher = watchComposer((element) => seen.push(element?.dataset["id"] ?? null), {
      debounceMs: DEBOUNCE_MS,
      pollMs: 10_000,
    });
    watcher.stop();
    stop = null;

    document.body.innerHTML = composerHtml("fourth");
    await settle();

    expect(seen).toEqual(["first"]);
  });
});

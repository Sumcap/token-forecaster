import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnTracker } from "../src/content/turn-tracker.js";
import type { ForecastSnapshot } from "../src/lib/turn.js";

const SNAPSHOT: ForecastSnapshot = {
  call: { p50: 300, p90: 1_200, p99: 4_000 },
  turn: { p50: 400, p90: 1_500, p99: 4_000 },
  callTuned: false,
  turnTuned: false,
  modelId: "claude-opus-5",
  modelName: "Claude Opus 5",
  maxOutputTokens: 64_000,
  thinkingEnabled: true,
  pooled: false,
  sampleSize: 1_200,
  profileScope: "claude-code",
  surface: "code",
};

let clock = 0;
let changes = 0;

function tracker(): TurnTracker {
  return new TurnTracker(() => {
    changes += 1;
  }, {
    quietMs: 1_000,
    armTimeoutMs: 5_000,
    now: () => clock,
    lastSnapshot: () => SNAPSHOT,
  });
}

/** Append an assistant reply, as claude.ai does when a turn starts. */
function reply(text: string): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-testid", "assistant-message");
  node.textContent = text;
  document.body.append(node);
  return node;
}

function startGenerating(): void {
  const stop = document.createElement("button");
  stop.setAttribute("data-testid", "stop-button");
  stop.id = "stop";
  document.body.append(stop);
}

function stopGenerating(): void {
  document.getElementById("stop")?.remove();
}

beforeEach(() => {
  document.body.innerHTML = "";
  clock = 1_000;
  changes = 0;
});

describe("TurnTracker", () => {
  it("measures only what appeared after the send", () => {
    reply("a long previous reply ".repeat(50));
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    turns.tick();
    reply("the new answer ".repeat(20));
    turns.tick();
    const live = turns.live();
    expect(live).not.toBeNull();
    expect(live!.outTokens).toBeGreaterThan(0);
    // The previous reply is four times longer; if it were counted the estimate
    // would be far higher than the new text alone.
    expect(live!.outTokens).toBeLessThan(120);
  });

  it("scores the turn once the reply stops growing", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    turns.tick();
    reply("hello ".repeat(30));
    turns.tick();
    stopGenerating();
    clock += 2_000;
    turns.tick();

    expect(turns.live()).toBeNull();
    const ledger = turns.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.band).toBe("under-p50");
    expect(ledger[0]!.abandoned).toBe(false);
    // The scale is the frozen one, not whatever the engine would say now.
    expect(ledger[0]!.scale.quantiles).toEqual(SNAPSHOT.turn);
    expect(turns.settled()).toHaveLength(1);
  });

  it("keeps the forecast frozen while the reply grows", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    reply("x");
    turns.tick();
    const first = turns.live()!.snapshot;
    reply("y ".repeat(500));
    turns.tick();
    expect(turns.live()!.snapshot).toBe(first);
  });

  it("does not settle during a pause in the stream", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    reply("thinking...");
    turns.tick();
    clock += 30_000;
    turns.tick();
    expect(turns.live()).not.toBeNull();
    expect(turns.ledger()).toHaveLength(0);
  });

  it("does not score a turn that wrote nothing", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    turns.tick();
    stopGenerating();
    clock += 2_000;
    turns.tick();
    const ledger = turns.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.abandoned).toBe(true);
    expect(ledger[0]!.band).toBeNull();
  });

  it("forgets an arm that never became a reply", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    clock += 10_000;
    turns.tick();
    expect(turns.isBusy()).toBe(false);
    expect(turns.ledger()).toHaveLength(0);
  });

  it("picks a reply up when the send itself was missed", () => {
    reply("an older reply");
    const turns = tracker();
    startGenerating();
    reply("the reply nobody armed ".repeat(10));
    turns.tick();
    const live = turns.live();
    expect(live).not.toBeNull();
    expect(live!.outTokens).toBeGreaterThan(0);
    expect(turns.liveElement()?.textContent).toContain("nobody armed");
  });

  it("never reports the reply shrinking", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    const node = reply("a full paragraph of streamed text ".repeat(20));
    turns.tick();
    const peak = turns.live()!.outTokens;
    // Collapsing a thinking block removes rendered text without unwriting it.
    node.textContent = "short";
    turns.tick();
    expect(turns.live()!.outTokens).toBe(peak);
  });

  it("drops the ledger when the conversation changes", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    reply("hello ".repeat(30));
    turns.tick();
    stopGenerating();
    clock += 2_000;
    turns.tick();
    expect(turns.ledger()).toHaveLength(1);
    turns.setConversation("/code/other");
    expect(turns.ledger()).toHaveLength(0);
    expect(turns.live()).toBeNull();
  });

  it("drops a settled turn whose message left the page", () => {
    const turns = tracker();
    turns.arm(SNAPSHOT);
    startGenerating();
    const node = reply("hello ".repeat(30));
    turns.tick();
    stopGenerating();
    clock += 2_000;
    turns.tick();
    expect(turns.settled()).toHaveLength(1);
    node.remove();
    expect(turns.settled()).toHaveLength(0);
    // The ledger still counts it: the score happened, the message just scrolled
    // out of the DOM.
    expect(turns.ledger()).toHaveLength(1);
  });

  it("tells the caller when there is something new to draw", () => {
    const turns = tracker();
    changes = 0;
    turns.arm(SNAPSHOT);
    expect(changes).toBe(1);
    startGenerating();
    reply("hello");
    turns.tick();
    expect(changes).toBeGreaterThan(1);
  });

  it("does nothing at all while the page is quiet", () => {
    const turns = tracker();
    const spy = vi.spyOn(document, "querySelectorAll");
    turns.tick();
    turns.tick();
    expect(turns.isBusy()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

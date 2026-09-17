import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CountReconciler, debounced, type VerificationTicket } from "./reconciler.js";

interface FixtureStep {
  op: "input" | "start" | "resolve" | "fail" | "expect";
  ticket?: string;
  localTokens?: number;
  tokens?: number;
  quality?: string;
  pendingVerification?: boolean;
  expectApplied?: boolean;
  expectRelevant?: boolean;
}

interface Fixture {
  description: string;
  scenarios: Array<{ name: string; steps: FixtureStep[] }>;
}

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/count-race-conditions.json", import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("CountReconciler race-condition fixtures", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, () => {
      const reconciler = new CountReconciler();
      const tickets = new Map<string, VerificationTicket>();

      for (const step of scenario.steps) {
        switch (step.op) {
          case "input":
            reconciler.noteInputChanged(step.localTokens!);
            break;
          case "start":
            tickets.set(step.ticket!, reconciler.startVerification());
            break;
          case "resolve": {
            const result = reconciler.resolveVerification(
              tickets.get(step.ticket!)!,
              step.tokens!,
            );
            if (step.expectApplied) {
              expect(result, `resolve ${step.ticket} should apply`).not.toBeNull();
            } else {
              expect(result, `resolve ${step.ticket} should be discarded`).toBeNull();
            }
            break;
          }
          case "fail": {
            const relevant = reconciler.failVerification(tickets.get(step.ticket!)!);
            expect(relevant).toBe(step.expectRelevant);
            break;
          }
          case "expect":
            expect(reconciler.current).toEqual({
              tokens: step.tokens,
              quality: step.quality,
              pendingVerification: step.pendingVerification,
            });
            break;
        }
      }
    });
  }
});

describe("debounced", () => {
  it("fires once after the delay, with the last arguments", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const d = debounced(spy, 500);
    d.call(1);
    d.call(2);
    vi.advanceTimersByTime(499);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
    vi.useRealTimers();
  });

  it("cancel drops the pending invocation", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const d = debounced(spy, 500);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

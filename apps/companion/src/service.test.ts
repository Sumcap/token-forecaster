import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersonalStore } from "@token-forecaster/personal";
import { afterEach, describe, expect, it } from "vitest";

import { CompanionService, treeFingerprint } from "./service.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A service pointed at two empty, real directories under a temp root. */
function harness(): { service: CompanionService; claudeDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "tf-service-"));
  const store = PersonalStore.open(dataDir);
  const service = new CompanionService(store);
  const claudeDir = join(dataDir, "claude");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(dataDir, "codex"), { recursive: true });
  service.setDirectories({ codexDir: join(dataDir, "codex"), claudeDir });
  cleanup.push(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, claudeDir };
}

/** A transcript row the Claude importer will read but not keep. */
function writeTranscript(dir: string, name: string, body: string): void {
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, name), `${body}\n`);
}

describe("treeFingerprint", () => {
  it("is stable while nothing changes and moves when a transcript does", () => {
    const { claudeDir } = harness();
    writeTranscript(claudeDir, "a.jsonl", "{}");
    const first = treeFingerprint(claudeDir);
    expect(treeFingerprint(claudeDir)).toBe(first);

    writeTranscript(claudeDir, "a.jsonl", "{}\n{}");
    expect(treeFingerprint(claudeDir)).not.toBe(first);
  });

  it("survives a missing directory", () => {
    expect(treeFingerprint(join(tmpdir(), "tf-does-not-exist"))).toHaveLength(32);
  });
});

describe("index", () => {
  it("re-reads a source only when its transcripts changed", async () => {
    const { service, claudeDir } = harness();
    writeTranscript(claudeDir, "a.jsonl", "{}");

    const first = await service.index();
    expect(first.skipped).toBe(false);
    if (first.skipped) return;
    expect(first.scanned).toContain("anthropic");

    // Nothing touched the tree: the importer must not run at all. This is the
    // whole point — the daemon's watcher fires constantly while an agent works.
    const second = await service.index();
    if (second.skipped) throw new Error("unexpected concurrent run");
    expect(second.scanned).toEqual([]);
    expect(second.stats["anthropic"]?.schemaVariants["source_unchanged"]).toBe(1);

    writeTranscript(claudeDir, "b.jsonl", "{}");
    const third = await service.index();
    if (third.skipped) throw new Error("unexpected concurrent run");
    expect(third.scanned).toContain("anthropic");
  });

  it("reads regardless when the caller forces it", async () => {
    const { service, claudeDir } = harness();
    writeTranscript(claudeDir, "a.jsonl", "{}");
    await service.index();

    const forced = await service.index({ force: true });
    if (forced.skipped) throw new Error("unexpected concurrent run");
    expect(forced.scanned).toContain("anthropic");
  });

  it("tells a missing source apart from an unchanged one", async () => {
    const { service } = harness();
    service.setDirectories({ claudeDir: join(tmpdir(), "tf-not-here") });
    const result = await service.index();
    if (result.skipped) throw new Error("unexpected concurrent run");
    expect(result.stats["anthropic"]?.schemaVariants["source_unavailable"]).toBe(1);
  });
});

describe("live turns across several terminals", () => {
  const report = (sessionId: string, over: Record<string, unknown> = {}) => ({
    sessionId,
    provider: "anthropic" as const,
    outputTokens: 1_200,
    calls: 3,
    p50: 2_000,
    p90: 9_000,
    usedFallback: false,
    ...over,
  });

  it("does not light up a session that is merely open", () => {
    const { service } = harness();
    // Every terminal's status line posts on the same timer, finished or not.
    service.recordLiveTurn(report("idle-terminal", { inFlight: false }));
    expect(service.liveTurn()).toBeNull();
  });

  it("shows the terminal that is actually working, and counts only it", () => {
    const { service } = harness();
    service.recordLiveTurn(report("idle-a", { inFlight: false }));
    service.recordLiveTurn(report("idle-b", { inFlight: false, outputTokens: 800 }));
    service.recordLiveTurn(report("busy", { inFlight: true, outputTokens: 300, label: "work" }));

    const live = service.liveTurn();
    expect(live?.state).toBe("in_flight");
    expect(live?.label).toBe("work");
    // "1 of 3 active chats" was the bug: two of those three were idle.
    expect(live?.sessions).toBe(1);
  });

  it("keeps a turn on screen while it grows and lets it go when it ends", () => {
    const { service } = harness();
    service.recordLiveTurn(report("busy", { inFlight: true, outputTokens: 300 }));
    service.recordLiveTurn(report("busy", { inFlight: true, outputTokens: 900 }));
    expect(service.liveTurn()?.state).toBe("in_flight");

    // The turn ends; the same numbers keep arriving every second.
    service.recordLiveTurn(report("busy", { inFlight: false, outputTokens: 900 }));
    const after = service.liveTurn();
    expect(after?.state).not.toBe("in_flight");
  });

  it("still works for a reporter that sends no in-flight flag", () => {
    const { service } = harness();
    service.recordLiveTurn(report("old-reporter", { outputTokens: 300 }));
    expect(service.liveTurn()?.state).toBe("in_flight");
  });
});

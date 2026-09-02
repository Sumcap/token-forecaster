import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersonalStore } from "@token-forecaster/personal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SECTIONS } from "./dashboard.js";
import { runtimeFilePath, startServer, type RunningServer } from "./server.js";
import { CompanionService } from "./service.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function harness(): Promise<{
  server: RunningServer;
  dataDir: string;
  service: CompanionService;
  call: (
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown },
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "tf-companion-"));
  const store = PersonalStore.open(dataDir);
  const service = new CompanionService(store);
  // Point the sources at empty directories so no real history is read.
  service.setDirectories({ codexDir: join(dataDir, "codex"), claudeDir: join(dataDir, "claude") });
  const server = await startServer({ service, dataDir, onRebuild: () => {} });
  cleanup.push(() => {
    void server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    options: { token?: string | null; body?: unknown } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const token = options.token === undefined ? server.token : options.token;
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    const json = text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : { text };
    return { status: response.status, json };
  };

  return { server, dataDir, service, call };
}

describe("companion API", () => {
  it("rejects every request without the per-install token", async () => {
    const { call } = await harness();
    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", "/profiles"],
      ["POST", "/forecast"],
      ["POST", "/rebuild"],
      ["POST", "/turn"],
      ["POST", "/reset"],
      ["GET", "/dashboard"],
    ] as const) {
      const response = await call(method, path, { token: null });
      expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 401`);
    }
    const wrong = await call("GET", "/health", { token: "0".repeat(64) });
    expect(wrong.status).toBe(401);
  });

  it("binds loopback only and writes runtime.json readable by the owner alone", async () => {
    const { server, dataDir } = await harness();
    const address = server.server.address();
    expect(typeof address === "object" && address ? address.address : "").toBe("127.0.0.1");

    const path = runtimeFilePath(dataDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const info = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(info["port"]).toBe(server.port);
    expect(info["token"]).toBe(server.token);
    expect(info["pid"]).toBe(process.pid);
  });

  it("sets no CORS header, so a web page cannot read a response", async () => {
    const { server } = await harness();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { authorization: `Bearer ${server.token}`, origin: "https://example.com" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves a cold-start forecast before any history is indexed", async () => {
    const { call } = await harness();
    const response = await call("POST", "/forecast", {
      body: { provider: "anthropic", scale: "call", model: "claude-opus-5" },
    });
    expect(response.status).toBe(200);
    const forecast = response.json["forecast"] as Record<string, unknown>;
    expect(forecast["source"]).toBe("bundled_fallback");
    expect(forecast["usedFallback"]).toBe(true);
    expect(forecast["p50"]).toBeLessThanOrEqual(forecast["p90"] as number);
  });

  it("validates provider and scale", async () => {
    const { call } = await harness();
    expect((await call("POST", "/forecast", { body: { provider: "acme", scale: "call" } })).status).toBe(400);
    expect((await call("POST", "/forecast", { body: { provider: "openai", scale: "epoch" } })).status).toBe(400);
  });

  it("reports both sources as unavailable when the directories do not exist", async () => {
    const { call } = await harness();
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    const sources = health.json["sources"] as Record<string, unknown>[];
    expect(sources.map((s) => s["label"])).toEqual(["Codex", "Claude Code"]);
    expect(sources.every((s) => s["available"] === false)).toBe(true);
    expect((health.json["profile"] as Record<string, unknown>)["sampleCount"]).toBe(0);
  });

  it("toggles pause and persists history directories", async () => {
    const { call, service } = await harness();
    expect((await call("POST", "/pause", { body: { paused: true } })).json["paused"]).toBe(true);
    expect(service.paused).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "tf-codex-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    await call("POST", "/settings", { body: { codexDir: dir } });
    const settings = await call("GET", "/settings");
    expect(settings.json["codexDir"]).toBe(dir);
  });

  it("serves the dashboard and rejects unknown paths under it", async () => {
    const { server } = await harness();
    const response = await fetch(
      `http://127.0.0.1:${server.port}/dashboard?token=${server.token}`,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    // On an empty store a section legitimately has nothing to plot, but then it
    // must say so rather than render a blank card.
    const hasChart = html.includes("<svg");
    const hasEmptyState = html.includes('class="empty"');
    expect(hasChart || hasEmptyState).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Token Forecaster");

    // The dashboard is a single page: the old per-page routes are gone.
    for (const slug of ["nope", "data", "enough"]) {
      const missing = await fetch(
        `http://127.0.0.1:${server.port}/dashboard/${slug}?token=${server.token}`,
      );
      expect(`${slug} -> ${missing.status}`).toBe(`${slug} -> 404`);
    }
  });

  it("exposes the statistics payload as JSON", async () => {
    const { call } = await harness();
    const stats = await call("GET", "/stats");
    expect(stats.status).toBe(200);
    expect(Object.keys(stats.json).sort()).toEqual([
      "evaluation",
      "health",
      "profile",
      "sufficiency",
    ]);
  });

  it("renders a statistics page that contains no prompt text and loads nothing remote", async () => {
    const { server } = await harness();
    const response = await fetch(
      `http://127.0.0.1:${server.port}/dashboard?token=${server.token}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    // Every section must be present and reachable from the rail, even with an
    // empty store.
    for (const { id, title } of SECTIONS) {
      expect(html).toContain(`href="#${id}"`);
      expect(html).toContain(`>${title}</a>`);
      expect(html).toContain(`id="${id}"`);
    }
    // Any link back to the server carries the token, or it 401s.
    expect(html).toContain(`href="/dashboard?token=${server.token}"`);
    expect(html).not.toMatch(/href="\/dashboard(?!\?token=)/);
  });

  it("validates a live turn report", async () => {
    const { call } = await harness();
    expect(
      (await call("POST", "/turn", { body: { provider: "acme", sessionId: "s" } })).status,
    ).toBe(400);
    expect((await call("POST", "/turn", { body: { provider: "anthropic" } })).status).toBe(400);
  });

  it("judges a live turn against P50 and P90 and hides the raw session id", async () => {
    const { call } = await harness();
    const report = async (outputTokens: number) =>
      call("POST", "/turn", {
        body: {
          sessionId: "session-abc",
          provider: "anthropic",
          outputTokens,
          calls: 3,
          p50: 1000,
          p90: 5000,
          usedFallback: false,
        },
      });

    const under = (await report(400)).json["liveTurn"] as Record<string, unknown>;
    expect(under["verdict"]).toBe("under");
    expect(under["state"]).toBe("in_flight");
    expect(under["fill"]).toBeCloseTo(0.2, 5);

    expect(((await report(3000)).json["liveTurn"] as Record<string, unknown>)["verdict"]).toBe(
      "near",
    );
    const over = (await report(9000)).json["liveTurn"] as Record<string, unknown>;
    expect(over["verdict"]).toBe("over");
    expect(over["fill"]).toBe(1);

    // The session id is salted before it is served back out.
    expect(JSON.stringify(over)).not.toContain("session-abc");
    expect(String(over["session"])).toHaveLength(12);

    const health = await call("GET", "/health");
    expect((health.json["liveTurn"] as Record<string, unknown>)["outputTokens"]).toBe(9000);
  });

  it("reports no live turn when nothing has posted one", async () => {
    const { call } = await harness();
    const health = await call("GET", "/health");
    expect(health.json["liveTurn"]).toBeNull();
  });

  it("settles, then drops, a turn that stops growing", async () => {
    const { call, service } = await harness();
    await call("POST", "/turn", {
      body: {
        sessionId: "session-abc",
        provider: "anthropic",
        outputTokens: 2000,
        calls: 1,
        p50: 1000,
        p90: 5000,
      },
    });
    // Only Date is faked, so the HTTP client's own timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      vi.setSystemTime(start + 15_000);
      expect(service.liveTurn()?.state).toBe("settled");
      vi.setSystemTime(start + 30_000);
      expect(service.liveTurn()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing one session while its turn is in flight, and counts the rest", async () => {
    const { call, service } = await harness();
    const post = async (sessionId: string, outputTokens: number, label?: string) =>
      call("POST", "/turn", {
        body: {
          sessionId,
          ...(label === undefined ? {} : { label }),
          provider: "anthropic",
          outputTokens,
          calls: 1,
          p50: 1000,
          p90: 5000,
        },
      });

    await post("session-a", 100, "repo-a");
    await post("session-b", 4000, "repo-b");
    await post("session-a", 200);
    await post("session-b", 4200);

    // Whoever posted last used to win, which is what made the icon flicker.
    const live = service.liveTurn();
    expect(live?.outputTokens).toBe(200);
    expect(live?.label).toBe("repo-a");
    expect(live?.sessions).toBe(2);
  });

  it("moves on once the featured turn is no longer in flight", async () => {
    const { call, service } = await harness();
    const post = async (sessionId: string, outputTokens: number) =>
      call("POST", "/turn", {
        body: { sessionId, provider: "anthropic", outputTokens, calls: 1, p50: 1000, p90: 5000 },
      });

    await post("session-a", 100);
    expect(service.liveTurn()?.outputTokens).toBe(100);

    // Only Date is faked, so the HTTP client's own timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Long enough that A has stopped growing, but not so long that it is gone.
      vi.setSystemTime(Date.now() + 15_000);
      await post("session-b", 300);
      expect(service.liveTurn()?.outputTokens).toBe(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records how each finished turn landed, and scores the recent ones", async () => {
    const { call, service } = await harness();
    const post = async (sessionId: string, outputTokens: number) =>
      call("POST", "/turn", {
        body: { sessionId, provider: "anthropic", outputTokens, calls: 2, p50: 1000, p90: 5000 },
      });

    // Nothing has finished yet, so there is nothing to score.
    expect(service.accuracy().n).toBe(0);

    await post("session-a", 400);
    await post("session-a", 800);
    // A count that goes backwards is the next turn in the same session, which
    // retires the one before it at the size it reached.
    await post("session-a", 100);
    await post("session-a", 9000);
    await post("session-a", 50);

    const accuracy = service.accuracy();
    expect(accuracy.n).toBe(2);
    expect(accuracy.points.map((p) => p.verdict)).toEqual(["under", "over"]);
    expect(accuracy.points[0]?.outputTokens).toBe(800);
    expect(accuracy.withinP50).toBeCloseTo(0.5, 5);
    expect(accuracy.withinP90).toBeCloseTo(0.5, 5);
    expect(accuracy.points[0]?.ratio).toBeCloseTo(0.8, 5);
    // Outcomes carry no session id, hashed or otherwise.
    expect(JSON.stringify(accuracy)).not.toContain("session-a");

    // And the menu bar can see all of it in one poll.
    const health = await call("GET", "/health");
    expect((health.json["accuracy"] as Record<string, unknown>)["n"]).toBe(2);
  });

  it("does not score a turn that is merely between tool calls", async () => {
    const { call, service } = await harness();
    const post = async (outputTokens: number) =>
      call("POST", "/turn", {
        body: { sessionId: "s", provider: "anthropic", outputTokens, calls: 1, p50: 1000, p90: 5000 },
      });

    await post(500);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      // A long tool call: the menu bar has given up on the turn…
      vi.setSystemTime(start + 30_000);
      expect(service.liveTurn()).toBeNull();
      expect(service.accuracy().n).toBe(0);

      // …and then it produces the rest of its output.
      vi.useRealTimers();
      await post(9000);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      service.liveTurn();

      const accuracy = service.accuracy();
      expect(accuracy.n).toBe(1);
      expect(accuracy.points[0]?.outputTokens).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not score a turn it had no forecast for", async () => {
    const { call, service } = await harness();
    const post = async (outputTokens: number) =>
      call("POST", "/turn", {
        body: { sessionId: "s", provider: "anthropic", outputTokens, calls: 1 },
      });
    await post(500);
    await post(10);
    expect(service.accuracy().points).toHaveLength(0);
  });

  it("marks a generic forecast so it cannot pass as a personal one", async () => {
    const { call } = await harness();
    const response = await call("POST", "/turn", {
      body: {
        sessionId: "s",
        provider: "anthropic",
        outputTokens: 10,
        p50: 1000,
        p90: 5000,
        usedFallback: true,
      },
    });
    expect((response.json["liveTurn"] as Record<string, unknown>)["usedFallback"]).toBe(true);
  });

});

describe("defaults a fresh install starts with", () => {
  it("forecasts from the draft unless it has been switched off", async () => {
    const { service } = await harness();
    expect(service.draftConditioning).toBe(true);
    service.setDraftConditioning(false);
    expect(service.draftConditioning).toBe(false);
    service.setDraftConditioning(true);
    expect(service.draftConditioning).toBe(true);
  });
});

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { dashboardHtml, isPageSlug } from "./dashboard.js";
import { launcherTargets } from "./launcher.js";
import {
  aliasInstalled,
  installAlias,
  shellTargetFor,
  shippedTargets,
  uninstallAlias,
} from "./shell-alias.js";
import type { CompanionService } from "./service.js";

/**
 * A deliberately small loopback API.
 *
 * Security boundary, stated once so it can be checked:
 *   - The listener binds 127.0.0.1 only, so nothing off this machine can reach it.
 *   - Every request must carry the per-install bearer token, compared in
 *     constant time. The token lives in a 0600 file next to the database.
 *   - There is no CORS header at all, so a web page cannot read a response even
 *     if it guessed the port; the browser blocks it before the token matters.
 *   - No endpoint returns prompt or response text, because the store holds none.
 */

export const COMPANION_VERSION = "0.1.0";

/** Contents of `runtime.json`, the file clients read to find the daemon. */
export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export function runtimeFilePath(dataDir: string): string {
  return join(dataDir, "runtime.json");
}

/** The current shell's startup file, or null when its syntax is not ours. */
function shellRc(): string | null {
  return shellTargetFor()?.rcPath ?? null;
}

/** Generate or reuse the per-install API token. */
export function loadOrCreateToken(service: CompanionService): string {
  const existing = service.store.get("api_token");
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  service.store.set("api_token", token);
  return token;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  // The dashboard is opened from a menu item, so it passes the token in the
  // query string; that URL never leaves this machine.
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const supplied = bearer || (url.searchParams.get("token") ?? "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A local client has no reason to send a large body; cap it rather than
    // buffering whatever arrives.
    if (size > 256 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

/** Options for {@link startServer}. */
export interface StartServerOptions {
  service: CompanionService;
  dataDir: string;
  /** 0 asks the OS for a free port, which is then published in runtime.json. */
  port?: number;
  /** Called when a client asks for a rebuild, so the daemon can run it. */
  onRebuild: () => void;
}

/** A running companion API. */
export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  close: () => Promise<void>;
}

/** Start the loopback API and publish `runtime.json`. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { service, dataDir } = options;
  const token = loadOrCreateToken(service);

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: error instanceof Error ? error.message : "internal error" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (!authorized(request, token)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "GET" && path === "/health") {
      send(response, 200, health(service));
      return;
    }
    if (request.method === "GET" && path === "/profiles") {
      const profile = service.profile;
      send(response, 200, {
        profile,
        evaluation: service.evaluation(),
        profiles: profile ? Object.values(profile.scales) : [],
      });
      return;
    }
    if (request.method === "GET" && path === "/stats") {
      // Everything the statistics page renders, as JSON, so a client can build
      // its own view without scraping HTML.
      send(response, 200, {
        health: health(service),
        sufficiency: service.sufficiency(),
        evaluation: service.evaluation(),
        profile: service.profile,
      });
      return;
    }
    if (request.method === "POST" && path === "/forecast") {
      const body = await readJson(request);
      const provider = body["provider"];
      const scale = body["scale"];
      if (provider !== "openai" && provider !== "anthropic") {
        send(response, 400, { error: "provider must be 'openai' or 'anthropic'" });
        return;
      }
      if (scale !== "call" && scale !== "turn") {
        send(response, 400, { error: "scale must be 'call' or 'turn'" });
        return;
      }
      send(response, 200, {
        // The status line reads its style off this reply; see statusline.ts.
        statusStyle: service.statusStyle,
        forecast: service.forecast({
          provider,
          scale,
          model: typeof body["model"] === "string" ? body["model"] : null,
          reasoning: typeof body["reasoning"] === "string" ? body["reasoning"] : null,
          promptFeatures:
            body["promptFeatures"] && typeof body["promptFeatures"] === "object"
              ? (body["promptFeatures"] as never)
              : null,
          ...(typeof body["maxTokens"] === "number" ? { maxTokens: body["maxTokens"] } : {}),
        }),
      });
      return;
    }
    if (request.method === "POST" && path === "/turn") {
      // Reported by whatever can see the turn as it happens: the status line
      // in Claude Code, and `bin/tf-codex` through the same renderer, since
      // Codex will not run one. Numbers only; the body carries no prompt text
      // and the session id is hashed before it is served back out again.
      const body = await readJson(request);
      const provider = body["provider"];
      if (provider !== "openai" && provider !== "anthropic") {
        send(response, 400, { error: "provider must be 'openai' or 'anthropic'" });
        return;
      }
      const sessionId = body["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        send(response, 400, { error: "sessionId is required" });
        return;
      }
      const finite = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const label = body["label"];
      service.recordLiveTurn({
        sessionId,
        // A workspace name, so the menu can say which chat the bar is showing.
        // Trimmed hard: it is a label for one menu row, not a path.
        label: typeof label === "string" && label.length > 0 ? label.slice(0, 40) : null,
        provider,
        outputTokens: Math.max(0, finite(body["outputTokens"]) ?? 0),
        calls: Math.max(0, finite(body["calls"]) ?? 0),
        p50: finite(body["p50"]),
        p90: finite(body["p90"]),
        usedFallback: body["usedFallback"] === true,
        ...(typeof body["inFlight"] === "boolean" ? { inFlight: body["inFlight"] } : {}),
      });
      send(response, 200, { liveTurn: service.liveTurn() });
      return;
    }
    if (request.method === "POST" && path === "/rebuild") {
      options.onRebuild();
      send(response, 202, { started: true });
      return;
    }
    if (request.method === "POST" && path === "/pause") {
      const body = await readJson(request);
      service.setPaused(body["paused"] === true);
      send(response, 200, { paused: service.paused });
      return;
    }
    if (request.method === "GET" && path === "/settings") {
      send(response, 200, {
        codexDir: service.codexDir,
        claudeDir: service.claudeDir,
        launchAtLogin: service.store.get("launch_at_login") === "true",
        statusStyle: service.statusStyle,
        draftConditioning: service.draftConditioning,
        shellAlias: shellRc() !== null && aliasInstalled(shellRc()!),
        shellAliasSupported: shellRc() !== null,
        shellAliasOffered: service.shellAliasOffered,
      });
      return;
    }
    if (request.method === "POST" && path === "/settings") {
      const body = await readJson(request);
      service.setDirectories({
        ...(typeof body["codexDir"] === "string" ? { codexDir: body["codexDir"] } : {}),
        ...(typeof body["claudeDir"] === "string" ? { claudeDir: body["claudeDir"] } : {}),
      });
      if (body["statusStyle"] === "simple" || body["statusStyle"] === "detailed") {
        service.setStatusStyle(body["statusStyle"]);
      }
      if (typeof body["shellAlias"] === "boolean") {
        const rcPath = shellRc();
        if (rcPath) {
          if (body["shellAlias"]) installAlias(rcPath, shippedTargets(launcherTargets()));
          else uninstallAlias(rcPath);
        }
        // Asked and answered, either way: never offer again.
        service.markShellAliasOffered();
      }
      if (body["shellAliasOffered"] === true) service.markShellAliasOffered();
      if (typeof body["draftConditioning"] === "boolean") {
        const changed = body["draftConditioning"] !== service.draftConditioning;
        service.setDraftConditioning(body["draftConditioning"]);
        // The rungs it selects are baked into the profile, so the switch means
        // nothing until the profile is rebuilt.
        if (changed) options.onRebuild();
      }
      if (typeof body["launchAtLogin"] === "boolean") {
        service.store.set("launch_at_login", body["launchAtLogin"] ? "true" : "false");
      }
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/uninstall") {
      // Everything this app wrote outside its own data directory, undone: the
      // shell block first, so a launcher about to be deleted stops being
      // referenced, then the derived data. History files are never touched.
      const rcPath = shellRc();
      const shellRestored = rcPath ? uninstallAlias(rcPath).changed : false;
      service.reset();
      send(response, 200, { ok: true, shellRestored, dataDir });
      return;
    }
    if (request.method === "POST" && path === "/reset") {
      service.reset();
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && path.startsWith("/dashboard")) {
      const slug = path.slice("/dashboard".length).replace(/^\//, "");
      if (slug !== "" && !isPageSlug(slug)) {
        send(response, 404, { error: "no such page" });
        return;
      }
      const html = dashboardHtml({
        slug: slug as never,
        token,
        health: health(service),
        evaluation: service.evaluation(),
        profile: service.profile,
        sufficiency: service.sufficiency(),
        weekly: service.store.weeklyCounts(),
      });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // A dashboard that cannot load anything remote cannot leak anything.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(html);
      return;
    }
    send(response, 404, { error: "not found" });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. Never 0.0.0.0.
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  mkdirSync(dataDir, { recursive: true });
  const runtimePath = runtimeFilePath(dataDir);
  const info: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  // 0600 because this file is the API token. On Windows the mode is close to
  // meaningless -- NTFS has an ACL, not permission bits -- but the directory it
  // sits in is per-user Local AppData, which is not readable by other accounts,
  // and the server binds loopback and checks the token on every request.
  writeFileSync(runtimePath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  chmodSync(runtimePath, 0o600);

  return {
    server,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The `/health` payload. Shared by the API and the dashboard renderer. */
export function health(service: CompanionService): Record<string, unknown> {
  const summary = service.store.summary();
  const profile = service.profile;
  const evaluation = service.evaluation();
  return {
    ok: true,
    version: COMPANION_VERSION,
    paused: service.paused,
    indexing: service.indexing,
    sources: service.sources(),
    defaultP50: service.defaultP50(),
    profile: {
      sampleCount: summary.observations,
      lastRebuildAt: profile?.generatedAt ?? null,
      groups: profile
        ? Object.values(profile.scales).reduce((n, s) => n + Object.keys(s.groups).length, 0)
        : 0,
      promptTiersAdopted: profile?.promptTiersAdopted ?? false,
      promptTiersReason: profile?.promptTiersReason ?? null,
      providers: profile
        ? Object.values(profile.scales).map((s) => ({
            provider: s.provider,
            scale: s.scale,
            groups: Object.keys(s.groups).length,
            samples: s.sampleSize,
            models: s.models,
          }))
        : [],
    },
    coverage:
      evaluation?.slices.map((slice) => {
        const best = slice.candidates.find((c) => c.name === slice.best) ?? slice.candidates[0]!;
        return {
          provider: slice.provider,
          scale: slice.scale,
          candidate: slice.best,
          p50: best.coverageP50,
          p90: best.coverageP90,
          p99: best.coverageP99,
          n: best.n,
          conditioningHelps: slice.conditioningHelps,
        };
      }) ?? [],
    currentSession: service.currentSession(),
    liveTurn: service.liveTurn(),
    accuracy: service.accuracy(),
  };
}

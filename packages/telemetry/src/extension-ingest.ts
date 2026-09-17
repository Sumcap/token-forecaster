import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  extensionTelemetryClientEventSchema,
  type ExtensionTelemetryClientEvent,
} from "@token-forecaster/core";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_BATCH_SIZE = 25;

interface RegistrationRecord {
  type: "registered";
  timestamp: string;
  installationIdHash: string;
  accessTokenHash: string;
  deletionTokenHash: string;
}

interface RevocationRecord {
  type: "revoked";
  timestamp: string;
  installationIdHash: string;
}

type RegistryRecord = RegistrationRecord | RevocationRecord;

export interface AnonymousInstallationCredentials {
  accessToken: string;
  deletionToken: string;
}

/**
 * Persistent, anonymous per-install credentials for a single-VM collector.
 * Only keyed hashes are written to disk; a public extension contains no
 * shared collector secret.
 */
export class JsonlInstallationRegistry {
  readonly filePath: string;
  private readonly tokenSecret: string;
  private readonly access = new Map<string, string>();
  private readonly deletion = new Map<string, string>();
  private readonly revoked = new Set<string>();
  private pending: Promise<void>;

  constructor(options: { filePath: string; tokenSecret: string }) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error("installation registry filePath must be absolute");
    }
    if (options.tokenSecret.length < 32) {
      throw new Error("installation tokenSecret must be at least 32 characters");
    }
    this.filePath = options.filePath;
    this.tokenSecret = options.tokenSecret;
    this.pending = this.load();
  }

  private tokenHash(token: string): string {
    return createHmac("sha256", this.tokenSecret)
      .update("token-forecaster-install-token\0")
      .update(token)
      .digest("hex");
  }

  private async load(): Promise<void> {
    let lines;
    try {
      lines = createInterface({
        input: createReadStream(this.filePath, "utf8"),
        crlfDelay: Infinity,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as RegistryRecord;
        if (record.type === "registered") {
          this.access.set(record.accessTokenHash, record.installationIdHash);
          this.deletion.set(record.deletionTokenHash, record.installationIdHash);
        } else if (record.type === "revoked") {
          this.revoked.add(record.installationIdHash);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  register(): Promise<AnonymousInstallationCredentials> {
    return this.serialize(async () => {
      const accessToken = randomBytes(32).toString("base64url");
      const deletionToken = randomBytes(32).toString("base64url");
      const installationIdHash = createHash("sha256")
        .update("token-forecaster-installation\0")
        .update(randomBytes(32))
        .digest("hex");
      const record: RegistrationRecord = {
        type: "registered",
        timestamp: new Date().toISOString(),
        installationIdHash,
        accessTokenHash: this.tokenHash(accessToken),
        deletionTokenHash: this.tokenHash(deletionToken),
      };
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.access.set(record.accessTokenHash, installationIdHash);
      this.deletion.set(record.deletionTokenHash, installationIdHash);
      return { accessToken, deletionToken };
    });
  }

  authorizeAccess(token: string): Promise<string | null> {
    return this.pending.then(() => {
      const installationIdHash = this.access.get(this.tokenHash(token));
      if (installationIdHash === undefined || this.revoked.has(installationIdHash)) return null;
      return installationIdHash;
    });
  }

  revokeWithDeletionToken(token: string): Promise<string | null> {
    return this.serialize(async () => {
      const installationIdHash = this.deletion.get(this.tokenHash(token));
      if (installationIdHash === undefined || this.revoked.has(installationIdHash)) return null;
      const record: RevocationRecord = {
        type: "revoked",
        timestamp: new Date().toISOString(),
        installationIdHash,
      };
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.revoked.add(installationIdHash);
      return installationIdHash;
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export interface StoredExtensionTelemetryEvent {
  receivedAt: string;
  installationIdHash: string;
  event: ExtensionTelemetryClientEvent;
}

/** JSONL event storage with a real, physical per-install deletion operation. */
export class JsonlExtensionTelemetryWriter {
  readonly filePath: string;
  private readonly blockedUsers = new Set<string>();
  private readonly eventOwners = new Map<string, string>();
  private pending: Promise<void>;

  constructor(options: { filePath: string }) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error("extension telemetry filePath must be absolute");
    }
    this.filePath = options.filePath;
    this.pending = this.load();
  }

  private async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Partial<StoredExtensionTelemetryEvent>;
        if (
          typeof row.installationIdHash === "string" &&
          typeof row.event === "object" &&
          row.event !== null &&
          typeof (row.event as { id?: unknown }).id === "string"
        ) {
          this.eventOwners.set((row.event as { id: string }).id, row.installationIdHash);
        }
      } catch {
        // A legacy line is retained but cannot participate in idempotency.
      }
    }
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  appendBatch(
    installationIdHash: string,
    events: readonly ExtensionTelemetryClientEvent[],
  ): Promise<void> {
    const parsed = events.map((event) => extensionTelemetryClientEventSchema.parse(event));
    // The extension collector has no storage mode, no ceiling and no redactor
    // -- all three live on JsonlTelemetryWriter, which this route does not
    // use. But `extensionResearchEventSchema` embeds the full observation
    // schema, and that schema now permits `request.promptText`. So a client
    // authenticating as an install could append verbatim prompts to this file
    // with nothing standing in the way. Drop the text here, unconditionally:
    // this route is documented as one the prompt text never reaches, and a
    // route with no enforcement must not accept a field that needs it.
    const stripped = new Set<string>();
    for (const event of parsed) {
      if (event.kind !== "research") continue;
      const request = event.observation.request as { promptText?: string };
      if (request.promptText === undefined) continue;
      delete request.promptText;
      stripped.add(event.id);
    }
    return this.serialize(async () => {
      if (this.blockedUsers.has(installationIdHash)) {
        throw new Error("installation is revoked");
      }
      const fresh = parsed.filter((event) => !this.eventOwners.has(event.id));
      if (fresh.length === 0) return;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const receivedAt = new Date().toISOString();
      const lines = fresh.map((event) =>
        JSON.stringify({
          receivedAt,
          installationIdHash,
          // Say so on the row rather than leaving a mode that now describes
          // something this file does not hold. A reader must not have to infer
          // from an absent field whether text was never sent or was dropped.
          ...(stripped.has(event.id) ? { promptTextDroppedByCollector: true } : {}),
          event,
        }),
      );
      await appendFile(this.filePath, `${lines.join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      for (const event of fresh) this.eventOwners.set(event.id, installationIdHash);
    });
  }

  deleteUser(installationIdHash: string): Promise<void> {
    this.blockedUsers.add(installationIdHash);
    return this.serialize(async () => {
      let contents: string;
      try {
        contents = await readFile(this.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const retained = contents
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          try {
            const row = JSON.parse(line) as Partial<StoredExtensionTelemetryEvent>;
            return row.installationIdHash !== installationIdHash;
          } catch {
            // Never silently erase a line that predates this schema.
            return true;
          }
        })
        .join("\n");
      for (const [eventId, owner] of this.eventOwners) {
        if (owner === installationIdHash) this.eventOwners.delete(eventId);
      }
      const temporary = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(retained.length === 0 ? "" : `${retained}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export async function* readExtensionTelemetryJsonl(
  filePath: string,
): AsyncGenerator<StoredExtensionTelemetryEvent> {
  const lines = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as StoredExtensionTelemetryEvent;
    row.event = extensionTelemetryClientEventSchema.parse(row.event);
    yield row;
  }
}

export interface ExtensionTelemetryIngestOptions {
  writer: JsonlExtensionTelemetryWriter;
  registry: JsonlInstallationRegistry;
  maxBodyBytes?: number;
  maxBatchSize?: number;
  /** In-memory guard; production should also rate-limit at the TLS edge. */
  registrationsPerHour?: number;
  eventsPerInstallationHour?: number;
}

class BodyTooLargeError extends Error {}

function tokenFromAuthorization(
  header: string | undefined,
  scheme: "Bearer" | "Deletion",
): string | null {
  const prefix = `${scheme} `;
  if (!header?.startsWith(prefix)) return null;
  const token = header.slice(prefix.length);
  return token.length >= 32 ? token : null;
}

function respond(
  response: ServerResponse,
  status: number,
  payload?: Record<string, unknown>,
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (payload === undefined) {
    response.writeHead(status).end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonRequest(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").startsWith("application/json");
}

interface RateWindow {
  startedAt: number;
  used: number;
}

function consumeRate(
  windows: Map<string, RateWindow>,
  key: string,
  amount: number,
  limit: number,
): boolean {
  const now = Date.now();
  const current = windows.get(key);
  const window =
    current === undefined || now - current.startedAt >= 60 * 60_000
      ? { startedAt: now, used: 0 }
      : current;
  if (window.used + amount > limit) return false;
  window.used += amount;
  windows.set(key, window);
  return true;
}

/** Anonymous registration, batched ingest, and user-triggered physical deletion. */
export function createExtensionTelemetryIngestHandler(
  options: ExtensionTelemetryIngestOptions,
): RequestListener {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const registrationsPerHour = options.registrationsPerHour ?? 60;
  const eventsPerInstallationHour = options.eventsPerInstallationHour ?? 10_000;
  const registrationWindows = new Map<string, RateWindow>();
  const eventWindows = new Map<string, RateWindow>();
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer");
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0 || maxBatchSize > 100) {
    throw new Error("maxBatchSize must be an integer from 1 to 100");
  }
  if (!Number.isInteger(registrationsPerHour) || registrationsPerHour <= 0) {
    throw new Error("registrationsPerHour must be a positive integer");
  }
  if (!Number.isInteger(eventsPerInstallationHour) || eventsPerInstallationHour <= 0) {
    throw new Error("eventsPerInstallationHour must be a positive integer");
  }

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        respond(response, 204);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/installations") {
        if (!jsonRequest(request)) {
          respond(response, 415, { error: "application_json_required" });
          return;
        }
        const remote = request.socket.remoteAddress ?? "unknown";
        if (!consumeRate(registrationWindows, remote, 1, registrationsPerHour)) {
          response.setHeader("retry-after", "3600");
          respond(response, 429, { error: "registration_rate_limited" });
          return;
        }
        try {
          const raw = await readBody(request, maxBodyBytes);
          const body = JSON.parse(raw) as Record<string, unknown>;
          if (
            typeof body.extensionVersion !== "string" ||
            body.extensionVersion.length < 1 ||
            body.extensionVersion.length > 64 ||
            !Number.isInteger(body.consentVersion) ||
            Number(body.consentVersion) < 1
          ) {
            respond(response, 400, { error: "invalid_registration" });
            return;
          }
          const credentials = await options.registry.register();
          respond(response, 201, { ...credentials });
        } catch (error) {
          respond(
            response,
            error instanceof BodyTooLargeError ? 413 : 400,
            { error: error instanceof BodyTooLargeError ? "request_too_large" : "invalid_registration" },
          );
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        if (!jsonRequest(request)) {
          respond(response, 415, { error: "application_json_required" });
          return;
        }
        const token = tokenFromAuthorization(request.headers.authorization, "Bearer");
        const installationIdHash =
          token === null ? null : await options.registry.authorizeAccess(token);
        if (installationIdHash === null) {
          response.setHeader("www-authenticate", "Bearer");
          respond(response, 401, { error: "unauthorized" });
          return;
        }
        let events: ExtensionTelemetryClientEvent[];
        try {
          const raw = await readBody(request, maxBodyBytes);
          const submitted = (JSON.parse(raw) as { events?: unknown }).events;
          if (!Array.isArray(submitted) || submitted.length < 1 || submitted.length > maxBatchSize) {
            respond(response, 400, { error: "invalid_batch" });
            return;
          }
          events = submitted.map((event) => extensionTelemetryClientEventSchema.parse(event));
        } catch (error) {
          respond(
            response,
            error instanceof BodyTooLargeError ? 413 : 400,
            { error: error instanceof BodyTooLargeError ? "batch_too_large" : "invalid_batch" },
          );
          return;
        }
        if (
          !consumeRate(
            eventWindows,
            installationIdHash,
            events.length,
            eventsPerInstallationHour,
          )
        ) {
          response.setHeader("retry-after", "3600");
          respond(response, 429, { error: "event_rate_limited" });
          return;
        }
        try {
          await options.writer.appendBatch(installationIdHash, events);
          respond(response, 202, { accepted: events.length });
        } catch {
          respond(response, 500, { error: "ingest_failed" });
        }
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/v1/installations/current") {
        const token = tokenFromAuthorization(request.headers.authorization, "Deletion");
        const installationIdHash =
          token === null ? null : await options.registry.revokeWithDeletionToken(token);
        if (installationIdHash === null) {
          respond(response, 401, { error: "unauthorized" });
          return;
        }
        await options.writer.deleteUser(installationIdHash);
        respond(response, 204);
        return;
      }

      respond(response, 404, { error: "not_found" });
    })().catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "ingest_failed" });
      else response.end();
    });
  };
}

/** Constant-time string equality for tests and future token adapters. */
export function telemetryTokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

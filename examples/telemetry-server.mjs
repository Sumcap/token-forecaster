#!/usr/bin/env node
import { createServer } from "node:http";
let telemetry;
try {
  telemetry = await import("@token-forecaster/telemetry");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("@token-forecaster/telemetry")) {
    throw error;
  }
  telemetry = await import("../packages/telemetry/dist/index.js");
}

const {
  JsonlExtensionTelemetryWriter,
  JsonlInstallationRegistry,
  JsonlTelemetryWriter,
  createExtensionTelemetryIngestHandler,
  createTelemetryIngestHandler,
} = telemetry;

const filePath = process.env.TOKEN_FORECASTER_TELEMETRY_FILE;
const bearerToken = process.env.TOKEN_FORECASTER_INGEST_TOKEN;
const tokenSecret = process.env.TOKEN_FORECASTER_INSTALL_TOKEN_SECRET;
const registryFile = process.env.TOKEN_FORECASTER_INSTALL_REGISTRY_FILE;
const host = process.env.TOKEN_FORECASTER_HOST ?? "127.0.0.1";
const port = Number(process.env.TOKEN_FORECASTER_PORT ?? "8787");

if (!filePath || (!tokenSecret && !bearerToken)) {
  throw new Error(
    "TOKEN_FORECASTER_TELEMETRY_FILE and either TOKEN_FORECASTER_INSTALL_TOKEN_SECRET (extension mode) or TOKEN_FORECASTER_INGEST_TOKEN (legacy direct API mode) are required",
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TOKEN_FORECASTER_PORT must be an integer from 1 to 65535");
}

const extensionMode = tokenSecret !== undefined;
const writer = extensionMode
  ? new JsonlExtensionTelemetryWriter({ filePath })
  : new JsonlTelemetryWriter({ filePath });
const registry = extensionMode
  ? new JsonlInstallationRegistry({
      filePath: registryFile ?? `${filePath}.installations.jsonl`,
      tokenSecret,
    })
  : null;
const handler =
  writer instanceof JsonlExtensionTelemetryWriter && registry !== null
    ? createExtensionTelemetryIngestHandler({ writer, registry })
    : createTelemetryIngestHandler({ writer, bearerToken });
const server = createServer(handler);
server.listen(port, host, () => {
  process.stdout.write(`Token Forecaster telemetry listening on http://${host}:${port}\n`);
});

async function stop() {
  server.close();
  await writer.flush();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

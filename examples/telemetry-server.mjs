#!/usr/bin/env node
import { createServer } from "node:http";
import {
  JsonlTelemetryWriter,
  createTelemetryIngestHandler,
} from "../packages/telemetry/dist/index.js";

const filePath = process.env.TOKEN_FORECASTER_TELEMETRY_FILE;
const bearerToken = process.env.TOKEN_FORECASTER_INGEST_TOKEN;
const host = process.env.TOKEN_FORECASTER_HOST ?? "127.0.0.1";
const port = Number(process.env.TOKEN_FORECASTER_PORT ?? "8787");

if (!filePath || !bearerToken) {
  throw new Error(
    "TOKEN_FORECASTER_TELEMETRY_FILE and TOKEN_FORECASTER_INGEST_TOKEN are required",
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TOKEN_FORECASTER_PORT must be an integer from 1 to 65535");
}

const writer = new JsonlTelemetryWriter({ filePath });
const server = createServer(createTelemetryIngestHandler({ writer, bearerToken }));
server.listen(port, host, () => {
  process.stdout.write(`Token Forecaster telemetry listening on http://${host}:${port}\n`);
});

async function stop() {
  server.close();
  await writer.flush();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

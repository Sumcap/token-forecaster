/** Build-time collector configuration. An empty origin means offline-only. */
declare const __TF_TELEMETRY_ORIGIN__: string;

const configuredOrigin =
  typeof __TF_TELEMETRY_ORIGIN__ === "string" ? __TF_TELEMETRY_ORIGIN__ : "";

export const TELEMETRY_ORIGIN = configuredOrigin.replace(/\/$/, "");

export function telemetryConfigured(): boolean {
  return TELEMETRY_ORIGIN.length > 0;
}

export function telemetryOriginPattern(): string | null {
  if (!telemetryConfigured()) return null;
  const url = new URL(TELEMETRY_ORIGIN);
  return `${url.origin}/*`;
}

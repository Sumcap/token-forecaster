#!/usr/bin/env node
/**
 * Build the unpacked extension into `dist/`.
 *
 * esbuild only, because a Chrome extension needs exactly what esbuild does:
 * one IIFE bundle for the content script (content scripts cannot be ES
 * modules), ES modules for the worker and the options page, and a copy step
 * for the static files.
 */
import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");
const telemetryOrigin = (process.env.TF_TELEMETRY_ORIGIN ?? "").replace(/\/$/, "");

function telemetryPermission() {
  if (telemetryOrigin.length === 0) return null;
  const url = new URL(telemetryOrigin);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("TF_TELEMETRY_ORIGIN must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TF_TELEMETRY_ORIGIN must be an origin with no path, query, or fragment");
  }
  return `${url.origin}/*`;
}

const shared = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: "chrome110",
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": '"production"',
    __TF_TELEMETRY_ORIGIN__: JSON.stringify(telemetryOrigin),
  },
};

/** @type {import("esbuild").BuildOptions[]} */
const targets = [
  {
    ...shared,
    entryPoints: [resolve(root, "src/content/index.ts")],
    outfile: resolve(outdir, "content.js"),
    format: "iife",
  },
  {
    ...shared,
    entryPoints: [resolve(root, "src/sw/index.ts")],
    outfile: resolve(outdir, "sw.js"),
    format: "esm",
  },
  {
    ...shared,
    entryPoints: [resolve(root, "src/options/index.ts")],
    outfile: resolve(outdir, "options.js"),
    format: "esm",
  },
  {
    ...shared,
    entryPoints: [resolve(root, "src/welcome/index.ts")],
    outfile: resolve(outdir, "welcome.js"),
    format: "esm",
  },
  // Design preview only. Nothing in the manifest references it; it exists so
  // the chip can be looked at without loading the extension. IIFE because a
  // module script does not load from file://.
  {
    ...shared,
    entryPoints: [resolve(root, "src/preview/index.ts")],
    outfile: resolve(outdir, "preview.js"),
    format: "iife",
  },
];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(root, "src/manifest.json"), "utf8"),
  );
  const permission = telemetryPermission();
  if (permission !== null) {
    if (process.env.TF_TELEMETRY_E2E_REQUIRED_PERMISSION === "1") {
      // Chrome headless cannot answer the browser-owned optional-permission
      // bubble. Production builds never set this test-only escape hatch.
      manifest.host_permissions = [permission];
    } else {
      manifest.optional_host_permissions.push(permission);
    }
  }
  await writeFile(
    resolve(outdir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await cp(resolve(root, "src/options/options.html"), resolve(outdir, "options.html"));
  await cp(resolve(root, "src/options/options.css"), resolve(outdir, "options.css"));
  await cp(resolve(root, "src/welcome/welcome.html"), resolve(outdir, "welcome.html"));
  await cp(resolve(root, "src/privacy/privacy.html"), resolve(outdir, "privacy.html"));
  await cp(resolve(root, "src/preview/preview.html"), resolve(outdir, "preview.html"));
  await cp(resolve(root, "src/icons"), resolve(outdir, "icons"), { recursive: true });
}

if (!watch) await rm(outdir, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(`watching; reload the extension in chrome://extensions after a change`);
} else {
  await Promise.all(targets.map((options) => build(options)));
  console.log(`built ${outdir}`);
}

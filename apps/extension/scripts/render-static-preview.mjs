#!/usr/bin/env node
/**
 * Bundle the static preview for node, render it under happy-dom, and write a
 * flat HTML file that any renderer can display.
 *
 *   node scripts/render-static-preview.mjs [out.html]
 */
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = resolve(process.argv[2] ?? join(root, "dist", "preview-static.html"));

const scratch = await mkdtemp(join(tmpdir(), "tf-preview-"));
const bundlePath = join(scratch, "static.mjs");
await build({
  entryPoints: [join(root, "src/preview/static.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
});

const window = new Window({ url: "https://claude.ai/code", width: 1200, height: 900 });
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MutationObserver = window.MutationObserver;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const { CASES, renderCase } = await import(`file://${bundlePath}`);

const from = Number(process.env["TF_PREVIEW_FROM"] ?? "0");
const sections = CASES.slice(from).map((testCase) => {
  const markup = renderCase(testCase.input);
  return `<section class="case"><h2>${testCase.title}</h2><div class="chips">
      <div class="theme light"><div class="tf">${markup}</div></div>
      <div class="theme dark"><div class="tf">${markup.replace('class="wrap"', 'class="wrap dark"')}</div></div>
    </div></section>`;
}).join("\n");

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Token Forecaster chip, static preview</title>
<style>
  body { margin: 0; padding: 24px; background: #f2f1ee; font-family: ui-sans-serif, system-ui, sans-serif; color: #2c2b28; }
  h1 { font-size: 18px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b6a66; margin: 24px 0 8px; }
  .chips { display: flex; gap: 24px; align-items: flex-start; }
  .theme { padding: 16px; border-radius: 12px; flex: 1; }
  .theme.light { background: #faf9f6; }
  .theme.dark { background: #1e1e1c; }
  /* The chip is normally a fixed overlay; the preview lays it out in flow. */
  .tf .wrap { position: static !important; display: inline-flex; }
  .tf .panel { max-height: none !important; }
</style></head>
<body><h1>Token Forecaster chip, static preview</h1>${sections}</body></html>`;

await writeFile(outFile, page, "utf8");
console.log(`wrote ${outFile}`);

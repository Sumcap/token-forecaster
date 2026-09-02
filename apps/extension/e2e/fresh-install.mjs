#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path, { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import {
  JsonlExtensionTelemetryWriter,
  JsonlInstallationRegistry,
  createExtensionTelemetryIngestHandler,
} from "../../../packages/telemetry/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const extensionDir = resolve(repo, "apps/extension/dist");
const temporary = await mkdtemp(path.join(tmpdir(), "token-forecaster-e2e-"));
const eventFile = path.join(temporary, "events.jsonl");
const registryFile = path.join(temporary, "installations.jsonl");
const userDataDir = path.join(temporary, "chrome-profile");

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("Chrome was not found. Set CHROME_PATH to run the extension E2E test.");
  }
  return found;
}

async function eventually(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function fileContents(file) {
  return readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

const writer = new JsonlExtensionTelemetryWriter({ filePath: eventFile });
const registry = new JsonlInstallationRegistry({
  filePath: registryFile,
  tokenSecret: "fresh-install-e2e-secret-with-more-than-32-characters",
});
const requestCounts = { registrations: 0, events: 0, deletions: 0 };
const ingest = createExtensionTelemetryIngestHandler({ writer, registry });
const server = createServer((request, response) => {
  if (request.url === "/v1/installations") requestCounts.registrations++;
  if (request.url === "/v1/events") requestCounts.events++;
  if (request.url === "/v1/installations/current") requestCounts.deletions++;
  ingest(request, response);
});

let browser;
try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  const telemetryOrigin = `http://127.0.0.1:${address.port}`;

  // First assert the real build contract: the collector is optional and is
  // requested only from the consent click. Headless Chrome cannot operate its
  // browser-owned permission bubble, so the second build grants it only for
  // the automated network path below.
  execFileSync("pnpm", ["--filter", "@token-forecaster/extension", "build"], {
    cwd: repo,
    env: { ...process.env, TF_TELEMETRY_ORIGIN: telemetryOrigin },
    stdio: "inherit",
  });
  const productionManifest = JSON.parse(
    await readFile(path.join(extensionDir, "manifest.json"), "utf8"),
  );
  assert(productionManifest.optional_host_permissions.includes(`${telemetryOrigin}/*`));
  assert.equal(productionManifest.host_permissions, undefined);

  execFileSync("pnpm", ["--filter", "@token-forecaster/extension", "build"], {
    cwd: repo,
    env: {
      ...process.env,
      TF_TELEMETRY_ORIGIN: telemetryOrigin,
      TF_TELEMETRY_E2E_REQUIRED_PERMISSION: "1",
    },
    stdio: "inherit",
  });

  browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    pipe: true,
    enableExtensions: [extensionDir],
    userDataDir,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
    { timeout: 15_000 },
  );
  const extensionId = new URL(workerTarget.url()).hostname;
  const welcomeTarget = await browser.waitForTarget(
    (target) => target.url() === `chrome-extension://${extensionId}/welcome.html`,
    { timeout: 15_000 },
  );
  const welcome = await welcomeTarget.page();
  assert(welcome, "fresh install did not open the welcome page");
  await welcome.bringToFront();
  await welcome.waitForSelector("#diagnosticsConsent");
  assert.equal(await welcome.$eval("#diagnosticsConsent", (node) => node.checked), false);
  assert.equal(await welcome.$eval("#researchConsent", (node) => node.checked), false);

  const initialStorage = await welcome.evaluate(async () =>
    chrome.storage.local.get(["tf-settings", "tf-telemetry-state"]),
  );
  assert.equal(initialStorage["tf-settings"].onboardingSeenVersion, 2);
  assert.equal(initialStorage["tf-settings"].diagnosticsConsent, "unset");
  assert.equal(initialStorage["tf-settings"].researchConsent, "unset");
  assert.deepEqual(initialStorage["tf-telemetry-state"], {
    queue: [],
    credentials: null,
    nextAttemptAt: 0,
    lastErrorCode: null,
  });
  assert.deepEqual(requestCounts, { registrations: 0, events: 0, deletions: 0 });

  const claude = await browser.newPage();
  await claude.setRequestInterception(true);
  claude.on("request", (request) => {
    if (request.isNavigationRequest() && request.url().startsWith("https://claude.ai/")) {
      void request.respond({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <div data-testid="assistant-message">Existing reply.</div>
          <fieldset><div data-testid="chat-input-container">
            <div class="ProseMirror" contenteditable="true"><p></p></div>
            <button data-testid="model-selector-dropdown"><span>Opus 5</span><span>High</span></button>
            <button data-testid="send-button">Send</button>
          </div></fieldset>
        </body></html>`,
      });
      return;
    }
    void request.abort();
  });
  await claude.goto("https://claude.ai/code/fresh-install", { waitUntil: "domcontentloaded" });
  await eventually(
    () => claude.evaluate(() => document.querySelector("#token-forecaster-chip-host") !== null),
    "content script did not mount on a clean Claude Code page",
  );

  const uniquePrompt = "FRESH_INSTALL_PRIVATE_PROMPT_91e302 write a concise report";
  await claude.$eval(".ProseMirror", (composer, text) => {
    composer.innerHTML = `<p>${text}</p>`;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  }, uniquePrompt);
  const pillText = await eventually(
    () =>
      claude.evaluate(() => {
        const host = document.querySelector("#token-forecaster-chip-host");
        return host?.shadowRoot?.querySelector(".pill")?.textContent ?? "";
      }).then((text) => (/\d+ in · ~[\d.k]+–[\d.k]+ out/.test(text) ? text : "")),
    "first local forecast did not render",
  );
  assert.match(pillText, / in · ~/);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.deepEqual(requestCounts, { registrations: 0, events: 0, deletions: 0 });
  assert.equal(await fileContents(eventFile), "");

  // Consent is a user gesture on the extension page, which is when Chrome asks
  // for the optional collector host permission.
  await welcome.bringToFront();
  await welcome.click("#diagnosticsConsent");
  await eventually(
    () => welcome.$eval("#diagnosticsConsent", (node) => node.checked),
    "diagnostics consent was not granted",
  );
  try {
    await eventually(
      async () => requestCounts.events > 0 && (await fileContents(eventFile)).includes("extension_ready"),
      "consented diagnostics did not reach the collector",
    );
  } catch (error) {
    const debug = await welcome.evaluate(async (pattern) => ({
      storage: await chrome.storage.local.get(["tf-settings", "tf-telemetry-state"]),
      permission: await chrome.permissions.contains({ origins: [pattern] }),
      status: document.querySelector("#telemetryStatus")?.textContent,
    }), `${telemetryOrigin}/*`);
    throw new Error(`${error.message}; debug=${JSON.stringify({ debug, requestCounts })}`);
  }

  await welcome.click("#researchConsent");
  await eventually(
    () => welcome.$eval("#researchConsent", (node) => node.checked),
    "research consent was not granted",
  );

  // MV3 workers may die at any time. Kill it between consent and the first
  // research outcome; the next content-script message must revive it.
  const cdp = await claude.createCDPSession();
  const targets = await cdp.send("Target.getTargets");
  const serviceWorker = targets.targetInfos.find(
    (target) => target.type === "service_worker" && target.url.includes(extensionId),
  );
  if (serviceWorker) await cdp.send("Target.closeTarget", { targetId: serviceWorker.targetId });
  await cdp.detach();

  await claude.bringToFront();
  await claude.$eval(".ProseMirror", (composer, text) => {
    composer.innerHTML = `<p>${text}</p>`;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  }, uniquePrompt);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await claude.evaluate(() => {
    const composer = document.querySelector(".ProseMirror");
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    composer.innerHTML = "<p></p>";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    const stop = document.createElement("button");
    stop.id = "e2e-stop";
    stop.setAttribute("data-testid", "stop-button");
    document.body.append(stop);
    const reply = document.createElement("div");
    reply.id = "e2e-reply";
    reply.setAttribute("data-testid", "assistant-message");
    reply.textContent = "A privacy-safe rendered outcome. ".repeat(80);
    document.body.append(reply);
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  await claude.$eval("#e2e-stop", (node) => node.remove());
  await eventually(
    async () => (await fileContents(eventFile)).includes('"kind":"research"'),
    "settled research observation did not survive service-worker restart",
    20_000,
  );
  const contributed = await fileContents(eventFile);
  assert(contributed.includes('"outputTokenQuality":"dom_estimate"'));
  assert(!contributed.includes(uniquePrompt), "raw prompt text reached the collector");
  const report = JSON.parse(
    execFileSync("node", [resolve(repo, "examples/extension-telemetry-report.mjs"), eventFile], {
      cwd: repo,
      encoding: "utf8",
    }),
  );
  assert.equal(report.source, "chrome-extension-visible-dom-estimates");
  assert.equal(report.research.acceptedRows, 1);
  assert.equal(report.gate.readyForUserBlockedEvaluation, false);

  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector("#deleteTelemetry");
  options.on("dialog", (dialog) => void dialog.accept());
  await options.click("#deleteTelemetry");
  await eventually(
    async () => requestCounts.deletions === 1 && (await fileContents(eventFile)) === "",
    "user-triggered deletion did not remove contributed rows",
  );
  const finalSettings = await options.evaluate(async () =>
    (await chrome.storage.local.get("tf-settings"))["tf-settings"],
  );
  assert.equal(finalSettings.diagnosticsConsent, "denied");
  assert.equal(finalSettings.researchConsent, "denied");

  process.stdout.write(
    "Fresh-install E2E passed: offline first value, explicit consent, durable delivery, DOM-estimate provenance, and remote deletion.\n",
  );
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  await writer.flush().catch(() => undefined);
  await registry.flush().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

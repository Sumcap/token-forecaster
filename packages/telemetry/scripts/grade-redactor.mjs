#!/usr/bin/env node
/**
 * Grade the redactor on the local Claude Code corpus.
 *
 * Reads every turn-root prompt this machine holds through the shared loader,
 * runs `redactPromptText` over it, then runs a SECOND, independently written
 * detector over the output and counts what it still finds. The detector is
 * deliberately not the redactor's own patterns: a redactor graded by its own
 * regexes measures nothing.
 *
 * OUTPUT IS COUNTS ONLY. When the detector hits, the report prints the class
 * and the length of the matched substring, never the substring. Nothing this
 * script prints may be pasted into a commit or an artifact without reading it
 * first; nothing it prints is meant to need that.
 *
 *   node packages/telemetry/scripts/grade-redactor.mjs [--projects-dir <dir>]
 *
 * Requires `pnpm --filter @token-forecaster/telemetry build` first: this is a
 * .mjs script and imports the built redactor.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { redactPromptText } = await import(path.join(here, "..", "dist", "redact.js"));
const { defaultProjectsDir, loadRequests } = await import(
  path.join(here, "..", "..", "ingest-claude", "load-history.mjs")
);

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const showResiduals = argv.includes("--residual-classes");

/**
 * The independent detector.
 *
 * Written to a different rule than the redactor: it looks only for things that
 * are unambiguously machine-identifying, and it does not care about false
 * positives on prose, because a false positive here costs one line of report
 * and a false negative costs a leak. It knows nothing about the redactor's
 * patterns, and treats the redactor's own `<class>` tokens as the only allowed
 * residue.
 */
const DETECTORS = [
  ["abs_path", /(?:^|[\s"'`(\[{=,])(?:\/(?:Users|home|var|etc|opt|tmp|private|mnt|srv|root)\/[^\s"'`)\]}<>,]+)/g],
  ["home_path", /(?:^|[\s"'`(\[{=,])~\/[^\s"'`)\]}<>,]+/g],
  ["win_path", /(?:^|[\s"'`(\[{=,])[A-Za-z]:[\\/][^\s"'`)\]}<>,]+/g],
  ["code_path", /(?:^|[\s"'`(\[{=,])[\w.@+-]+(?:\/[\w.@+-]+){1,}\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|c|h|hpp|cpp|sh|zsh|yml|yaml|toml|css|scss|html|sql|env|pem|key)\b/g],
  ["url", /\b[a-z][a-z0-9+.-]{2,}:\/\/[^\s"'`)\]}<>]+/gi],
  // The trailing \b is load-bearing: without it `.co`, `.sh` and `.app` match
  // inside `array.concat(`, `list.shift()` and `parts.append(`, and the report
  // fills up with method calls.
  ["bare_host", /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|sh|app|cloud|xyz|internal|local)\b(?:\/[^\s"'`)\]}<>]*)?/gi],
  ["email", /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
  ["long_hex", /\b[0-9a-fA-F]{32,}\b/g],
  // No `/` in the character class: a forty-character run containing a
  // separator is a path, and the path detectors above own that case. Leaving
  // it in reported every long directory name twice, under the wrong name.
  ["long_opaque", /\b(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[0-9])[A-Za-z0-9+_-]{40,}={0,2}\b/g],
  ["provider_key", /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abpsr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|A(?:Iza|SIA)[A-Za-z0-9_-]{16,})/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/g],
  ["assigned_secret", /\b(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?key)\b\s*[=:]\s*(?!<secret>)["']?[^\s"',;)\]}]{6,}/gi],
];

/** The tokens the redactor is allowed to leave behind. */
const ALLOWED = /^<(?:path|url|email|hex|b64|secret)>$/;

function detect(text) {
  const hits = [];
  for (const [name, pattern] of DETECTORS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const found = match[0].trim();
      if (ALLOWED.test(found)) continue;
      // `<path>/something` cannot happen, but a token adjacent to prose can
      // produce a match that is entirely made of tokens; ignore those.
      if (found.replace(/<(?:path|url|email|hex|b64|secret)>/g, "").trim().length === 0) {
        continue;
      }
      hits.push({ detector: name, length: found.length });
    }
  }
  return hits;
}

const { rows } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withPromptText: true,
});

// One prompt per turn root: a turn's calls all carry the same opening text.
const prompts = new Map();
for (const row of rows) {
  if (!row.turnRootId) continue;
  if (typeof row.turnPromptText !== "string" || row.turnPromptText.length === 0) continue;
  if (!prompts.has(row.turnRootId)) prompts.set(row.turnRootId, row.turnPromptText);
}

const replacements = { path: 0, url: 0, email: 0, hex: 0, b64: 0, secret: 0 };
const residual = new Map();
const residualLengths = new Map();
let promptsWithReplacements = 0;
let promptsWithResidual = 0;
let totalChars = 0;

for (const text of prompts.values()) {
  totalChars += text.length;
  const { text: redacted, counts } = redactPromptText(text);
  let any = false;
  for (const key of Object.keys(replacements)) {
    replacements[key] += counts[key];
    if (counts[key] > 0) any = true;
  }
  if (any) promptsWithReplacements += 1;

  const hits = detect(redacted);
  if (hits.length > 0) promptsWithResidual += 1;
  for (const hit of hits) {
    residual.set(hit.detector, (residual.get(hit.detector) ?? 0) + 1);
    const lengths = residualLengths.get(hit.detector) ?? [];
    lengths.push(hit.length);
    residualLengths.set(hit.detector, lengths);
  }
}

const line = (text) => process.stdout.write(`${text}\n`);
line(`corpus            ${projectsDir}`);
line(`turn-root prompts ${prompts.size.toLocaleString("en-US")}`);
line(`characters        ${totalChars.toLocaleString("en-US")}`);
line(`prompts changed   ${promptsWithReplacements.toLocaleString("en-US")}`);
line("");
line("replacements by class");
for (const [key, count] of Object.entries(replacements)) {
  line(`  ${key.padEnd(8)} ${count.toLocaleString("en-US")}`);
}
line("");
line(`detector hits after redaction: ${[...residual.values()].reduce((a, b) => a + b, 0)}`);
line(`prompts with a hit:            ${promptsWithResidual}`);
if (residual.size > 0) {
  for (const [name, count] of [...residual.entries()].sort((a, b) => b[1] - a[1])) {
    const lengths = residualLengths.get(name) ?? [];
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    line(`  ${name.padEnd(16)} ${String(count).padStart(6)}   matched lengths ${min}–${max}`);
  }
  if (showResiduals) {
    line("");
    line("(--residual-classes prints nothing further: matched text is never printed)");
  }
}

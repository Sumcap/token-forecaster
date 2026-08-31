import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractPromptFeatures } from "@token-forecaster/core/prompt-features";
import { estimateTokensFromText } from "@token-forecaster/token-counter";
import { afterEach, describe, expect, it } from "vitest";

import { findPython } from "./python.js";
import { readDraft } from "./statusline.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

/**
 * How to run the launcher's own modules.
 *
 * `python3` is not a name that exists on Windows, where the interpreter is
 * reached through `py` — the same search `bin/tf-claude.cmd` does.
 */
const [PYTHON, ...PYTHON_ARGS] = (findPython() ?? ["python3"]) as [string, ...string[]];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["TOKEN_FORECASTER_DRAFT"];
});

/** Point TOKEN_FORECASTER_DRAFT at a file holding `body`. */
function draftFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-draft-"));
  dirs.push(dir);
  const path = join(dir, "draft.json");
  writeFileSync(path, JSON.stringify(body));
  process.env["TOKEN_FORECASTER_DRAFT"] = path;
  return path;
}

/** The prompts both extractors have to agree on. */
const PROMPTS = [
  "",
  "hi",
  "fix the parser",
  "Please refactor apps/companion/src/statusline.ts and /tmp/x.json",
  "why is this slow?",
  "see https://example.com/a?b=1 and ~/notes/todo.md",
  "write a test\n\n```ts\nconst a = 1;\n```\n\nthen run it",
  "  add   spacing   everywhere  ",
  "Optimise ./scripts/build.sh — does it work?",
  "no verb here, just a statement about tokens",
];

describe("draft feature parity", () => {
  it("the Python launcher and the TypeScript trainer extract the same features", () => {
    const out = execFileSync(
      PYTHON,
      [
        ...PYTHON_ARGS,
        "-c",
        [
          "import json,sys",
          `sys.path.insert(0, ${JSON.stringify(BIN)})`,
          "from tf_draft import features",
          "print(json.dumps([features(p) for p in json.loads(sys.argv[1])]))",
        ].join("\n"),
        JSON.stringify(PROMPTS),
      ],
      { encoding: "utf8" },
    );
    const fromPython = JSON.parse(out) as Record<string, unknown>[];
    const fromTypeScript = PROMPTS.map((p) => ({ ...extractPromptFeatures(p, ""), hash: "" }));
    expect(fromPython).toEqual(fromTypeScript);
  });
});

describe("draft token parity", () => {
  it("counts the typed tokens the same way the token counter does", () => {
    const out = execFileSync(
      PYTHON,
      [
        ...PYTHON_ARGS,
        "-c",
        [
          "import json,sys",
          `sys.path.insert(0, ${JSON.stringify(BIN)})`,
          "from tf_draft import estimate_tokens",
          "print(json.dumps([estimate_tokens(p.strip()) for p in json.loads(sys.argv[1])]))",
        ].join("\n"),
        JSON.stringify([...PROMPTS, "n\u00e3o \u00e9 ASCII \u2014 acentua\u00e7\u00e3o conta mais"]),
      ],
      { encoding: "utf8" },
    );
    const fromPython = JSON.parse(out) as number[];
    const fromTypeScript = [
      ...PROMPTS,
      "n\u00e3o \u00e9 ASCII \u2014 acentua\u00e7\u00e3o conta mais",
    ].map((p) => estimateTokensFromText(p.trim()));
    expect(fromPython).toEqual(fromTypeScript);
  });
});

describe("readDraft", () => {
  it("is absent unless a launcher is publishing one", () => {
    expect(readDraft()).toBeNull();
  });

  it("reads the counts a launcher published", () => {
    draftFile({ updatedAt: 1_000, tokens: 9, features: { chars: 28, words: 6 } });
    expect(readDraft(1_500)).toEqual({
      features: { chars: 28, words: 6 },
      chars: 28,
      tokens: 9,
    });
  });

  it("falls back to four characters a token for a launcher that reports none", () => {
    draftFile({ updatedAt: 1_000, features: { chars: 28 } });
    expect(readDraft(1_500)?.tokens).toBe(7);
  });

  it("ignores an empty draft, so an idle prompt box forecasts nothing", () => {
    draftFile({ updatedAt: 1_000, features: { chars: 0 } });
    expect(readDraft(1_500)).toBeNull();
  });

  it("ignores a draft left behind by a launcher that died", () => {
    draftFile({ updatedAt: 1_000, features: { chars: 28 } });
    expect(readDraft(1_000 + 300_001)).toBeNull();
  });

  it("never throws on a missing or malformed draft file", () => {
    process.env["TOKEN_FORECASTER_DRAFT"] = "/nonexistent/draft.json";
    expect(readDraft()).toBeNull();
    const path = draftFile({});
    writeFileSync(path, "{ truncated");
    expect(readDraft()).toBeNull();
  });
});

/**
 * The same keystrokes, delivered differently.
 *
 * On macOS the launcher reads up to 64KB at a time and an escape sequence
 * almost always arrives whole. Windows has no such read: the console is drained
 * a byte at a time, so a sequence that used to be parsed in one pass now spans
 * several. Half an escape sequence counted as text is an ANSI code inside the
 * prompt features, and nothing downstream would ever say so.
 */
describe("draft buffer, however the bytes arrive", () => {
  const STREAMS = [
    "fix the parser",
    "hello \u001b[Dworld",
    "\u001b[200~a pasted block\u001b[201~ and more",
    "typo\u007f\u007f fixed",
    "abandoned\u0015restarted",
    "submitted\rand then the next one",
    "two\u001b\rlines",
    "arrows \u001b[A\u001b[B\u001b[C\u001b[D done",
    "mouse \u001b[<0;12;34M report",
  ];

  it("counts the same line whether it is read in one chunk or one byte at a time", () => {
    const out = execFileSync(
      PYTHON,
      [
        ...PYTHON_ARGS,
        "-c",
        [
          "import importlib.util, json, os, sys",
          "from importlib.machinery import SourceFileLoader",
          // The launcher is `tf-claude`, with no extension and a hyphen: it is
          // a program, not a module, so it needs a loader named for it.
          `path = os.path.join(${JSON.stringify(BIN)}, "tf-claude")`,
          'loader = SourceFileLoader("tf_claude", path)',
          'spec = importlib.util.spec_from_loader("tf_claude", loader)',
          "module = importlib.util.module_from_spec(spec)",
          "loader.exec_module(module)",
          "def run(text, chunk):",
          "    draft = module.Draft(os.devnull)",
          "    data = text.encode('utf8')",
          "    for i in range(0, len(data), chunk):",
          "        draft.feed(data[i:i + chunk])",
          "    return ''.join(draft.buffer)",
          "streams = json.loads(sys.argv[1])",
          "print(json.dumps([[run(s, 4096), run(s, 1)] for s in streams]))",
        ].join("\n"),
        JSON.stringify(STREAMS),
      ],
      { encoding: "utf8" },
    );
    const results = JSON.parse(out) as [string, string][];
    for (const [whole, byteAtATime] of results) {
      expect(byteAtATime).toBe(whole);
      // Nothing that came in as an escape sequence may end up counted as text.
      expect(whole).not.toContain("\u001b");
      expect(whole).not.toContain("[");
    }
    // And the parsing is the parsing that was asked for, not an empty buffer
    // every time.
    expect(results.map(([whole]) => whole)).toEqual([
      "fix the parser",
      "hello world",
      "a pasted block and more",
      "ty fixed",
      "restarted",
      "and then the next one",
      "two\nlines",
      "arrows  done",
      "mouse  report",
    ]);
  });
});

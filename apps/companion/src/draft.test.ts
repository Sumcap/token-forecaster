import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractPromptFeatures } from "@token-forecaster/core/prompt-features";
import { estimateTokensFromText } from "@token-forecaster/token-counter";
import { afterEach, describe, expect, it } from "vitest";

import { readDraft } from "./statusline.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

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
      "python3",
      [
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
      "python3",
      [
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

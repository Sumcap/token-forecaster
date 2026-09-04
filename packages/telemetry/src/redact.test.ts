import { describe, expect, it } from "vitest";

import { redactPromptText } from "./redact.js";

/**
 * The table is the test. Each row is an input, the class expected to fire, and
 * a fragment that must not survive; the guards at the bottom are the opposite
 * claim — ordinary writing that must come through untouched, because a
 * redactor that eats prose leaves nothing worth pooling.
 */
const CASES: readonly {
  name: string;
  input: string;
  gone?: string;
  expect: RegExp;
}[] = [
  {
    name: "absolute posix path",
    input: "read /Users/polpedu/Projects/token-forecaster/README.md and summarise it",
    gone: "polpedu",
    expect: /read <path> and summarise it/,
  },
  {
    name: "home path",
    input: "the transcripts live in ~/.claude/projects",
    gone: ".claude",
    expect: /<path>/,
  },
  {
    name: "relative path with a dot prefix",
    input: "open ./src/lib/engine.ts",
    gone: "engine.ts",
    expect: /open <path>/,
  },
  {
    name: "repo-relative path with an extension",
    input: "packages/core/src/schemas.ts needs a superRefine",
    gone: "schemas.ts",
    expect: /^<path> needs a superRefine$/,
  },
  {
    name: "windows drive path",
    input: String.raw`copy C:\Users\Bob\notes.txt somewhere`,
    gone: "Bob",
    expect: /copy <path> somewhere/,
  },
  {
    name: "url",
    input: "fetch https://internal.example.com/api/v2/orders?id=7 please",
    gone: "internal.example.com",
    expect: /fetch <url> please/,
  },
  {
    name: "email",
    input: "mail the report to ada@example.org when it is done",
    gone: "ada@example.org",
    expect: /to <email> when/,
  },
  {
    name: "bare hostname with no scheme",
    input: "the box answers at 35-241-203-56.sslip.io/healthz now",
    gone: "35-241-203-56",
    expect: /answers at <url> now/,
  },
  {
    name: "bare ipv4 with a port",
    input: "ssh to 10.11.12.13:2222 and restart it",
    gone: "10.11.12.13",
    expect: /ssh to <url> and restart/,
  },
  {
    name: "email at an ip host",
    input: "ops@10.0.0.4 gets the alert",
    gone: "10.0.0.4",
    expect: /^<email> gets the alert$/,
  },
  {
    name: "a dashed uuid",
    input: "session 019fc42c-6ae7-7e41-914a-b6d5072bd5d0 stalled",
    gone: "019fc42c",
    expect: /session <hex> stalled/,
  },
  {
    name: "a secret assigned to an env var",
    input: `TF_INGEST_TOKEN=${"Zq7".repeat(20)} in the unit file`,
    gone: "Zq7Zq7Zq7",
    expect: /<(?:b64|secret)>/,
  },
  {
    name: "long hex",
    input: "the digest is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    gone: "9f86d081",
    expect: /digest is <hex>/,
  },
  {
    name: "base64 run",
    input: "payload eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9AAbbCC112233445566 ends here",
    gone: "eyJhbGciOiJIUzI1NiIs",
    expect: /payload <b64> ends here/,
  },
  {
    name: "anthropic key",
    input: "export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
    gone: "sk-ant-api03",
    expect: /<secret>/,
  },
  {
    name: "openai-shaped key",
    input: "the key sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345 is in the env",
    gone: "AbCdEfGhIjKlMnOp",
    expect: /the key <secret> is in the env/,
  },
  {
    name: "github token",
    input: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 was leaked",
    gone: "ghp_AbCdEf",
    expect: /<secret> was leaked/,
  },
  {
    name: "slack token",
    input: "xoxb-1234567890-abcdefghij is the bot token",
    gone: "xoxb-1234567890",
    expect: /<secret>/,
  },
  {
    name: "aws access key id",
    input: "AKIAIOSFODNN7EXAMPLE belongs to the CI role",
    gone: "AKIAIOSFODNN7EXAMPLE",
    expect: /<secret> belongs/,
  },
  {
    name: "bearer header",
    input: "curl -H 'Authorization: Bearer abcdef0123456789ghij' the endpoint",
    gone: "abcdef0123456789ghij",
    expect: /Bearer <secret>/,
  },
  {
    name: "password assignment",
    input: "set password=hunter2horse in the config",
    gone: "hunter2horse",
    expect: /password=<secret>/,
  },
  {
    name: "private key block",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\n7q0\n-----END RSA PRIVATE KEY-----",
    gone: "MIIEowIBAAKCAQEAx",
    expect: /^<secret>$/,
  },
];

const GUARDS: readonly { name: string; input: string }[] = [
  { name: "a semantic version", input: "bump the package to 1.2.3 before release" },
  { name: "a slash in prose", input: "the a/b test and the and/or case both pass" },
  { name: "an abbreviation", input: "use a short name, e.g. the module id" },
  { name: "a short hex word", input: "the sentinel value is deadbeef, not zero" },
  { name: "a bare filename", input: "schemas.ts is where the enum lives" },
  { name: "ordinary code", input: "call redactPromptText(text) and read counts.path" },
  { name: "a fraction", input: "about 1/3 of the calls stop at max_tokens" },
  { name: "a date", input: "written on 2026-09-04 by the reviewer" },
  { name: "a method call ending in a TLD", input: "call parts.append(x) then array.concat(y)" },
  { name: "a three-part version", input: "node 22.14.0 is the floor" },
];

describe("redactPromptText", () => {
  for (const testCase of CASES) {
    it(`removes ${testCase.name}`, () => {
      const { text } = redactPromptText(testCase.input);
      expect(text).toMatch(testCase.expect);
      if (testCase.gone) expect(text).not.toContain(testCase.gone);
    });
  }

  for (const guard of GUARDS) {
    it(`keeps ${guard.name}`, () => {
      const { text, counts } = redactPromptText(guard.input);
      expect(text).toBe(guard.input);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
    });
  }

  it("counts each class separately", () => {
    const { counts } = redactPromptText(
      "see https://example.com/a and /etc/hosts and mail ada@example.org",
    );
    expect(counts).toMatchObject({ url: 1, path: 1, email: 1 });
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = redactPromptText("open /Users/x/a.ts then mail ada@example.org").text;
    const twice = redactPromptText(once);
    expect(twice.text).toBe(once);
    expect(Object.values(twice.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

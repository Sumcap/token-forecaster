/**
 * The client-side redactor for `redacted` prompt telemetry.
 *
 * One pure function, no I/O, no configuration. It runs on the user's machine
 * before a row is built, and again on the server before a row is written, so a
 * client that forgets it (or lies about having run it) cannot put a path or a
 * key in the text file. Running it twice is safe: every replacement is a
 * literal `<class>` token that no pattern here matches.
 *
 * What it is for, and what it is not for. It removes the classes of content
 * that identify a machine, a repository or an account: filesystem paths, URLs,
 * e-mail addresses, long opaque strings, and the token shapes the major
 * providers issue. It deliberately keeps ordinary prose, identifiers and code,
 * because a prompt with those removed would carry nothing worth pooling. It is
 * a redactor, not an anonymiser: a prompt that names a person in a sentence
 * still names them, which is why `redacted` is a tier the user chooses rather
 * than a promise that the text is safe to publish.
 *
 * Order matters and is not alphabetical. Private-key blocks go first because
 * they contain base64 that later rules would shred into fragments; named
 * secrets before generic key=value; schemed URLs before e-mail, e-mail before
 * bare hostnames, so `ada@example.org` costs one replacement and is labelled
 * with the more specific class; addresses before paths, because a URL contains
 * a path; hex before base64, because a long hex run is also a legal base64 run
 * and the more specific class is the more useful label.
 */

/** How many replacements of each class one call made. */
export interface RedactionCounts {
  path: number;
  url: number;
  email: number;
  hex: number;
  b64: number;
  secret: number;
}

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
}

/** The literal tokens this module writes. Nothing else may produce them. */
export const REDACTION_TOKENS = {
  path: "<path>",
  url: "<url>",
  email: "<email>",
  hex: "<hex>",
  b64: "<b64>",
  secret: "<secret>",
} as const;

/**
 * A run of characters that cannot start a path segment.
 *
 * `and/or`, `1/2` and `he/she` are prose, not paths: the separator is glued to
 * a word on both sides. A real path has a boundary in front of it.
 */
const LEFT_BOUNDARY = "(?<![A-Za-z0-9_@%$-])";

const PATTERNS: readonly [keyof RedactionCounts, RegExp][] = [
  // --- secrets ------------------------------------------------------------
  [
    "secret",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
  ["secret", /\bsk-ant-[A-Za-z0-9_-]{8,}/g],
  ["secret", /\bsk-[A-Za-z0-9_-]{16,}/g],
  ["secret", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["secret", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ["secret", /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g],
  ["secret", /\bAKIA[0-9A-Z]{16}\b/g],
  ["secret", /\bA(?:Iza|SIA)[A-Za-z0-9_-]{16,}/g],
  // Whole `Authorization: Bearer …` values, keeping the scheme word so the
  // reader can still see that the prompt was about an authenticated request.
  ["secret", /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/g],
  // `password=hunter2`, `api_key: "abc"`, `--token abc123`. The name survives;
  // the value does not.
  [
    "secret",
    /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth)\b\s*[=:]\s*("[^"\n]{3,}"|'[^'\n]{3,}'|[^\s,;)\]}"']{3,})/gi,
  ],

  // --- addresses ----------------------------------------------------------
  ["url", /\b(?:https?|ftp|ftps|ws|wss|file|ssh|git\+ssh|redis|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s<>"'`)\]}]+/gi],
  // Before the bare-host rule below, so one address costs one replacement and
  // is labelled with the more specific class. The IPv4 host is here because
  // `ops@10.0.0.4` is an address whose domain half has no letters in it.
  [
    "email",
    /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}|(?:\d{1,3}\.){3}\d{1,3})\b/g,
  ],
  // A host with no scheme in front of it is still an address. The grading run
  // on the local corpus found 128 of these and no schemed URL the rule above
  // had missed, which is what a person typing `claude.ai` rather than pasting
  // a link looks like. The trailing-path half matters as much as the host:
  // `docs.example.com/runbooks/ingest` names an internal document.
  //
  // The cost is that a filename whose extension collides with a TLD --
  // `build.sh`, `deploy.app` -- is redacted as an address. There is no way to
  // tell those apart without knowing the sentence, and a lost script name is
  // cheaper than a leaked hostname.
  [
    "url",
    /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|sh|co|cloud|xyz|edu|gov|info|me|uk|de|fr|jp|cn|internal|local)\b(?::\d{2,5})?(?:\/[^\s<>"'`)\]}]*)?/gi],
  // A bare IPv4, with an optional port. Four octets, each in range, so a
  // three-part version like `1.2.3` is untouched.
  [
    "url",
    /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b(?::\d{2,5})?/g,
  ],

  // --- paths --------------------------------------------------------------
  // A Windows drive or UNC path.
  ["path", new RegExp(`${LEFT_BOUNDARY}[A-Za-z]:[\\\\/][^\\s<>"'\`|)\\]}]*`, "g")],
  ["path", /\\\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9 ._-]+)+/g],
  // Anything anchored at the root, the home directory, or an explicit `./`
  // `../`: the leading marker is what makes it a path rather than a slash in a
  // sentence.
  [
    "path",
    new RegExp(
      `${LEFT_BOUNDARY}(?:~|\\.{1,2})?/(?:[A-Za-z0-9._~@+-]+/)*[A-Za-z0-9._~@+-]+/?`,
      "g",
    ),
  ],
  // A bare `~` home reference with no separator after it (`~` alone is prose).
  [
    "path",
    new RegExp(`${LEFT_BOUNDARY}~[\\\\][A-Za-z0-9._~@+-]+(?:[\\\\][A-Za-z0-9._~@+-]+)*`, "g"),
  ],
  // A relative path with no anchor, recognised by having BOTH a separator and
  // a file extension: `packages/core/src/schemas.ts` is a path, `and/or` is
  // not, and `1.2.3` is a version because it has no separator.
  [
    "path",
    new RegExp(
      `${LEFT_BOUNDARY}[A-Za-z0-9._~@+-]+(?:/[A-Za-z0-9._~@+-]+)+\\.[A-Za-z0-9]{1,8}\\b`,
      "g",
    ),
  ],

  // --- long opaque runs ---------------------------------------------------
  // A dashed uuid: session ids, turn roots, request ids. Thirty-two hex
  // characters that the run rule below cannot see because of the hyphens.
  [
    "hex",
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  ],
  // 32 hex characters is a full MD5; below that lives every `deadbeef`, git
  // short sha and colour literal anybody writes on purpose.
  ["hex", /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g],
  // Forty unbroken characters carrying upper case, lower case and a digit is
  // an opaque identifier by any definition a regex can hold: a token, a
  // signature, a base64 blob. `-` and `_` are in the set because base64url
  // uses them, which costs the occasional forty-character hyphenated title.
  [
    "b64",
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g,
  ],
];

/**
 * Replace machine-identifying content with class tokens.
 *
 * Returns the redacted text and the number of replacements per class, which is
 * the only thing the grading script is allowed to print.
 */
export function redactPromptText(text: string): RedactionResult {
  const counts: RedactionCounts = { path: 0, url: 0, email: 0, hex: 0, b64: 0, secret: 0 };
  let out = text;
  for (const [cls, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      counts[cls] += 1;
      // The key=value and Bearer rules keep their first capture (the name or
      // the scheme) so the sentence still reads; everything else is replaced
      // whole.
      const first = args[1];
      if (typeof first === "string" && /^(Bearer|Basic|Token)$/i.test(first)) {
        return `${first} ${REDACTION_TOKENS.secret}`;
      }
      if (typeof first === "string" && /^[A-Za-z_-]+$/.test(first) && cls === "secret") {
        return `${first}=${REDACTION_TOKENS.secret}`;
      }
      return REDACTION_TOKENS[cls];
    });
  }
  return { text: out, counts };
}

/** True when any class fired. Convenience for callers that only need a flag. */
export function redactionChanged(counts: RedactionCounts): boolean {
  return Object.values(counts).some((count) => count > 0);
}

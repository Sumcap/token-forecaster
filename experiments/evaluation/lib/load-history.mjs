/**
 * Shared loader for Claude Code transcript history.
 *
 * Collapses assistant rows to one record per requestId so every probe in this
 * directory describes the same population. Extracted from
 * probe-latent-structure.mjs so that the population definition lives in exactly
 * one place -- two probes that disagree about what a "call" is would make their
 * numbers incomparable.
 *
 * Privacy: character counts of content are computed and discarded. No prompt or
 * response text is retained on the returned records. `withPromptFeatures` adds
 * a handful of BOOLEAN AND BUCKETED derivations of the human message -- length
 * bucket, verb class, whether a path was named -- computed in the same pass and
 * discarded just as the character counts are. Nothing that could reconstruct a
 * word of the prompt leaves this module. That is the same contract the existing
 * `chars` accounting has kept since the loader was extracted, and it is what
 * house rule 9 ("aggregates only in committed artifacts") requires: the rule
 * governs what an artifact STORES, not what a local pass may read from a file
 * already on disk.
 */

import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

export const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

// ---------------------------------------------------------------------------
// Prompt features.
//
// Everything below turns one human message into a fixed set of buckets and
// booleans. It runs inside the scan and the text is never returned, never
// stored on a record, and never written to an artifact.
//
// A "user" row in a Claude Code transcript is not necessarily a human speaking.
// 708 of the 2,532 non-tool-result user rows in this corpus are `isMeta`, and
// many of the rest wrap harness output -- a slash command's stdout, a task
// notification, a queued system message -- in tags. Featurising those as if a
// person had typed them would put harness noise in the model's most important
// input, so they are stripped first and a row with nothing left is treated as
// ABSENT rather than as an empty prompt. Unknown is not a level.
// ---------------------------------------------------------------------------

/** Wrapper tags Claude Code injects around non-human content. */
const HARNESS_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "command-name",
  "command-message",
  "command-args",
  "task-notification",
  "task-id",
  "summary",
  "output-file",
  "status",
  "tool-use-id",
  "name",
  "event",
  "note",
  "user-prompt-submit-hook",
];
const HARNESS_BLOCK = new RegExp(
  `<(${HARNESS_TAGS.join("|")})>[\\s\\S]*?<\\/\\1>`,
  "g",
);
const HARNESS_STRAY = new RegExp(`<\\/?(${HARNESS_TAGS.join("|")})>`, "g");

// Bags of verbs, scored by match count rather than first-match-wins: an ordered
// cascade would make the class depend on the order the regexes happen to be
// listed in, which is a decision the data should make instead.
const VERB_CLASSES = [
  [
    "write",
    /\b(write|create|implement|add|build|generate|draft|scaffold|set up|make)\b/g,
  ],
  [
    "fix",
    /\b(fix|debug|repair|correct|resolve|patch|refactor|rename|update|change|modify|improve)\b/g,
  ],
  [
    "explain",
    /\b(explain|why|describe|summari[sz]e|compare|what is|what does|how does|tell me about|understand)\b/g,
  ],
  [
    "read",
    /\b(read|show|list|find|search|look at|inspect|review|grep|check|where is|which)\b/g,
  ],
  [
    "run",
    /\b(run|execute|test|deploy|install|start|launch|verify)\b/g,
  ],
];

/** "in one sentence", "20 examples", "be brief" -- an explicit cap on output. */
const LIMIT_PATTERNS = [
  /\bin (one|a|two|three|1|2|3) (sentences?|lines?|paragraphs?|words?)\b/,
  /\b(brief|briefly|concise|concisely|short|shortly|tl;?dr|one[- ]liner|succinct)\b/,
  /\b\d{1,3}\s+(examples?|items?|tests?|lines?|words?|options?|ideas?|bullets?|sentences?|paragraphs?|cases?)\b/,
  /\b(no more than|at most|keep it|limit(ed)? to|just the|only the)\b/,
];
/** The opposite instruction, which should push output the other way. */
const EXPANSIVE_PATTERNS = [
  /\b(exhaustive|exhaustively|comprehensive|comprehensively|thorough|thoroughly|in depth|in-depth|detailed|deep dive|complete(ly)?|full(y)?|everything|all of|step by step|step-by-step)\b/,
];
const PATH_PATTERN =
  /(\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|c|h|hpp|cpp|sh|zsh|yml|yaml|toml|css|scss|html|sql|txt|lock)\b|\b(src|lib|packages|apps|docs|experiments|fixtures|research|tests?|scripts?)\/)/;
const QUESTION_OPENER =
  /^(what|why|how|when|where|who|which|is|are|was|were|does|do|did|can|could|should|would|will|has|have|any)\b/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+\S/;

// These are deliberately coarse. They describe the deliverable requested by
// the human, not the action the assistant eventually chose. The latter is a
// post-call label and may only be used as an oracle/target in experiments.
const FORMAT_PATTERNS = [
  ["json", /\b(json|jsonl|schema|structured output)\b/],
  ["table", /\b(table|matrix|spreadsheet|csv|tsv)\b/],
  ["list", /\b(list|bullets?|checklist|ranked|options?)\b/],
  ["code", /\b(code|implementation|patch|diff|function|class|component|endpoint|script|test suite)\b/],
  ["document", /\b(report|document|readme|guide|proposal|spec(?:ification)?|memo|email|post|article)\b/],
];
const ARTIFACT_VERB =
  /\b(write|rewrite|re-write|redo|re-do|create|implement|add|build|generate|draft|scaffold|make|fix|repair|patch|refactor|update|updating|change|modify)\b/;
const ARTIFACT_NOUN =
  /\b(file|code|component|endpoint|script|tests?|docs?|document|report|readme|guide|proposal|spec(?:ification)?|app|page|module|package|config(?:uration)?|migration|schema)\b/;
const EXPLICIT_FILE_ACTION =
  /\b(write|rewrite|re-write|redo|re-do|save|create|generate|edit|modify|update|updating|patch|replace|append)\b[^.!?\n]{0,80}\b(file|to|into|at|under)\b/;

// Compression follow-up ("shrink what you just said"), as opposed to the corpus
// sense of "summarize X" ("go read X, then write a long analysis"). Exact
// training-side mirror of isFollowupCompression() in predictor/src/boosted.ts;
// the two must stay identical or the v3 feature means different things either
// side of the gate.
const FOLLOWUP_COMPRESSION_MAX_CHARS = 80;
const COMPRESSION_VERB =
  /\b(summari[sz]e|summari[sz]ing|condense|shorten|compress|recap|tl;?dr)\b/;
const MAKE_IT_SHORTER =
  /\bmake (it|this|that) (shorter|smaller|briefer|tighter|concise|more concise|less verbose)\b/;
const ANAPHORIC_OBJECT =
  /^(it|that|this|these|those|them|the above|all of (it|that|the above)|the (last|previous) (message|answer|reply|response|one)|your (last )?(answer|reply|response|message))\b/;
const COMPRESSION_MODIFIER =
  /^(even|much|way|a|an|the|bit|lot|lots|more|further|again|please|pls|now|down|up|hard|harder|short|shorter|small|smaller|brief|briefly|concise|concisely|tight|tighter|less|half|just|really|very|super|so|and|but|then|to|into|in|for|of|as|possible|me|us|ok|okay|thanks|thank|you|one|two|three|couple|few|\d{1,3}|sentences?|lines?|words?|paragraphs?|bullets?|points?)$/;

function isModifierOnly(text) {
  const words = text.toLowerCase().match(/[a-z0-9;']+/g) ?? [];
  return words.every((word) => COMPRESSION_MODIFIER.test(word));
}

function followupCompression(text, lower, mentionsPath) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > FOLLOWUP_COMPRESSION_MAX_CHARS) {
    return false;
  }
  if (mentionsPath || ARTIFACT_NOUN.test(lower)) return false;
  if (MAKE_IT_SHORTER.test(lower)) return true;
  const verb = COMPRESSION_VERB.exec(lower);
  if (verb === null) return false;
  const tail = lower
    .slice(verb.index + verb[0].length)
    .replace(/^[\s,:;.!?-]+/, "")
    .trim();
  const anaphor = ANAPHORIC_OBJECT.exec(tail);
  const rest = anaphor === null ? tail : tail.slice(anaphor[0].length);
  if (anaphor === null && tail.length > 0 && !isModifierOnly(tail)) return false;
  return isModifierOnly(rest);
}

/** Fixed-width hashing trick: useful locally, but never written to artifacts. */
const SEMANTIC_HASH_WIDTH = 512;
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function semanticHashFeatures(lower, namespace = "") {
  const words = lower.match(/[\p{L}\p{N}_][\p{L}\p{N}_.\/-]*/gu) ?? [];
  const counts = new Map();
  const add = (term) => {
    const hash = fnv1a(term);
    const index = hash % SEMANTIC_HASH_WIDTH;
    const sign = hash & 0x80000000 ? -1 : 1;
    counts.set(index, (counts.get(index) ?? 0) + sign);
  };
  for (let index = 0; index < words.length; index++) {
    add(`${namespace}u:${words[index]}`);
    if (index > 0) add(`${namespace}b:${words[index - 1]} ${words[index]}`);
  }
  return [...counts.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([left], [right]) => left - right)
    .map(([index, value]) => [index, Math.sign(value) * Math.log1p(Math.abs(value))]);
}

function mergeSemanticHash(target, features) {
  for (const [index, value] of features) {
    target.set(index, (target.get(index) ?? 0) + value);
  }
}

function finishSemanticHash(values) {
  return [...values.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([left], [right]) => left - right);
}

// Transient fingerprints of paths already present in tool inputs/results. They
// let an evaluator ask whether the agent resolved a vague prompt onto a real
// file before the next call. Only counts and equality survive; path text never
// leaves the loader and no fingerprint is written to a report/profile.
const STRUCTURED_PATH_KEYS = new Set([
  "file_path",
  "filepath",
  "notebook_path",
  "path",
  "directory",
  "cwd",
]);
const RESULT_PATH_PATTERN =
  /(?:^|[\s"'`([{])((?:\/|~\/|\.{1,2}\/)?(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+|[\p{L}\p{N}_.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|c|h|hpp|cpp|sh|zsh|yml|yaml|toml|css|scss|html|sql|txt|lock))/gimu;

function pathFingerprint(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/").replace(/:\d+(?::\d+)?$/, "");
  if (!normalized || normalized.length > 2_048) return null;
  return createHash("sha256")
    .update(`token-forecaster-resolved-path\0${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

function structuredPathFingerprints(input) {
  const found = new Set();
  const visit = (value, key = "", depth = 0) => {
    if (depth > 6 || found.size >= 256 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (STRUCTURED_PATH_KEYS.has(key.toLowerCase())) {
        const fingerprint = pathFingerprint(value);
        if (fingerprint) found.add(fingerprint);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey, depth + 1);
      }
    }
  };
  visit(input);
  return found;
}

function resultPathFingerprints(payload) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const found = new Set();
  RESULT_PATH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(RESULT_PATH_PATTERN)) {
    const fingerprint = pathFingerprint(match[1]);
    if (fingerprint) found.add(fingerprint);
    if (found.size >= 256) break;
  }
  return found;
}

function requestedFormat(lower) {
  const matches = FORMAT_PATTERNS.filter(([, pattern]) => pattern.test(lower));
  return matches.length === 1 ? matches[0][0] : matches.length > 1 ? "mixed" : "unspecified";
}

function deliverableType(lower, mentionsPath, format) {
  const artifactIntent =
    EXPLICIT_FILE_ACTION.test(lower) ||
    (ARTIFACT_VERB.test(lower) && (ARTIFACT_NOUN.test(lower) || mentionsPath));
  if (artifactIntent) return "artifact";
  if (format === "json" || format === "table") return "structured";
  if (format === "document" || format === "code") return format;
  if (/\b(explain|why|summari[sz]e|compare|review|investigate|analy[sz]e)\b/.test(lower)) {
    return "analysis";
  }
  if (/\b(run|execute|test|deploy|install|start|launch|verify|check)\b/.test(lower)) {
    return "operation";
  }
  return "other";
}

const lengthBucket = (chars) =>
  chars < 80 ? "lt80" : chars < 300 ? "80-300" : chars < 1200 ? "300-1200" : "gte1200";
const requirementBucket = (count) =>
  count <= 1 ? "1" : count <= 3 ? "2-3" : count <= 7 ? "4-7" : "gte8";

/**
 * Reduce one human message to features. Returns null when the row carries no
 * human text at all once harness wrappers are removed -- callers must treat
 * that as "no prompt observed" and SKIP the rung, never as a level.
 */
export function derivePromptFeatures(rawText) {
  if (typeof rawText !== "string") return null;
  const text = rawText
    .replace(HARNESS_BLOCK, " ")
    .replace(HARNESS_STRAY, " ")
    .trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  let verbClass = "other";
  let bestScore = 0;
  let tied = false;
  for (const [name, pattern] of VERB_CLASSES) {
    pattern.lastIndex = 0;
    const score = (lower.match(pattern) ?? []).length;
    if (score > bestScore) {
      bestScore = score;
      verbClass = name;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  // A tie is genuinely ambiguous ("fix the tests and explain why"), and calling
  // it for whichever class sorted first would be inventing information.
  if (bestScore === 0 || tied) verbClass = "other";

  const lines = text.split("\n");
  const listItems = lines.filter((line) => LIST_ITEM.test(line)).length;
  const sentences = text
    .split(/[.!?\n]+/)
    .filter((part) => part.trim().length > 2).length;
  const requirements = Math.max(listItems, Math.min(sentences, 20), 1);

  const firstSentence = lower.split(/[.!?\n]/, 1)[0]?.trim() ?? "";
  const mentionsPath = PATH_PATTERN.test(text);
  const format = requestedFormat(lower);
  const artifactIntent =
    EXPLICIT_FILE_ACTION.test(lower) ||
    (ARTIFACT_VERB.test(lower) && (ARTIFACT_NOUN.test(lower) || mentionsPath));

  return {
    chars: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    lengthBucket: lengthBucket(text.length),
    verbClass,
    hasLimit: LIMIT_PATTERNS.some((p) => p.test(lower)),
    hasExpansive: EXPANSIVE_PATTERNS.some((p) => p.test(lower)),
    mentionsPath,
    isQuestion: text.endsWith("?") || QUESTION_OPENER.test(firstSentence),
    requirements,
    requirementBucket: requirementBucket(requirements),
    requestedFormat: format,
    deliverableType: deliverableType(lower, mentionsPath, format),
    artifactIntent,
    followupCompression: followupCompression(text, lower, mentionsPath),
    // A hash-only prompt identity supports within-turn/session calibration
    // without retaining reconstructable prompt text.
    promptHash: createHash("sha256").update(text).digest("hex"),
    // Transient hashed unigrams/bigrams for semantic experiments. Probe
    // reports must summarize model performance, never serialize this array.
    semanticHash: semanticHashFeatures(lower),
  };
}

/**
 * Pull the human text out of a user row, whatever shape it is in. Measured over
 * this corpus: 2,192 rows carry a bare string, 261 an array of `text` blocks,
 * 79 an array mixing `image` and `text`.
 */
function userText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

export const defaultProjectsDir = () =>
  path.join(homedir(), ".claude", "projects");

// Artifacts are committed to a public repo, so a path that starts inside the
// operator's home directory is rewritten to `~` before it is serialized. The
// read path is untouched: only what we PUBLISH is redacted.
export const redactHome = (p) => {
  const home = homedir();
  return typeof p === "string" && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

// Workload ids end up in committed artifacts, and the directory names they are
// derived from are short and guessable, so an unsalted digest is a dictionary
// attack that discloses local project paths. Default to a salt that is random
// per run: ids stay comparable inside one report, which is all any consumer of
// them needs, and mean nothing outside it. Set TOKEN_FORECASTER_STUDY_SALT to a
// value you keep out of the repo when you want ids that line up ACROSS
// regenerations, e.g. to track one workload over several corpus endpoints.
let runSalt = null;
const studySalt = () => {
  const configured = process.env.TOKEN_FORECASTER_STUDY_SALT;
  if (configured) return configured;
  if (runSalt === null) {
    runSalt = randomUUID();
    console.warn(
      "[load-history] TOKEN_FORECASTER_STUDY_SALT is not set: workload ids are " +
        "random for this run and will not match previous artifacts.",
    );
  }
  return runSalt;
};

async function* jsonlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

/**
 * Load one record per API call, MERGING the rows that make it up.
 *
 * `options.withLoopContext` additionally reconstructs the agent loop each call
 * sits in, by following `parentUuid` back through the `tool_result` rows that
 * answer the previous call. It attaches `parentRequestId` (the ACTUAL preceding
 * step, not "whatever was nearest in time"), `loopDepth`, and the size and error
 * flag of the results this call is responding to. Off by default, so the
 * population and cost of every existing probe are unchanged.
 *
 * Ordering by timestamp within a sessionId would have been the cheap way to get
 * a "previous call", and it is wrong here: sidechains run concurrently with the
 * main chain and share a session, so a subagent's call would be handed a parent
 * it never saw. The parent link is what the transcript actually records.
 *
 * Privacy: result content is measured and discarded, exactly like message text.
 *
 * Claude Code writes one JSONL row per emitted content block, all sharing a
 * requestId, and repeats the call's total `output_tokens` on every one of them.
 * Measured over this corpus: all 9,265 multi-row requests are one-block-per-row
 * and 8,529 of them carry an identical output_tokens on every row.
 *
 * The previous rule here ("keep the largest observation per requestId, usage
 * accumulates as it streams") was wrong on both counts -- usage does not
 * accumulate, and with ties broken by `>=` it kept the FIRST row, which for a
 * thinking-enabled call is the zero-length `thinking` block. That discarded the
 * text and tool_use blocks of 7,650 calls while keeping the whole call's token
 * count, which made stored content look far smaller than billed output.
 *
 * The correct reconstruction is a union over the call's distinct rows, keyed by
 * entry uuid so a duplicated row cannot double-count.
 */
export async function loadRequests(projectsDir = defaultProjectsDir(), options = {}) {
  // Prompt features need the ancestry walk to reach the turn root, so asking
  // for them implies loop context rather than silently returning nulls.
  const { withPromptFeatures = false, withResolvedFileContext = false } = options;
  const withLoopContext =
    options.withLoopContext || withPromptFeatures || withResolvedFileContext;
  const requests = new Map();
  // uuid -> { parentUuid, kind, chars, isError, timestampMs } for every non-call
  // row on the conversation chain, and uuid -> requestId for every assistant row.
  // Links may cross files when a session is resumed, so both are resolved after
  // the scan rather than inline.
  const chainRows = withLoopContext ? new Map() : null;
  const uuidToRequest = withLoopContext ? new Map() : null;
  let filesScanned = 0;

  for await (const file of jsonlFiles(projectsDir)) {
    filesScanned++;
    const relative = path.relative(projectsDir, file);
    const workloadRoot = relative.split(path.sep)[0] || "(root)";
    // The published artifacts group per workload. Without a secret salt the
    // digest is a dictionary attack over a short list of plausible directory
    // names, so a published id leaks the operator's project paths. Same rule
    // the shipped telemetry package already enforces: no salt, no hash.
    const workloadId = createHash("sha256")
      .update(`token-forecaster-workload\0${studySalt()}\0${workloadRoot}`)
      .digest("hex")
      .slice(0, 16);
    const lines = createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const isAssistantUsage =
        line.includes('"assistant"') && line.includes("output_tokens");
      // Loop reconstruction has to index EVERY row that can appear on the chain,
      // not just user rows. 2,236 assistant calls in this corpus hang off an
      // `attachment` row (a skill listing, a tool-registry delta) -- transcript
      // decoration, not a conversation step. Treating an unindexed row as a
      // broken chain lost the ancestry of one call in six.
      if (!isAssistantUsage && !withLoopContext) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (withLoopContext && entry.type !== "assistant") {
        if (!entry.uuid || chainRows.has(entry.uuid)) continue;
        let kind = "passthrough";
        let chars = 0;
        let isError = false;
        let prompt = null;
        const resolvedPathHashes = new Set();
        const resolvedSemanticHash = new Map();
        if (entry.type === "user") {
          // A user row carrying tool results continues the loop; a user row that
          // does not is a human speaking, which RESTARTS it. Collapsing the two
          // would make every turn look like one endless loop.
          kind = "userMessage";
          const content = Array.isArray(entry.message?.content)
            ? entry.message.content
            : [];
          for (const block of content) {
            if (!block || block.type !== "tool_result") continue;
            kind = "toolResult";
            const payload = block.content;
            chars +=
              typeof payload === "string"
                ? payload.length
                : JSON.stringify(payload ?? "").length;
            if (block.is_error === true) isError = true;
            if (withResolvedFileContext) {
              for (const fingerprint of resultPathFingerprints(payload)) {
                resolvedPathHashes.add(fingerprint);
              }
              const semanticText =
                typeof payload === "string"
                  ? payload
                  : JSON.stringify(payload ?? "");
              mergeSemanticHash(
                resolvedSemanticHash,
                semanticHashFeatures(semanticText.toLowerCase(), "result:"),
              );
            }
          }
          // `isMeta` rows are harness injections (most often a loaded skill),
          // not a new human turn. They can appear halfway through an existing
          // tool loop: treating one as a `userMessage` boundary cuts ancestry
          // off at the skill and loses the real human prompt that preceded it.
          // Keep walking through it exactly like an attachment. Slash-command
          // rows such as /clear are not `isMeta`; after their wrappers are
          // stripped they remain genuine prompt-less turn boundaries.
          if (kind === "userMessage" && entry.isMeta) {
            kind = "passthrough";
          } else if (kind === "userMessage" && withPromptFeatures) {
            prompt = derivePromptFeatures(userText(entry));
          }
        }
        // Two turn-root observations invisible to derivePromptFeatures: the
        // slash-command name (stripped as a harness wrapper before featurising,
        // so command turns have carried NO prompt signal until now) and whether
        // the human attached an image. Both are strictly pre-call and neither
        // retains a word of content -- a command name is a harness identifier.
        let commandName = null;
        let hasImage = null;
        if (kind === "userMessage" && withPromptFeatures) {
          const raw = userText(entry);
          commandName =
            typeof raw === "string"
              ? (raw.match(/<command-name>\s*(\/?[\w:-]+)/)?.[1] ?? "none")
              : "none";
          hasImage = Array.isArray(entry.message?.content)
            ? entry.message.content.some((block) => block?.type === "image")
            : false;
        }
        chainRows.set(entry.uuid, {
          parentUuid: entry.parentUuid ?? null,
          kind,
          chars,
          isError,
          prompt,
          commandName,
          hasImage,
          resolvedPathHashes: [...resolvedPathHashes],
          resolvedSemanticHash: finishSemanticHash(resolvedSemanticHash),
          timestampMs: Date.parse(entry.timestamp ?? ""),
        });
        continue;
      }
      if (entry.type !== "assistant") continue;
      if (!isAssistantUsage) continue;
      const message = entry.message ?? {};
      const usage = message.usage ?? {};
      const model = message.model;
      if (!entry.requestId || typeof usage.output_tokens !== "number") continue;
      if (!model || model === "<synthetic>") continue;

      let record = requests.get(entry.requestId);
      if (!record) {
        record = {
          requestId: entry.requestId,
          outputTokens: usage.output_tokens,
          visibleChars: 0,
          // Split by block type: prose and dense JSON tokenize at different
          // rates, so estimating V needs them separately.
          textChars: 0,
          toolChars: 0,
          thinkingChars: 0,
          blockTypes: new Set(),
          tools: [],
          model,
          effort: entry.effort ?? null,
          sessionId: entry.sessionId ?? null,
          timestampMs: Date.parse(entry.timestamp ?? ""),
          stopReason: message.stop_reason ?? null,
          rows: 0,
          seenUuids: new Set(),
          workloadIds: new Set(),
          ...(withResolvedFileContext
            ? {
                toolPathHashes: new Set(),
                readPathHashes: new Set(),
                searchPathHashes: new Set(),
                mutationPathHashes: new Set(),
                assistantTextSemanticHash: new Map(),
                assistantThinkingSemanticHash: new Map(),
                toolInputSemanticHash: new Map(),
              }
            : {}),
        };
        requests.set(entry.requestId, record);
      }

      // A row repeated in the corpus (copied session file, resumed transcript)
      // must not contribute its blocks twice.
      const uuid = entry.uuid ?? `${entry.timestamp ?? ""}#${record.rows}`;
      if (record.seenUuids.has(uuid)) continue;
      record.seenUuids.add(uuid);
      record.workloadIds.add(workloadId);
      record.rows++;
      if (withLoopContext) {
        uuidToRequest.set(uuid, entry.requestId);
        // The call's rows form a chain among themselves; its link to the rest of
        // the conversation is the one parentUuid that is not one of its own rows.
        (record.parentCandidates ??= []).push(entry.parentUuid ?? null);
      }

      // output_tokens is the whole call's total, repeated per row; max is a
      // safe reducer for the few requests whose rows disagree.
      if (usage.output_tokens > record.outputTokens) {
        record.outputTokens = usage.output_tokens;
      }
      const timestamp = Date.parse(entry.timestamp ?? "");
      if (Number.isFinite(timestamp) && timestamp < record.timestampMs) {
        record.timestampMs = timestamp;
      }
      if (message.stop_reason) record.stopReason = message.stop_reason;
      if (record.effort === null && entry.effort) record.effort = entry.effort;

      // Visible content: everything the transcript stored, unioned across the
      // call's rows. Thinking blocks are retained as zero-length markers, which
      // is a genuine property of the transcript rather than an artifact.
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        record.blockTypes.add(block.type);
        if (block.type === "text") {
          const chars = (block.text ?? "").length;
          record.visibleChars += chars;
          record.textChars += chars;
          if (withResolvedFileContext) {
            mergeSemanticHash(
              record.assistantTextSemanticHash,
              semanticHashFeatures((block.text ?? "").toLowerCase(), "assistant:"),
            );
          }
        } else if (block.type === "tool_use") {
          const chars = JSON.stringify(block.input ?? {}).length;
          record.visibleChars += chars;
          record.toolChars += chars;
          if (block.name) record.tools.push(block.name);
          if (withResolvedFileContext) {
            mergeSemanticHash(
              record.toolInputSemanticHash,
              semanticHashFeatures(
                JSON.stringify(block.input ?? {}).toLowerCase(),
                "tool-input:",
              ),
            );
            const fingerprints = structuredPathFingerprints(block.input ?? {});
            for (const fingerprint of fingerprints) {
              record.toolPathHashes.add(fingerprint);
              if (block.name === "Read") record.readPathHashes.add(fingerprint);
              if (block.name === "Glob" || block.name === "Grep") {
                record.searchPathHashes.add(fingerprint);
              }
              if (
                block.name === "Edit" ||
                block.name === "Write" ||
                block.name === "NotebookEdit"
              ) {
                record.mutationPathHashes.add(fingerprint);
              }
            }
          }
        } else if (THINKING_BLOCK_TYPES.has(block.type)) {
          const chars = (block.thinking ?? block.data ?? "").length;
          record.visibleChars += chars;
          record.thinkingChars += chars;
          if (withResolvedFileContext) {
            mergeSemanticHash(
              record.assistantThinkingSemanticHash,
              semanticHashFeatures(
                String(block.thinking ?? block.data ?? "").toLowerCase(),
                "thinking:",
              ),
            );
          }
        }
      }
    }
  }

  if (withLoopContext) resolveLoopContext(requests, chainRows, uuidToRequest);
  for (const record of requests.values()) {
    delete record.seenUuids;
    const workloadIds = [...record.workloadIds].sort();
    record.workloadId =
      workloadIds.length === 1
        ? workloadIds[0]
        : workloadIds.length === 0
          ? null
          : createHash("sha256")
              .update(`token-forecaster-workload-set\0${workloadIds.join("\0")}`)
              .digest("hex")
              .slice(0, 16);
    delete record.workloadIds;
    if (withResolvedFileContext) {
      for (const field of [
        "toolPathHashes",
        "readPathHashes",
        "searchPathHashes",
        "mutationPathHashes",
      ]) {
        record[field] = [...record[field]].sort();
      }
      for (const field of [
        "assistantTextSemanticHash",
        "assistantThinkingSemanticHash",
        "toolInputSemanticHash",
      ]) {
        record[field] = finishSemanticHash(record[field]);
      }
    }
  }
  return { rows: [...requests.values()], filesScanned };
}

/** Longest tool_result chain we will follow before treating the link as broken. */
const MAX_PARENT_HOPS = 200;

/**
 * Attach, to every request: the request that preceded it in its own agent loop,
 * the size/error status of the tool results it is responding to, and how deep
 * into the loop it sits.
 *
 * A call's parent is a chain of `tool_result` user rows -- one per result, since
 * Claude Code writes a row per block -- ending at the assistant call that asked
 * for them. Walking that chain answers three questions at once: which call came
 * before, how much came back from it, and (by hitting a non-tool_result user row
 * instead) whether the loop restarted because a human said something.
 */
function resolveLoopContext(requests, chainRows, uuidToRequest) {
  for (const [requestId, record] of requests) {
    const own = record.seenUuids;
    const external = (record.parentCandidates ?? []).find(
      (uuid) => uuid !== null && !own.has(uuid),
    );
    delete record.parentCandidates;

    record.parentRequestId = null;
    record.resultChars = null;
    record.resultIsError = null;
    record.resultBlocks = 0;
    record.resultArrivedMs = null;
    record.resultPathHashes = [];
    record.resultSemanticHash = [];
    record.afterUserMessage = false;
    record.chainBroken = false;
    // Set here only for turn-OPENING calls, then propagated down the loop by
    // depthOf() below. See the note there for why that propagation is the whole
    // point of joining prompts at all.
    record.turnPrompt = null;
    record.turnRootId = null;
    record.turnCommand = null;
    record.turnHasImage = null;

    let uuid = external ?? null;
    if (uuid === null) continue;
    let chars = 0;
    let blocks = 0;
    let isError = false;
    let arrived = null;
    const resultPaths = new Set();
    const resultSemantic = new Map();
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
      const parentRequest = uuidToRequest.get(uuid);
      if (parentRequest !== undefined) {
        // Guard against a self-link surviving the "not one of my own rows" test
        // via a duplicated uuid in a resumed transcript.
        if (parentRequest !== requestId) record.parentRequestId = parentRequest;
        break;
      }
      const row = chainRows.get(uuid);
      if (row === undefined) {
        record.chainBroken = true;
        break;
      }
      if (row.kind === "userMessage") {
        record.afterUserMessage = true;
        record.turnPrompt = row.prompt ?? null;
        record.turnRootId = uuid;
        record.turnCommand = row.commandName ?? null;
        record.turnHasImage = row.hasImage ?? null;
        break;
      }
      if (row.kind === "toolResult") {
        chars += row.chars;
        blocks++;
        if (row.isError) isError = true;
        for (const fingerprint of row.resolvedPathHashes ?? []) {
          resultPaths.add(fingerprint);
        }
        mergeSemanticHash(resultSemantic, row.resolvedSemanticHash ?? []);
        // The LAST result to arrive is what unblocks the next call, so the
        // maximum is the moment the caller could have re-forecast.
        if (
          Number.isFinite(row.timestampMs) &&
          (arrived === null || row.timestampMs > arrived)
        ) {
          arrived = row.timestampMs;
        }
      }
      if (row.parentUuid === null) {
        record.chainBroken = true;
        break;
      }
      uuid = row.parentUuid;
    }
    if (blocks > 0) {
      record.resultChars = chars;
      record.resultIsError = isError;
      record.resultBlocks = blocks;
      record.resultArrivedMs = arrived;
      record.resultPathHashes = [...resultPaths].sort();
      record.resultSemanticHash = finishSemanticHash(resultSemantic);
    }
  }

  // Loop depth, memoised over the parent links. Depth 0 is a call that opens a
  // turn; depth d is a call answering the results of a depth d-1 call.
  //
  // `loopDepthExact` matters more than it looks. Roughly one call in seven has
  // an ancestor row missing from the transcript (compaction, a session copied
  // without its history), and such a call bottoms out at 0 while really sitting
  // somewhere mid-loop. Counting those as depth 0 would seed the shallowest
  // bucket -- the control group for the whole re-forecasting question -- with
  // deep-loop calls, which is exactly the direction that would fake a null
  // result. They are flagged so the analysis can hold them out.
  //
  // The same walk carries the TURN-ROOT PROMPT down the loop, and that is what
  // makes prompt features worth measuring at all. Only ~9% of calls open a turn,
  // so a depth-0-only join would leave the feature missing on nine calls in ten
  // and the ladder would fall through to `model|thinking` on almost everything.
  // But every call in a turn descends from exactly one human message, and that
  // message is strictly pre-call for all of them -- it was typed before the
  // first call in the turn was issued, let alone the twentieth. Inheriting it
  // makes the prompt a feature on ~100% of calls without using anything the
  // forecaster would not have had.
  const depthOf = (record, guard = 0) => {
    if (record.loopDepth !== undefined) return record;
    if (guard > MAX_PARENT_HOPS) {
      record.loopDepth = 0;
      record.loopDepthExact = false;
      return record;
    }
    record.loopDepth = 0; // cycle breaker: a corrupt link cannot recurse forever
    record.loopDepthExact = false;
    const parent =
      record.parentRequestId === null ? null : requests.get(record.parentRequestId);
    if (parent === undefined || parent === null) {
      record.loopDepth = 0;
      record.loopDepthExact = record.afterUserMessage && !record.chainBroken;
    } else {
      const resolved = depthOf(parent, guard + 1);
      record.loopDepth = resolved.loopDepth + 1;
      record.loopDepthExact = resolved.loopDepthExact;
      // A call that reached a human message itself keeps its own; otherwise it
      // inherits its ancestor's. Null stays null -- a truncated chain means the
      // turn root is UNKNOWN, and unknown must skip the rung.
      if (record.turnPrompt === null) record.turnPrompt = resolved.turnPrompt;
      if (record.turnRootId === null) record.turnRootId = resolved.turnRootId;
      if (record.turnCommand === null) record.turnCommand = resolved.turnCommand;
      if (record.turnHasImage === null) record.turnHasImage = resolved.turnHasImage;
    }
    return record;
  };
  for (const record of requests.values()) depthOf(record);
}

export const hasThinkingBlock = (row) =>
  [...row.blockTypes].some((type) => THINKING_BLOCK_TYPES.has(type));

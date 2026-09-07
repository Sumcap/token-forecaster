#!/usr/bin/env node
/**
 * LOCAL-ONLY exporter for the context/repository-signal turn-total probe
 * (docs/CONTEXT-SIGNALS-PLAN.md, Steps 1-2).
 *
 * Writes one JSONL row per EXACT turn: the turn total, the opener's metadata,
 * the 38 shipped v3 feature columns, the session-so-far family (S), the
 * repository-state family (R) and the post-hoc oracle family. The row holds
 * NUMBERS ONLY -- no prompt text, no file path, no directory name, no branch
 * name, no repository name, and no path fingerprint. Prompt text and paths are
 * read in memory to derive counts and are dropped inside this module.
 *
 * It still defaults to nothing and refuses any path inside the repository, the
 * same guard `export-turn-text.mjs` carries, because the population and the
 * per-turn totals are personal data even when the columns are aggregates.
 *
 * Population is identical to export-turn-text.mjs and probe-turn-total-boost.mjs
 * MINUS the "has prompt text" filter: every exact turn is exported, including
 * command turns and turns whose root carried no human text.
 *
 *   node experiments/evaluation/export-turn-context.mjs --out /tmp/.../ctx.jsonl
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import {
  defaultProjectsDir,
  hasThinkingBlock,
  loadRequests,
} from "./lib/load-history.mjs";
import { portableBoostFeatures } from "./lib/quantile-boost.mjs";

const args = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const projectsDir = argValue("--projects-dir", defaultProjectsDir());
const out = argValue("--out");
if (!out) throw new Error("--out is required (use the scratchpad)");
const repoRoot = path.resolve(process.cwd());
if (path.resolve(out).startsWith(repoRoot + path.sep)) {
  throw new Error(`refusing to write a per-turn export inside the repository: ${out}`);
}
const columnsOut = argValue("--columns-out");

const log = (message) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ---------------------------------------------------------------------------
// Column layout. Names only -- they are the report's vocabulary and are written
// to a side file so the probe can label the arms.
// ---------------------------------------------------------------------------

/**
 * Session-so-far (S).
 *
 * `callsSoFar` from the plan is DROPPED: the v3 vector's feature 7 is
 * log1p(sessionPosition)/6 and `sessionPosition` is exactly "calls completed in
 * this session before this call", which at a turn root is calls-so-far. It is
 * the only S column of the plan that duplicates an existing one; v3's
 * `loopDepth`, `priorCallCount`, `priorMaxOutputTokens` and `priorArtifactCount`
 * (features 8-11) are all identically zero at a turn root, so no S column
 * collides with them.
 */
const S_COLUMNS = [
  "s_turnsSoFar", // log1p(turn roots completed in this session) / 6
  "s_readSoFar", // log1p(distinct files read so far in this session) / 6
  "s_mutatedSoFar", // log1p(distinct files mutated so far) / 5
  "s_searchedSoFar", // log1p(distinct files searched so far) / 5
  "s_prevTurnMutated", // 1 if the previous turn mutated any file
  "s_prevTurnOutput", // log1p(previous turn's total output tokens) / 10
  "s_minutesSincePrevTurn", // min(minutes since the previous turn root, 240) / 240
  "s_prevTurnPresent", // 1 if there IS a previous turn in this session
  "s_present", // family presence bit
];

/** Repository state (R), reconstructed at the commit at/before the turn. */
const R_COLUMNS = [
  "r_fileCount", // log1p(tracked files) / 10
  "r_bytes", // log1p(tracked bytes) / 16
  "r_shareCode",
  "r_shareConfig",
  "r_shareDocs",
  "r_shareTests",
  "r_hasTests", // any test file or test directory
  "r_hasAgentDoc", // CLAUDE.md or AGENTS.md anywhere in the tree
  "r_commitCount", // log1p(commits reachable from that commit) / 10
  "r_daysSincePrevCommit", // min(days, 30) / 30
  "r_branchIsDefault", // 1 yes, 0 no, -1 unknown
  "r_draftPaths", // log1p(paths the prompt names) / 3
  "r_draftPathsExist", // log1p(named paths that exist at that commit) / 3
  "r_draftLargestBytes", // log1p(bytes of the largest existing named path) / 16
  "r_reconstructed", // 1 = counts come from a historical commit, 0 = present day
  "r_present", // family presence bit
];

/** Oracle: derived from the turn's OWN calls. Never shippable. */
const O_COLUMNS = [
  "o_calls", // log1p(calls in the turn) / 5
  "o_filesRead", // log1p(distinct files read in the turn) / 5
  "o_filesSearched", // log1p(distinct files searched in the turn) / 5
  "o_filesMutated", // log1p(distinct files mutated in the turn) / 5
  "o_anyWrite", // 1 if any Write call happened
  "o_maxToolInput", // log1p(largest single tool-input size in chars) / 10
];

// ---------------------------------------------------------------------------
// Extension families.
// ---------------------------------------------------------------------------

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "rb", "php",
  "c", "h", "hpp", "cpp", "cc", "m", "mm", "swift", "kt", "kts", "scala", "sh",
  "bash", "zsh", "pl", "lua", "vue", "svelte", "sql", "r", "jl", "ex", "exs",
]);
const CONFIG_EXT = new Set([
  "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "plist",
  "properties", "gradle", "lock", "editorconfig", "gitignore", "dockerfile",
]);
const DOCS_EXT = new Set(["md", "mdx", "rst", "txt", "adoc", "org"]);
const TEST_SEGMENT = /(?:^|[^a-z])(?:tests?|specs?|__tests__)(?:[^a-z]|$)/i;

/** tests wins over the extension families, as the plan specifies. */
function familyOf(relPath) {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  const lowerBase = base.toLowerCase();
  const dirs = segments.slice(0, -1);
  if (
    dirs.some((segment) => TEST_SEGMENT.test(segment)) ||
    /(?:^|[^a-z])(?:test|tests|spec|specs)(?:[^a-z]|$)/i.test(lowerBase.replace(/\.[^.]+$/, ""))
  ) {
    return "tests";
  }
  const dot = lowerBase.lastIndexOf(".");
  const ext = dot > 0 ? lowerBase.slice(dot + 1) : lowerBase;
  if (CODE_EXT.has(ext)) return "code";
  if (CONFIG_EXT.has(ext)) return "config";
  if (DOCS_EXT.has(ext)) return "docs";
  return "other";
}

// ---------------------------------------------------------------------------
// Git reconstruction. Every command is run with execFileSync so no shell sees a
// path, and nothing read here is ever printed or written.
// ---------------------------------------------------------------------------

const git = (dir, gitArgs) =>
  execFileSync("git", ["-C", dir, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 180_000,
  });

const rootOfCwd = new Map(); // cwd -> repo root | null
function repoRootOf(cwd) {
  if (rootOfCwd.has(cwd)) return rootOfCwd.get(cwd);
  let root = null;
  try {
    if (existsSync(cwd)) root = git(cwd, ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch {
    root = null;
  }
  rootOfCwd.set(cwd, root);
  return root;
}

const repoMeta = new Map(); // root -> { commits: [{sha, ct}], defaultBranch }
function metaOf(root) {
  if (repoMeta.has(root)) return repoMeta.get(root);
  let commits = [];
  let defaultBranch = null;
  try {
    const raw = git(root, ["log", "--format=%H %ct"]);
    commits = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        return { sha: line.slice(0, space), ct: Number(line.slice(space + 1)) };
      })
      .filter((commit) => Number.isFinite(commit.ct));
  } catch {
    commits = [];
  }
  try {
    const ref = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    if (ref) defaultBranch = ref.split("/").pop();
  } catch {
    defaultBranch = null;
  }
  if (defaultBranch === null) {
    for (const candidate of ["main", "master"]) {
      try {
        git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
        defaultBranch = candidate;
        break;
      } catch {
        /* not present */
      }
    }
  }
  const value = { commits, defaultBranch };
  repoMeta.set(root, value);
  return value;
}

/** Nearest commit at or before `whenSec`; the first commit if the turn predates it. */
function commitAt(meta, whenSec) {
  const { commits } = meta;
  if (commits.length === 0) return null;
  // commits are newest-first; binary search for the first with ct <= whenSec.
  let lo = 0;
  let hi = commits.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (commits[mid].ct <= whenSec) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found === -1) {
    const first = commits[commits.length - 1];
    return { sha: first.sha, ct: first.ct, prevCt: null, index: commits.length - 1 };
  }
  const prev = commits[found + 1] ?? null;
  return {
    sha: commits[found].sha,
    ct: commits[found].ct,
    prevCt: prev ? prev.ct : null,
    index: found,
  };
}

const treeStats = new Map(); // `${root}\0${sha}` -> stats
const commitCounts = new Map(); // `${root}\0${sha}` -> number

function statsFromEntries(entries) {
  const counts = { code: 0, config: 0, docs: 0, tests: 0, other: 0 };
  let bytes = 0;
  let hasAgentDoc = false;
  for (const [relPath, size] of entries) {
    counts[familyOf(relPath)]++;
    bytes += size;
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    if (base === "CLAUDE.md" || base === "AGENTS.md") hasAgentDoc = true;
  }
  const n = entries.size ?? entries.length ?? 0;
  const total = Math.max(1, n);
  return {
    files: n,
    bytes,
    shareCode: counts.code / total,
    shareConfig: counts.config / total,
    shareDocs: counts.docs / total,
    shareTests: counts.tests / total,
    hasTests: counts.tests > 0,
    hasAgentDoc,
  };
}

/** `git ls-tree -r -l <sha>` -> Map(path -> size). Blob entries only. */
function treeOf(root, sha) {
  const files = new Map();
  let raw;
  try {
    raw = git(root, ["ls-tree", "-r", "-l", sha]);
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    if (meta[1] !== "blob") continue;
    const size = Number(meta[3]);
    files.set(line.slice(tab + 1), Number.isFinite(size) ? size : 0);
  }
  return files;
}

function commitCountOf(root, sha) {
  const key = `${root}\0${sha}`;
  if (commitCounts.has(key)) return commitCounts.get(key);
  let count = 0;
  try {
    count = Number(git(root, ["rev-list", "--count", sha]).trim()) || 0;
  } catch {
    count = 0;
  }
  commitCounts.set(key, count);
  return count;
}

// Present-day fallback for a cwd that is not inside a git work tree. Ignored
// directories cannot be known without git, so the usual heavy ones are skipped
// by name and the walk is capped.
const WALK_SKIP = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  "target", ".next", ".cache", ".mypy_cache", ".pytest_cache", "vendor",
]);
const WALK_CAP = 60_000;
function walkDir(dir) {
  const files = new Map();
  const stack = [dir];
  while (stack.length > 0 && files.size < WALK_CAP) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (WALK_SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          size = 0;
        }
        files.set(path.relative(dir, full).replaceAll("\\", "/"), size);
        if (files.size >= WALK_CAP) break;
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Draft-named paths.
//
// Copied verbatim (modulo JS syntax) from `PATH_RE` in
// apps/companion/bin/tf_draft.py, which is itself the port of
// `extractPromptFeatures` in @token-forecaster/core, so the historical count
// and the live count are the same count:
//
//     PATH_RE = re.compile(r"(?:^|\s)(?:~|\.{1,2})?/[\w.\-/]+", re.ASCII)
//
// JavaScript's \w is ASCII already, which is why the Python side asks for
// re.ASCII. The matched text is used to look up sizes in the tree and is
// discarded here; it never reaches a row, a log line or an artifact.
// ---------------------------------------------------------------------------
const PATH_RE = /(?:^|\s)(?:~|\.{1,2})?\/[\w.\-/]+/g;

/** Cumulative bytes under every directory of the tree, built once per group. */
function directoryBytes(files) {
  const dirs = new Map();
  for (const [file, size] of files) {
    let cut = file.lastIndexOf("/");
    while (cut > 0) {
      const dir = file.slice(0, cut);
      dirs.set(dir, (dirs.get(dir) ?? 0) + size);
      cut = dir.lastIndexOf("/");
    }
  }
  return dirs;
}

function draftPathStats(text, cwd, base, files, dirs) {
  if (typeof text !== "string" || files === null) {
    return { named: 0, exist: 0, largest: 0 };
  }
  PATH_RE.lastIndex = 0;
  const named = new Set();
  let match;
  while ((match = PATH_RE.exec(text)) !== null) {
    named.add(match[0].trim());
    if (named.size >= 64) break;
  }
  let exist = 0;
  let largest = 0;
  const home = homedir();
  for (const raw of named) {
    let absolute;
    if (raw.startsWith("~/")) absolute = path.join(home, raw.slice(2));
    else if (raw.startsWith("/")) absolute = raw;
    // "./x" and "../x" are typed against the SESSION cwd; the tree is indexed
    // from the work-tree root, so resolve first and relativise second.
    else absolute = path.resolve(cwd ?? base, raw);
    const relative = path.relative(base, absolute).replaceAll("\\", "/");
    if (!relative || relative.startsWith("..")) continue;
    if (files.has(relative)) {
      exist++;
      largest = Math.max(largest, files.get(relative));
      continue;
    }
    const stripped = relative.endsWith("/") ? relative.slice(0, -1) : relative;
    if (dirs.has(stripped)) {
      exist++;
      largest = Math.max(largest, dirs.get(stripped));
    }
  }
  return { named: named.size, exist, largest };
}

// ---------------------------------------------------------------------------
// Load.
// ---------------------------------------------------------------------------

log("loading transcripts (loop context + prompt features + prompt text + path fingerprints)");
const t0 = Date.now();
const { rows: loaded, filesScanned } = await loadRequests(projectsDir, {
  withPromptFeatures: true,
  withPromptText: true,
  withResolvedFileContext: true,
});
log(`loaded ${loaded.length} calls from ${filesScanned} files in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const rows = loaded.filter(
  (row) =>
    Number.isFinite(row.timestampMs) &&
    Number.isFinite(row.outputTokens) &&
    row.outputTokens >= 0,
);

// sessionPosition, exactly as export-turn-text.mjs computes it.
const sessions = new Map();
for (const row of rows) {
  const key = row.sessionId ?? `unknown:${row.requestId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  sessions.get(key).push(row);
}
for (const list of sessions.values()) {
  list.sort((a, b) => a.timestampMs - b.timestampMs);
  list.forEach((row, index) => {
    row.sessionPosition = index;
  });
}

const turns = new Map();
for (const row of rows) {
  if (row.turnRootId === null) continue;
  let turn = turns.get(row.turnRootId);
  if (!turn) {
    turn = {
      turnRootId: row.turnRootId,
      sessionId: row.sessionId ?? null,
      workloadId: row.workloadId ?? null,
      total: 0,
      calls: 0,
      exact: true,
      firstMs: Infinity,
      opener: null,
      read: new Set(),
      searched: new Set(),
      mutated: new Set(),
      anyWrite: false,
      requestIds: new Set(),
    };
    turns.set(row.turnRootId, turn);
  }
  turn.total += row.outputTokens;
  turn.calls++;
  if (!row.loopDepthExact) turn.exact = false;
  for (const hash of row.readPathHashes ?? []) turn.read.add(hash);
  for (const hash of row.searchPathHashes ?? []) turn.searched.add(hash);
  for (const hash of row.mutationPathHashes ?? []) turn.mutated.add(hash);
  if ((row.tools ?? []).includes("Write")) turn.anyWrite = true;
  turn.requestIds.add(row.requestId);
  if (row.timestampMs < turn.firstMs) {
    turn.firstMs = row.timestampMs;
    turn.opener = row;
  }
}
const exactTurns = [...turns.values()]
  .filter((turn) => turn.exact)
  .sort((a, b) => a.firstMs - b.firstMs);
log(`${exactTurns.length} exact turns of ${turns.size} turns total`);

// ---------------------------------------------------------------------------
// Second scan: the turn root's cwd/gitBranch/timestamp, and the largest single
// tool-input block per call. The loader keeps neither (it reduces tool inputs
// to a character total per call and drops `cwd` into the path fingerprinter),
// and the loader is not ours to change, so this pass reads the same files again
// and keeps only numbers plus the cwd string, which stays in memory.
// ---------------------------------------------------------------------------

const neededUuids = new Set(exactTurns.map((turn) => turn.turnRootId));
const requestToTurn = new Map();
for (const turn of exactTurns) {
  for (const requestId of turn.requestIds) requestToTurn.set(requestId, turn.turnRootId);
}
const rootContext = new Map(); // uuid -> {cwd, branch, ms}
const maxToolInput = new Map(); // turnRootId -> chars

async function* jsonlFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

log("second pass: turn-root cwd/branch and per-call largest tool input");
const t1 = Date.now();
let scanned = 0;
for await (const file of jsonlFiles(projectsDir)) {
  scanned++;
  const lines = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    const isAssistant = line.includes('"assistant"') && line.includes("output_tokens");
    if (!isAssistant && !line.includes('"user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.uuid && neededUuids.has(entry.uuid) && !rootContext.has(entry.uuid)) {
      rootContext.set(entry.uuid, {
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
        branch: typeof entry.gitBranch === "string" ? entry.gitBranch : null,
        ms: Date.parse(entry.timestamp ?? ""),
      });
    }
    if (entry.type !== "assistant" || !entry.requestId) continue;
    const turnRootId = requestToTurn.get(entry.requestId);
    if (turnRootId === undefined) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    let biggest = maxToolInput.get(turnRootId) ?? 0;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const size = JSON.stringify(block.input ?? {}).length;
      if (size > biggest) biggest = size;
    }
    maxToolInput.set(turnRootId, biggest);
  }
}
log(`second pass over ${scanned} files in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// ---------------------------------------------------------------------------
// Session-so-far (S).
// ---------------------------------------------------------------------------

const openerRequestToTurn = new Map();
for (const turn of exactTurns) openerRequestToTurn.set(turn.opener.requestId, turn);

const sessionTurns = new Map();
for (const turn of exactTurns) {
  const key = turn.sessionId ?? `unknown:${turn.turnRootId}`;
  if (!sessionTurns.has(key)) sessionTurns.set(key, []);
  sessionTurns.get(key).push(turn);
}
for (const list of sessionTurns.values()) {
  list.sort((a, b) => a.firstMs - b.firstMs);
  list.forEach((turn, index) => {
    turn.turnsSoFar = index;
    turn.prevTurn = index === 0 ? null : list[index - 1];
  });
}

// One ordered pass per session: snapshot the running distinct-file sets at the
// moment each exact turn's opener is issued.
for (const [key, list] of sessions) {
  const read = new Set();
  const searched = new Set();
  const mutated = new Set();
  for (const row of list) {
    const turn = openerRequestToTurn.get(row.requestId);
    if (turn !== undefined && (turn.sessionId ?? `unknown:${turn.turnRootId}`) === key) {
      turn.priorRead = read.size;
      turn.priorSearched = searched.size;
      turn.priorMutated = mutated.size;
    }
    for (const hash of row.readPathHashes ?? []) read.add(hash);
    for (const hash of row.searchPathHashes ?? []) searched.add(hash);
    for (const hash of row.mutationPathHashes ?? []) mutated.add(hash);
  }
}

// ---------------------------------------------------------------------------
// Repository state (R). Turns are grouped by (repo root, commit) so each tree is
// listed exactly once and the path map never has to be cached across groups.
// ---------------------------------------------------------------------------

const diagnostics = {
  turns: exactTurns.length,
  noCwdRecorded: 0,
  cwdMissingOnDisk: 0,
  notAGitRepo: 0,
  gitNoCommits: 0,
  turnBeforeFirstCommit: 0,
  treeListFailed: 0,
  branchUnknown: 0,
  defaultBranchUnknown: 0,
  detachedHead: 0,
  noPromptText: 0,
  reconstructed: 0,
  presentDay: 0,
  rAbsent: 0,
};

const groups = new Map(); // key -> {root, sha, prevCt, ct, present, turns:[]}
for (const turn of exactTurns) {
  const context = rootContext.get(turn.turnRootId) ?? null;
  turn.branch = context?.branch ?? null;
  const whenMs = Number.isFinite(context?.ms) ? context.ms : turn.firstMs;
  turn.whenSec = Math.floor(whenMs / 1000);
  const cwd = context?.cwd ?? null;
  turn.cwd = cwd;
  if (turn.branch === null) diagnostics.branchUnknown++;
  if (cwd === null) {
    diagnostics.noCwdRecorded++;
    turn.rGroup = null;
    continue;
  }
  const root = repoRootOf(cwd);
  if (root === null) {
    if (!existsSync(cwd)) {
      diagnostics.cwdMissingOnDisk++;
      turn.rGroup = null;
      continue;
    }
    diagnostics.notAGitRepo++;
    const key = `fs\0${cwd}`;
    if (!groups.has(key)) groups.set(key, { kind: "fs", dir: cwd, turns: [] });
    groups.get(key).turns.push(turn);
    turn.rGroup = key;
    continue;
  }
  const meta = metaOf(root);
  if (meta.defaultBranch === null) diagnostics.defaultBranchUnknown++;
  if (meta.commits.length === 0) {
    diagnostics.gitNoCommits++;
    const key = `fs\0${cwd}`;
    if (!groups.has(key)) groups.set(key, { kind: "fs", dir: cwd, turns: [] });
    groups.get(key).turns.push(turn);
    turn.rGroup = key;
    continue;
  }
  const commit = commitAt(meta, turn.whenSec);
  if (commit.ct > turn.whenSec) diagnostics.turnBeforeFirstCommit++;
  const key = `git\0${root}\0${commit.sha}`;
  if (!groups.has(key)) {
    groups.set(key, {
      kind: "git",
      root,
      dir: root,
      sha: commit.sha,
      ct: commit.ct,
      prevCt: commit.prevCt,
      defaultBranch: meta.defaultBranch,
      turns: [],
    });
  }
  groups.get(key).turns.push(turn);
  turn.rGroup = key;
}
log(
  `R groups: ${groups.size} (${[...groups.values()].filter((g) => g.kind === "git").length} git commits, ` +
    `${[...groups.values()].filter((g) => g.kind === "fs").length} present-day directories)`,
);

let done = 0;
for (const group of groups.values()) {
  done++;
  if (done % 25 === 0) log(`  R group ${done}/${groups.size}`);
  let files = null;
  let dirs = null;
  let stats = null;
  let commitCount = 0;
  let daysSincePrev = null;
  let reconstructed = 0;
  if (group.kind === "git") {
    const key = `${group.root}\0${group.sha}`;
    files = treeOf(group.root, group.sha);
    if (files === null) {
      diagnostics.treeListFailed++;
    } else {
      stats = treeStats.get(key) ?? statsFromEntries(files);
      treeStats.set(key, stats);
      dirs = directoryBytes(files);
      commitCount = commitCountOf(group.root, group.sha);
      daysSincePrev =
        group.prevCt === null ? null : Math.max(0, (group.ct - group.prevCt) / 86400);
      reconstructed = 1;
    }
  } else {
    files = walkDir(group.dir);
    dirs = directoryBytes(files);
    stats = statsFromEntries(files);
  }
  for (const turn of group.turns) {
    if (stats === null) {
      turn.r = null;
      continue;
    }
    const text = turn.opener.turnPromptText ?? null;
    if (text === null) diagnostics.noPromptText++;
    const draft = draftPathStats(
      text,
      turn.cwd,
      group.kind === "git" ? group.root : group.dir,
      files,
      dirs,
    );
    let branchIsDefault = -1;
    if (group.kind === "git" && group.defaultBranch !== null && turn.branch !== null) {
      if (turn.branch === "HEAD") {
        diagnostics.detachedHead++;
        branchIsDefault = 0;
      } else {
        branchIsDefault = turn.branch === group.defaultBranch ? 1 : 0;
      }
    }
    turn.r = {
      r_fileCount: Math.log1p(stats.files) / 10,
      r_bytes: Math.log1p(stats.bytes) / 16,
      r_shareCode: stats.shareCode,
      r_shareConfig: stats.shareConfig,
      r_shareDocs: stats.shareDocs,
      r_shareTests: stats.shareTests,
      r_hasTests: stats.hasTests ? 1 : 0,
      r_hasAgentDoc: stats.hasAgentDoc ? 1 : 0,
      r_commitCount: Math.log1p(commitCount) / 10,
      r_daysSincePrevCommit:
        daysSincePrev === null ? 0 : Math.min(daysSincePrev, 30) / 30,
      r_branchIsDefault: branchIsDefault,
      r_draftPaths: Math.log1p(draft.named) / 3,
      r_draftPathsExist: Math.log1p(draft.exist) / 3,
      r_draftLargestBytes: Math.log1p(draft.largest) / 16,
      r_reconstructed: reconstructed,
      r_present: 1,
    };
    if (reconstructed === 1) diagnostics.reconstructed++;
    else diagnostics.presentDay++;
  }
}
for (const turn of exactTurns) {
  if (turn.r === undefined) turn.r = null;
  if (turn.r === null) diagnostics.rAbsent++;
}

// ---------------------------------------------------------------------------
// Write.
// ---------------------------------------------------------------------------

const CAP_MINUTES = 240;
const lines = [];
for (const turn of exactTurns) {
  const opener = turn.opener;
  const shaped = {
    model: opener.model,
    thinking: hasThinkingBlock(opener) ? "yes" : "no",
    turnPrompt: opener.turnPrompt,
    promptPath:
      opener.turnPrompt === null ? null : opener.turnPrompt.mentionsPath ? "yes" : "no",
    promptImage: opener.turnHasImage === null ? null : opener.turnHasImage ? "yes" : "no",
    sessionPosition: opener.sessionPosition ?? 0,
    loopDepth: 0,
    priorCalls: 0,
    priorMaxOutput: null,
    priorArtifactCount: null,
    priorWrite: null,
    priorArtifact: null,
  };
  const prev = turn.prevTurn ?? null;
  const minutes =
    prev === null ? 0 : Math.min(CAP_MINUTES, Math.max(0, (turn.firstMs - prev.firstMs) / 60000));
  const s = {
    s_turnsSoFar: Math.log1p(turn.turnsSoFar ?? 0) / 6,
    s_readSoFar: Math.log1p(turn.priorRead ?? 0) / 6,
    s_mutatedSoFar: Math.log1p(turn.priorMutated ?? 0) / 5,
    s_searchedSoFar: Math.log1p(turn.priorSearched ?? 0) / 5,
    s_prevTurnMutated: prev === null ? 0 : prev.mutated.size > 0 ? 1 : 0,
    s_prevTurnOutput: prev === null ? 0 : Math.log1p(prev.total) / 10,
    s_minutesSincePrevTurn: minutes / CAP_MINUTES,
    s_prevTurnPresent: prev === null ? 0 : 1,
    s_present: 1,
  };
  const o = {
    o_calls: Math.log1p(turn.calls) / 5,
    o_filesRead: Math.log1p(turn.read.size) / 5,
    o_filesSearched: Math.log1p(turn.searched.size) / 5,
    o_filesMutated: Math.log1p(turn.mutated.size) / 5,
    o_anyWrite: turn.anyWrite ? 1 : 0,
    o_maxToolInput: Math.log1p(maxToolInput.get(turn.turnRootId) ?? 0) / 10,
  };
  const r = turn.r ?? Object.fromEntries(R_COLUMNS.map((name) => [name, 0]));
  lines.push(
    JSON.stringify({
      turnRootId: turn.turnRootId,
      sessionId: turn.sessionId,
      workloadId: turn.workloadId,
      firstMs: turn.firstMs,
      total: turn.total,
      calls: turn.calls,
      model: shaped.model,
      thinking: shaped.thinking,
      features: [...portableBoostFeatures(shaped)].slice(0, 38),
      s: S_COLUMNS.map((name) => s[name]),
      r: R_COLUMNS.map((name) => r[name]),
      o: O_COLUMNS.map((name) => o[name]),
    }),
  );
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, lines.join("\n") + "\n");
if (columnsOut) {
  await mkdir(path.dirname(columnsOut), { recursive: true });
  await writeFile(
    columnsOut,
    JSON.stringify({ s: S_COLUMNS, r: R_COLUMNS, o: O_COLUMNS, diagnostics }, null, 1) + "\n",
  );
}
log(`wrote ${lines.length} exact turns to ${out}`);
console.error(JSON.stringify(diagnostics, null, 1));

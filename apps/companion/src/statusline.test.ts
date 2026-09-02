import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCodexRollout } from "@token-forecaster/ingest-codex";

import {
  codexRolloutPath,
  codexSession,
  compact,
  currentTurnOutput,
  meter,
  money,
  parseCodexTail,
  parseStyle,
  renderLine,
  workspaceLabel,
} from "./statusline.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a synthetic Claude Code transcript. No real transcript is ever read. */
function transcript(rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-statusline-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

const userTurn = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});
const toolResult = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
});
const assistant = (requestId: string, output: number, stopReason = "tool_use") => ({
  type: "assistant",
  requestId,
  message: { role: "assistant", stop_reason: stopReason, usage: { output_tokens: output } },
});

/** Strip ANSI so assertions describe shape, not colour. */
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const BOLD = "\u001b[1m";

const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");

describe("compact", () => {
  it("formats token counts for a narrow status line", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
    expect(compact(1_200)).toBe("1.2k");
    expect(compact(45_000)).toBe("45k");
    expect(compact(2_400_000)).toBe("2.4M");
  });
});

describe("currentTurnOutput", () => {
  it("sums the current turn only, starting at the last human message", () => {
    const path = transcript([
      userTurn("first task"),
      assistant("req-1", 500),
      userTurn("second task"),
      assistant("req-2", 100),
      toolResult(),
      assistant("req-3", 250),
    ]);
    // Only the second turn counts: 100 + 250. The first turn's 500 is history.
    expect(currentTurnOutput(path)).toMatchObject({ tokens: 350, calls: 2 });
  });

  it("counts a call once even though every content block repeats its usage", () => {
    const path = transcript([
      userTurn("go"),
      assistant("req-1", 800),
      assistant("req-1", 800),
      assistant("req-1", 800),
    ]);
    expect(currentTurnOutput(path)).toMatchObject({ tokens: 800, calls: 1 });
  });

  it("treats tool results as loop continuation, not a new turn", () => {
    const path = transcript([
      userTurn("go"),
      assistant("req-1", 100),
      toolResult(),
      assistant("req-2", 200),
      toolResult(),
      assistant("req-3", 300),
    ]);
    expect(currentTurnOutput(path).tokens).toBe(600);
  });

  it("ignores injected meta rows when finding the turn root", () => {
    const path = transcript([
      userTurn("go"),
      assistant("req-1", 100),
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "injected" }] },
      },
      assistant("req-2", 200),
    ]);
    expect(currentTurnOutput(path).tokens).toBe(300);
  });

  it("knows whether the agent is still working", () => {
    const running = transcript([userTurn("go"), assistant("req-1", 100), toolResult()]);
    expect(currentTurnOutput(running).complete).toBe(false);
    const done = transcript([userTurn("go"), assistant("req-1", 100, "end_turn")]);
    expect(currentTurnOutput(done).complete).toBe(true);
  });

  it("stays idle when the tail is an injected meta row", () => {
    // What every fresh session looks like while its first prompt is typed:
    // `/clear` leaves a meta user row behind and nothing has run yet.
    const path = transcript([
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>…</local-command-caveat>" },
      },
    ]);
    expect(currentTurnOutput(path).complete).toBe(true);
    const after = transcript([
      userTurn("go"),
      assistant("req-1", 100, "end_turn"),
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "hook output" },
      },
    ]);
    expect(currentTurnOutput(after).complete).toBe(true);
  });

  it("stays idle behind a slash command, which is typed but never sent", () => {
    // The real shape `/clear` leaves behind: a meta caveat row followed by an
    // ordinary user row — no `isMeta` — carrying the command envelope. Read as
    // a human turn it pins the bar to a turn that never produces a token, for
    // as long as the reader sits at the empty composer.
    const path = transcript([
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>…</local-command-caveat>" },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
        },
      },
    ]);
    expect(currentTurnOutput(path)).toMatchObject({ complete: true, promptText: "" });
  });

  it("never conditions the forecast on a slash command", () => {
    const path = transcript([
      userTurn("fix the parser"),
      assistant("req-1", 100, "end_turn"),
      {
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      },
    ]);
    // The command opens a turn of its own, so nothing from the finished one is
    // counted against it — but it carries no prompt to condition on.
    const turn = currentTurnOutput(path);
    expect(turn).toMatchObject({ tokens: 0, promptText: "", complete: true });
  });

  it("counts a command turn's own tokens, not the previous turn's", () => {
    const path = transcript([
      userTurn("fix the parser"),
      assistant("req-1", 900, "end_turn"),
      { type: "user", message: { role: "user", content: "<command-name>/code-review</command-name>" } },
      assistant("req-2", 250),
    ]);
    // A command that does real work is a turn boundary like any other.
    expect(currentTurnOutput(path)).toMatchObject({ tokens: 250, complete: false });
  });

  it("reads back the prompt that opened the turn, for features only", () => {
    const path = transcript([userTurn("first"), assistant("req-1", 100, "end_turn"), userTurn("fix the parser")]);
    expect(currentTurnOutput(path).promptText.trim()).toBe("fix the parser");
  });

  it("never throws on a missing or malformed transcript", () => {
    expect(currentTurnOutput("/nonexistent/path.jsonl")).toMatchObject({ tokens: 0, calls: 0 });
    const path = transcript([userTurn("go")]);
    writeFileSync(path, "{ truncated json\nnot json at all\n");
    expect(currentTurnOutput(path)).toMatchObject({ tokens: 0, calls: 0 });
  });
});

describe("meter", () => {
  it("fills to half width at P50 and full at P90", () => {
    expect(strip(meter(0, 1_000, 5_000))).toBe("░".repeat(10));
    expect(strip(meter(1_000, 1_000, 5_000))).toBe(
      `${"▓".repeat(5)}${"░".repeat(5)}`,
    );
    expect(strip(meter(5_000, 1_000, 5_000))).toBe("▓".repeat(10));
    // Past P90 it saturates rather than overflowing a narrow terminal.
    expect(strip(meter(50_000, 1_000, 5_000))).toBe("▓".repeat(10));
  });

  it("is always exactly ten cells wide", () => {
    for (const used of [0, 1, 500, 999, 1_000, 3_000, 5_000, 999_999]) {
      expect(strip(meter(used, 1_000, 5_000))).toHaveLength(10);
    }
  });
});

const forecast = (over: Partial<Parameters<typeof renderLine>[0]["forecast"] & object> = {}) => ({
  p50: 2_900,
  p90: 21_000,
  p99: 60_000,
  source: "personal",
  sampleSize: 500,
  usedFallback: false,
  ...over,
});

describe("renderLine", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    style: "simple" as const,
    used: 4_800,
    forecast: forecast(),
    contextPercent: 16,
    sessionTokens: 364,
    costUsd: 0.42,
    pending: false,
    draftTokens: null,
    ...over,
  });

  it("labels every number and keeps percentiles out of the default bar", () => {
    const line = strip(renderLine(state()));
    expect(line).toBe(
      "◆ 4.8k tokens out  ·  ▓▓▓▓▓▓░░░░ running long  ·  usual 2.9k tokens  ·  ctx 16%  ·  $0.42",
    );
    expect(line).not.toContain("P50");
    expect(line).not.toContain("×");
  });

  it("grades the verdict against the forecast", () => {
    const at = (used: number) => strip(renderLine(state({ used })));
    expect(at(1_400)).toContain("typical");
    expect(at(4_800)).toContain("running long");
    expect(at(34_000)).toContain("very long");
  });

  it("never lets the bundled profile pass as the user's own history", () => {
    expect(strip(renderLine(state({ forecast: forecast({ usedFallback: true }) })))).toContain(
      "usual 2.9k tokens (generic)",
    );
  });

  it("drops the price when the session has not been billed anything", () => {
    expect(strip(renderLine(state({ costUsd: null })))).not.toContain("$");
    expect(strip(renderLine(state({ costUsd: 0 })))).not.toContain("$");
  });

  it("still draws the count when the daemon has no forecast", () => {
    expect(
      strip(
        renderLine(
          state({ used: 900, forecast: null, contextPercent: 16, costUsd: null }),
        ),
      ),
    ).toBe("◆ 900 tokens out  ·  no forecast  ·  ctx 16%");
  });

  it("reports the finished turn between turns, plus what the next one costs", () => {
    expect(strip(renderLine(state({ pending: true, used: 18_000 })))).toBe(
      "◆ last turn 18k tokens out  ·  ▓▓▓▓▓▓▓▓▓░ running long  ·  next turn est 2.9k tokens out  ·  ctx 16%  ·  $0.42",
    );
  });

  it("is about the draft whenever one is being typed", () => {
    expect(strip(renderLine(state({ pending: true, used: 18_000, draftTokens: 28 })))).toBe(
      "◆ prompt 28 tokens in → est 2.9k tokens out  ·  worst case 21k tokens  ·  ctx 16%  ·  $0.42",
    );
  });

  it("says a draft forecast came from the bundled profile", () => {
    expect(
      strip(
        renderLine(
          state({ pending: true, draftTokens: 28, forecast: forecast({ usedFallback: true }) }),
        ),
      ),
    ).toContain("est 2.9k tokens out (generic)");
  });

  it("colours the context percentage by how close a compaction is", () => {
    const at = (percent: number) => renderLine(state({ contextPercent: percent }));
    expect(at(16)).toContain(`${GREEN}16%`);
    expect(at(65)).toContain(`${YELLOW}65%`);
    expect(at(80)).toContain(`${RED}80%`);
    expect(at(95)).toContain(`${BOLD}${RED}95%`);
  });

  it("has only the forecast to show before the first turn of a session", () => {
    expect(strip(renderLine(state({ pending: true, used: 0 })))).toBe(
      "◆ next turn est 2.9k tokens out  ·  worst case 21k tokens  ·  ctx 16%  ·  $0.42",
    );
  });

  it("shows the forecast, not a frozen zero, while the first turn is still running", () => {
    expect(strip(renderLine(state({ pending: false, used: 0 })))).toBe(
      "◆ working  ·  est 2.9k tokens out  ·  worst case 21k tokens  ·  ctx 16%  ·  $0.42",
    );
  });

  it("draws no meter and no verdict against a turn that has produced nothing", () => {
    const line = strip(renderLine(state({ pending: false, used: 0 })));
    expect(line).not.toContain("typical");
    expect(line).not.toContain("░");
  });

  it("says it is working in the detailed style too", () => {
    expect(strip(renderLine(state({ pending: false, used: 0, style: "detailed" })))).toBe(
      "◆ working est 2.9k tokens out  ·  P50 2.9k P90 21k P99 60k  ·  ctx 16%  ·  session 364  ·  cost $0.42",
    );
  });

  it("still says it is working when the daemon has no forecast", () => {
    expect(
      strip(renderLine(state({ pending: false, used: 0, forecast: null, costUsd: null }))),
    ).toBe("◆ working  ·  no forecast  ·  ctx 16%");
  });

  it("says a between-turns number is a prediction in the detailed style too", () => {
    expect(strip(renderLine(state({ pending: true, used: 18_000, style: "detailed" })))).toBe(
      "◆ last turn 18k tokens out → next est 2.9k tokens out  ·  P50 2.9k P90 21k P99 60k  ·  ctx 16%  ·  session 364  ·  cost $0.42",
    );
  });

  it("keeps the full numbers in the detailed style", () => {
    expect(strip(renderLine(state({ style: "detailed" })))).toBe(
      "◆ 4.8k tokens out  ·  ▓▓▓▓▓▓░░░░  ·  P50 2.9k P90 21k 1.7× P50  ·  ctx 16%  ·  session 364  ·  cost $0.42",
    );
  });
});

describe("money", () => {
  it("writes a price the way a price is written", () => {
    expect(money(0.42)).toBe("$0.42");
    expect(money(3)).toBe("$3.00");
    expect(money(42.7)).toBe("$43");
  });
});

describe("parseStyle", () => {
  it("accepts only the two known styles", () => {
    expect(parseStyle("simple")).toBe("simple");
    expect(parseStyle("detailed")).toBe("detailed");
    expect(parseStyle("SIMPLE")).toBeNull();
    expect(parseStyle(undefined)).toBeNull();
  });
});

describe("workspaceLabel", () => {
  it("names the directory, not the path, on either kind of path", () => {
    expect(workspaceLabel({ cwd: "/Users/ada/Projects/token-forecaster" })).toBe("token-forecaster");
    expect(workspaceLabel({ cwd: "C:\\Users\\ada\\Projects\\token-forecaster" })).toBe(
      "token-forecaster",
    );
    // Trailing separators, and a drive root, which has no last component to
    // name -- printing "C:" would be worse than printing nothing.
    expect(workspaceLabel({ cwd: "/Users/ada/Projects///" })).toBe("Projects");
    expect(workspaceLabel({ cwd: "C:\\Users\\ada\\Projects\\\\" })).toBe("Projects");
    expect(workspaceLabel({ cwd: "" })).toBeNull();
  });

  it("prefers the project directory over the working one", () => {
    expect(
      workspaceLabel({
        cwd: "C:\\Users\\ada\\Projects\\thing\\src",
        workspace: { project_dir: "C:\\Users\\ada\\Projects\\thing" },
      }),
    ).toBe("thing");
  });
});

/* ------------------------------------------------------------------ Codex --
 *
 * Codex writes the same kind of file Claude Code does, under different names,
 * and the bar reads it the same way: what this turn has produced so far, and
 * the prompt that opened it. The rows below are the shapes
 * `@token-forecaster/ingest-codex` trains from.
 */

const taskStarted = () => ({ type: "event_msg", payload: { type: "task_started" } });
const taskComplete = () => ({ type: "event_msg", payload: { type: "task_complete" } });
const turnContext = (model: string, effort: string) => ({
  type: "turn_context",
  payload: { model, effort },
});
const codexUser = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const codexAssistant = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});
/** A `token_count`, with the running total that makes each call identifiable. */
const tokenCount = (
  output: number,
  total: number,
  extra: { input?: number; window?: number } = {},
) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { output_tokens: total, total_tokens: total * 10 },
      last_token_usage: {
        input_tokens: extra.input ?? 1_000,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: (extra.input ?? 1_000) + output,
      },
      model_context_window: extra.window ?? 258_400,
    },
  },
});

const codexRows = (rows: unknown[]): string[] => rows.map((r) => JSON.stringify(r));

describe("reading a Codex session", () => {
  it("sums the turn in flight and says it is still running", () => {
    const session = parseCodexTail(
      codexRows([
        turnContext("gpt-5.6-sol", "xhigh"),
        taskStarted(),
        codexUser("fix the scroll region clamp"),
        tokenCount(400, 400),
        tokenCount(600, 1_000),
      ]),
    );
    expect(session.turn.tokens).toBe(1_000);
    expect(session.turn.calls).toBe(2);
    expect(session.turn.complete).toBe(false);
    expect(session.turn.promptText).toBe("fix the scroll region clamp");
    expect(session.model).toBe("gpt-5.6-sol");
    expect(session.reasoning).toBe("xhigh");
  });

  it("counts a redraw as a redraw, not as another call", () => {
    // Codex re-emits token_count to refresh its own UI. Counted naively, a turn
    // that sat on screen would climb for as long as it was looked at.
    const session = parseCodexTail(
      codexRows([taskStarted(), tokenCount(400, 400), tokenCount(400, 400), tokenCount(600, 1_000)]),
    );
    expect(session.turn.tokens).toBe(1_000);
    expect(session.turn.calls).toBe(2);
  });

  it("goes idle when the turn finishes, and still reports what it cost", () => {
    // Between turns the bar says what the last turn cost next to what the next
    // one is expected to cost — the same thing it says in Claude Code.
    const session = parseCodexTail(
      codexRows([taskStarted(), codexUser("hello"), tokenCount(400, 400), taskComplete()]),
    );
    expect(session.turn.complete).toBe(true);
    expect(session.turn.tokens).toBe(400);
  });

  it("counts only the turn in flight, not the one before it", () => {
    const session = parseCodexTail(
      codexRows([
        taskStarted(),
        codexUser("the previous turn"),
        tokenCount(5_000, 5_000),
        taskComplete(),
        taskStarted(),
        codexUser("the one running now"),
        tokenCount(200, 5_200),
      ]),
    );
    expect(session.turn.tokens).toBe(200);
    expect(session.turn.promptText).toBe("the one running now");
  });

  it("takes the prompt a person typed, not the preamble Codex writes first", () => {
    // Codex opens a turn with developer and environment rows of its own, some
    // of them role "user". Conditioning the forecast on one of those would
    // forecast Codex's boilerplate rather than the request.
    const session = parseCodexTail(
      codexRows([
        taskStarted(),
        codexUser("<environment_context>cwd=/x</environment_context>"),
        codexUser("port the launcher to Windows"),
        codexAssistant("Sure."),
        codexUser("this row belongs to the next turn's preamble"),
        tokenCount(300, 300),
      ]),
    );
    expect(session.turn.promptText).toBe("port the launcher to Windows");
  });

  it("prefers the user_message event when the rollout has one", () => {
    const session = parseCodexTail(
      codexRows([
        taskStarted(),
        codexUser("<environment_context/>"),
        { type: "event_msg", payload: { type: "user_message", message: "add a test", images: ["a"] } },
        tokenCount(300, 300),
      ]),
    );
    expect(session.turn.promptText).toBe("add a test");
    expect(session.turn.images).toBe(1);
  });

  it("reports how much of the context window the last call used", () => {
    const session = parseCodexTail(
      codexRows([taskStarted(), tokenCount(1_000, 1_000, { input: 128_200, window: 258_400 })]),
    );
    expect(Math.round(session.contextPercent ?? 0)).toBe(50);
  });

  it("reads a markerless window as a turn too long to have fit in it", () => {
    // Half a megabyte back is wherever it lands, and a Codex rollout reaches
    // tens of megabytes for a single turn. An idle session has stopped
    // appending, so its `task_complete` is the last row in the file and is
    // always in reach — only a running turn can leave the window with no
    // marker at all, and calling that "idle" would park the bar on "next turn"
    // for as long as the longest turns run.
    const session = parseCodexTail(codexRows([tokenCount(400, 400), tokenCount(600, 1_000)]));
    expect(session.turn.complete).toBe(false);
    // Under-reporting a long turn beats reporting nothing about it.
    expect(session.turn.tokens).toBe(1_000);
  });

  it("never throws on a truncated or unrecognised row", () => {
    expect(() =>
      parseCodexTail(['{"type":"event_msg","pay', "", "not json at all", "{}", '{"payload":null}']),
    ).not.toThrow();
  });

  it("finds no session before Codex has written one", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-codex-"));
    dirs.push(dir);
    // Codex only creates the rollout once a turn starts, which is exactly when
    // the bar is forecasting a draft and has nothing to measure yet.
    expect(codexRolloutPath(dir, Date.now())).toBeNull();
    expect(codexSession(dir, Date.now()).turn.tokens).toBe(0);
  });

  it("takes the newest session started after the launcher, not the archive", () => {
    const home = mkdtempSync(join(tmpdir(), "tf-codex-"));
    dirs.push(home);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(
      home,
      "sessions",
      String(now.getFullYear()),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
    );
    mkdirSync(day, { recursive: true });
    const old = join(day, "rollout-old-1.jsonl");
    const mine = join(day, "rollout-new-2.jsonl");
    writeFileSync(old, `${codexRows([taskStarted(), tokenCount(9_999, 9_999)]).join("\n")}\n`);
    writeFileSync(mine, `${codexRows([taskStarted(), tokenCount(42, 42)]).join("\n")}\n`);
    // The archive goes back as far as the reader has used Codex; only a file
    // that appeared after this launcher started can be this launcher's session.
    const since = Date.now();
    utimesSync(old, new Date(since - 3_600_000), new Date(since - 3_600_000));
    utimesSync(mine, new Date(since + 1_000), new Date(since + 1_000));
    expect(codexRolloutPath(home, since)).toBe(mine);
    expect(codexSession(home, since).turn.tokens).toBe(42);
  });

  it("keeps to its own session when a second Codex is open", () => {
    // Codex passes nothing down to a process that wrapped it — not the rollout
    // path, not the session id — so the file is a guess, and "the newest one"
    // alone would hand the first window's bar to the second window's turn.
    // A session opened somewhere else is ruled out by its own `cwd`.
    const home = mkdtempSync(join(tmpdir(), "tf-codex-"));
    dirs.push(home);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = join(
      home,
      "sessions",
      String(now.getFullYear()),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
    );
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string) => ({
      type: "session_meta",
      payload: { id: cwd, cwd, cli_version: "0.150.1", base_instructions: { text: "x".repeat(20_000) } },
    });
    const mine = join(day, "rollout-mine.jsonl");
    const theirs = join(day, "rollout-theirs.jsonl");
    writeFileSync(mine, `${codexRows([meta("/w/mine"), taskStarted(), tokenCount(11, 11)]).join("\n")}\n`);
    writeFileSync(
      theirs,
      `${codexRows([meta("/w/theirs"), taskStarted(), tokenCount(999, 999)]).join("\n")}\n`,
    );
    const since = Date.now();
    utimesSync(mine, new Date(since + 1_000), new Date(since + 1_000));
    // The other window started later, so it is the newest file by some margin.
    utimesSync(theirs, new Date(since + 9_000), new Date(since + 9_000));
    expect(codexRolloutPath(home, since, "/w/mine")).toBe(mine);
    expect(codexSession(home, since, "/w/mine").turn.tokens).toBe(11);
  });
});

/**
 * The bar and the trainer read the same file.
 *
 * The status line counts a turn as it happens; the importer counts the same
 * turn afterwards and it becomes a row the forecast is fitted on. If the two
 * ever disagree, the bar grades a live turn against a distribution built by
 * counting differently — and nothing anywhere would say so.
 */
describe("live turn agrees with the trainer", () => {
  it("counts a turn's output the way the importer counts it", () => {
    const rows = codexRows([
      { type: "session_meta", payload: { id: "abc", cli_version: "0.150.1" } },
      turnContext("gpt-5.6-sol", "xhigh"),
      taskStarted(),
      { type: "event_msg", payload: { type: "user_message", message: "write the docs", images: [] } },
      tokenCount(400, 400),
      tokenCount(400, 400),
      tokenCount(650, 1_050),
      tokenCount(120, 1_170),
    ]);
    const live = parseCodexTail(rows);
    const imported = parseCodexRollout(`${rows.join("\n")}\n`, {
      sourceFile: "rollout-test.jsonl",
      salt: "",
    });
    const turn = imported.observations.find((o) => o.scale === "turn");
    expect(turn?.outputTokens).toBe(live.turn.tokens);
    expect(turn?.model).toBe(live.model);
    expect(turn?.reasoning).toBe(live.reasoning);
  });
});

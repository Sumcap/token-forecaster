import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compact,
  currentTurnOutput,
  meter,
  money,
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

#!/usr/bin/env node
import { openSync, readSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { meterFill } from "./meter.js";

/**
 * Claude Code status line renderer.
 *
 * Claude Code pipes a JSON blob on stdin and displays whatever this prints on
 * stdout. It is invoked on every assistant message and, when `refreshInterval`
 * is configured, on a timer — so it must be fast and must never fail: a
 * non-zero exit or empty output blanks the status line.
 *
 * This file deliberately imports **only Node builtins**. Pulling in the store
 * or the trainer would add SQLite and a hundred milliseconds to something that
 * runs every second. All it does is read a little state and talk to the
 * already-running daemon over loopback.
 */

/** Shape of the fields we use from Claude Code's stdin payload. */
interface StatusLineInput {
  session_id?: string;
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  context_window?: {
    total_output_tokens?: number;
    used_percentage?: number | null;
    context_window_size?: number;
  } | null;
  cost?: { total_cost_usd?: number };
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
}

interface Forecast {
  p50: number;
  p90: number;
  p99: number;
  source: string;
  sampleSize: number;
  usedFallback: boolean;
}

/**
 * How much the bar says.
 *
 * `simple` is the default and the one most people should ever see: how big
 * this turn is, a meter, and whether that is normal for them. `detailed` adds
 * the percentiles behind that judgement, for people who want the numbers.
 */
export type StatusStyle = "simple" | "detailed";

/** Read a style off untrusted input; anything unrecognised means "unset". */
export function parseStyle(value: unknown): StatusStyle | null {
  return value === "simple" || value === "detailed" ? value : null;
}

const RESET = "[0m";
const DIM = "[2m";
const BOLD = "[1m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const CYAN = "[36m";

/** Read all of stdin, with a hard cap so a wedged pipe cannot hang the line. */
async function readStdin(): Promise<StatusLineInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) break;
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text.startsWith("{")) return {};
    return JSON.parse(text) as StatusLineInput;
  } catch {
    return {};
  }
}

/** Compact token count: 1234 → 1.2k, 1234567 → 1.2M. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Output tokens produced so far in the current turn.
 *
 * Claude Code appends to the transcript as the turn runs, so this is the one
 * genuinely live number available — it grows while the agent is still working,
 * where `context_window` in the stdin payload only moves between turns.
 *
 * Only the tail of the file is read: transcripts reach hundreds of megabytes
 * and this runs every second.
 */
export interface TurnState {
  tokens: number;
  calls: number;
  /** True when the last message ended the turn: nothing is running right now. */
  complete: boolean;
  /**
   * The human prompt that opened this turn.
   *
   * Held only long enough for {@link promptShape} to reduce it to counts. It is
   * never sent anywhere and never written down.
   */
  promptText: string;
  /** Images attached to that prompt. */
  images: number;
}

/**
 * Is this user row a slash command rather than something said to the model?
 *
 * `/clear`, `/model` and friends are written to the transcript as ordinary
 * `user` rows — no `isMeta` — whose content is a `<command-name>` envelope.
 * Nothing was sent to the model and nothing is coming back, so a row like this
 * is neither a turn root nor evidence that a turn is running. Reading one as a
 * live turn is what left the bar sitting on an empty first turn after `/clear`,
 * and what fed `/clear` itself to the forecaster as the prompt to condition on.
 */
function isLocalCommand(content: unknown): boolean {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => {
              const block = b as Record<string, unknown> | null;
              return block?.["type"] === "text" && typeof block["text"] === "string"
                ? block["text"]
                : "";
            })
            .join("")
        : "";
  const head = text.trimStart();
  return (
    head.startsWith("<command-name>") ||
    head.startsWith("<command-message>") ||
    head.startsWith("<local-command-stdout>") ||
    head.startsWith("<local-command-caveat>")
  );
}

export function currentTurnOutput(transcriptPath: string): TurnState {
  const TAIL_BYTES = 512 * 1024;
  let fd: number | null = null;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return idleTurn();
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // A partial first line is unavoidable when seeking into the middle.
    const lines = text.split("\n").slice(start > 0 ? 1 : 0);

    // Walk backwards to the most recent human turn root, then sum forwards.
    // One row per content block repeats the call's total, so take the max per
    // requestId rather than adding them up.
    let turnStart = 0;
    let foundRoot = false;
    let rootIsCommand = false;
    const parsed: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (line.length < 2) continue;
      try {
        parsed.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Truncated tail row; ignore.
      }
    }
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const row = parsed[i]!;
      if (row["type"] !== "user") continue;
      const message = row["message"] as Record<string, unknown> | undefined;
      const content = message?.["content"];
      // A user row carrying tool_result blocks continues the agent loop; only a
      // genuine human message starts a new turn.
      const isToolResult =
        Array.isArray(content) &&
        content.some((b) => (b as Record<string, unknown> | null)?.["type"] === "tool_result");
      if (isToolResult || row["isMeta"] === true) continue;
      // A slash command still opens a turn — `/code-review` and every skill do
      // real work — so it stays the boundary the tokens are summed from. What
      // it does not have is a prompt: the envelope is a harness identifier, not
      // something a person said to the model.
      rootIsCommand = isLocalCommand(content);
      turnStart = i;
      foundRoot = true;
      break;
    }

    const byRequest = new Map<string, number>();
    for (let i = turnStart; i < parsed.length; i += 1) {
      const row = parsed[i]!;
      const message = row["message"] as Record<string, unknown> | undefined;
      const usage = message?.["usage"] as Record<string, unknown> | undefined;
      const output = usage?.["output_tokens"];
      if (typeof output !== "number") continue;
      const requestId = (row["requestId"] as string | undefined) ?? `#${i}`;
      byRequest.set(requestId, Math.max(byRequest.get(requestId) ?? 0, output));
    }
    let tokens = 0;
    for (const value of byRequest.values()) tokens += value;

    // The prompt that opened the turn, as text, for one function call only.
    let promptText = "";
    let images = 0;
    // With no human row in the tail there is no prompt to report: row zero is
    // whatever the window happened to start on, and conditioning a forecast on
    // that is worse than not conditioning it at all.
    const rootContent =
      foundRoot && !rootIsCommand
        ? (parsed[turnStart]?.["message"] as Record<string, unknown> | undefined)?.["content"]
        : null;
    if (typeof rootContent === "string") {
      promptText = rootContent;
    } else if (Array.isArray(rootContent)) {
      for (const block of rootContent) {
        const b = block as Record<string, unknown> | null;
        if (b?.["type"] === "text" && typeof b["text"] === "string") promptText += `${b["text"]}\n`;
        if (b?.["type"] === "image") images += 1;
      }
    }

    // Is anything running? Only rows that carry a message answer that; a turn
    // that has ended stops at an assistant message with `end_turn`. Everything
    // else in the tail — attachments, mode markers, the session bridge — is
    // bookkeeping Claude Code appends around the conversation.
    let complete = true;
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const row = parsed[i]!;
      const type = row["type"];
      if (type !== "assistant" && type !== "user") continue;
      // A meta user row is injected, not sent: the caveat a slash command
      // leaves behind, a hook's output. A session that has only those at its
      // tail — every fresh session, straight after `/clear` — is idle, and
      // reading one as a turn in flight is what stops the first prompt of a
      // session from being forecast as it is typed.
      const message = row["message"] as Record<string, unknown> | undefined;
      if (row["isMeta"] === true) continue;
      // A slash command is typed, not sent. `/clear` is the one that matters:
      // it is the last row in the file for as long as the reader sits at an
      // empty composer, and reading it as a turn in flight pins the bar to a
      // turn that will never produce a token.
      if (type === "user" && isLocalCommand(message?.["content"])) continue;
      const stop = message?.["stop_reason"];
      complete = type === "assistant" && (stop === "end_turn" || stop === "stop_sequence");
      break;
    }

    return { tokens, calls: byRequest.size, complete, promptText, images };
  } catch {
    return idleTurn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/** Nothing running and nothing known: the state every failure falls back to. */
function idleTurn(): TurnState {
  return { tokens: 0, calls: 0, complete: true, promptText: "", images: 0 };
}

/**
 * Reduce the turn's prompt to the counts the forecaster conditions on.
 *
 * This is the whole point of the app: the same prompt aggregates the trainer
 * derives from history are derived here from the prompt in flight, so the
 * number on the bar is a forecast *for this prompt* rather than for an average
 * one. The extractor is imported from the same module the trainer uses, so the
 * live features cannot drift from the trained ones — dynamically, and behind a
 * try/catch, because the status line must render even if that import fails.
 *
 * Counts only. The hash is blanked: it exists to match repeated prompts during
 * training and has no part in a forecast, and no text crosses the socket.
 */
async function promptShape(text: string, images: number): Promise<unknown | null> {
  if (text.trim().length === 0) return null;
  try {
    const mod = (await import("@token-forecaster/core/prompt-features")) as {
      extractPromptFeatures: (text: string, salt: string, images?: number) => object;
    };
    return { ...mod.extractPromptFeatures(text, "", images), hash: "" };
  } catch {
    return null;
  }
}

/**
 * The prompt currently being typed, as counts, when a `tf-claude` launcher is
 * feeding them.
 *
 * Claude Code's status-line payload has no field for the composer and typing is
 * not an update trigger, so a draft can only come from something sitting
 * between the keyboard and Claude Code. `bin/tf-claude` is that something: it
 * publishes the counts and names the file in `TOKEN_FORECASTER_DRAFT`. Plain
 * `claude` sets no such variable, and everything below simply does not run.
 *
 * Counts only — the draft's text is never written to that file.
 */
export function readDraft(
  now = Date.now(),
): { features: unknown; chars: number; tokens: number } | null {
  const path = process.env["TOKEN_FORECASTER_DRAFT"];
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      updatedAt?: number;
      tokens?: number;
      features?: { chars?: number };
    };
    // A launcher that died leaves its last draft behind; anything older than a
    // few minutes is not what the reader is typing now.
    if (typeof parsed.updatedAt !== "number" || now - parsed.updatedAt > 300_000) return null;
    const chars = parsed.features?.chars ?? 0;
    if (!parsed.features || chars <= 0) return null;
    // A launcher older than the token estimate still publishes characters, and
    // four to a token is the same rule it would have applied.
    const tokens =
      typeof parsed.tokens === "number" && parsed.tokens >= 0
        ? parsed.tokens
        : Math.ceil(chars / 4);
    return { features: parsed.features, chars, tokens };
  } catch {
    return null;
  }
}

/** Where the daemon publishes its port and per-install token. */
function readRuntime(): { port: number; token: string } | null {
  try {
    const runtimePath = join(
      homedir(),
      "Library",
      "Application Support",
      "TokenForecaster",
      "runtime.json",
    );
    const info = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      port?: number;
      token?: string;
    };
    if (!info.port || !info.token) return null;
    return { port: info.port, token: info.token };
  } catch {
    return null;
  }
}

/** POST to the daemon with a hard timeout. Never throws, never blocks the line. */
async function post(
  runtime: { port: number; token: string },
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  // The status line must never be the reason a terminal feels slow.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the running daemon for this user's turn-total forecast, and for the bar
 * style it has been told to draw.
 *
 * The style rides along on this reply rather than getting a call of its own:
 * the status line runs every second and one round trip is the budget.
 */
async function fetchForecast(
  runtime: { port: number; token: string } | null,
  model: string | null,
  reasoning: string | null,
  promptFeatures: unknown | null,
): Promise<{ forecast: Forecast | null; statusStyle: StatusStyle | null }> {
  if (!runtime) return { forecast: null, statusStyle: null };
  const body = await post(
    runtime,
    "/forecast",
    { provider: "anthropic", scale: "turn", model, reasoning, promptFeatures },
    700,
  );
  const forecast = (body?.["forecast"] as Forecast | undefined) ?? null;
  const statusStyle = parseStyle(body?.["statusStyle"]);
  if (forecast) {
    rememberForecast({ forecast, statusStyle });
    return { forecast, statusStyle };
  }
  // The daemon was busy — it also scans transcripts — and one missed round trip
  // in a bar that redraws every second must not read as "there is no forecast".
  // A number from a few seconds ago is the honest stand-in; anything older is
  // not, and the bar says so instead.
  return recallForecast() ?? { forecast: null, statusStyle };
}

/** Where the last good forecast is parked, next to the daemon's own state. */
function lastForecastPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "TokenForecaster",
    "last-forecast.json",
  );
}

function rememberForecast(value: {
  forecast: Forecast;
  statusStyle: StatusStyle | null;
}): void {
  try {
    writeFileSync(lastForecastPath(), JSON.stringify({ at: Date.now(), ...value }));
  } catch {
    // Best effort. A bar that cannot cache still draws.
  }
}

/** The last good forecast, if it is recent enough to still describe this draft. */
function recallForecast(
  now = Date.now(),
): { forecast: Forecast; statusStyle: StatusStyle | null } | null {
  try {
    const parsed = JSON.parse(readFileSync(lastForecastPath(), "utf8")) as {
      at?: number;
      forecast?: Forecast;
      statusStyle?: unknown;
    };
    if (typeof parsed.at !== "number" || now - parsed.at > 10_000) return null;
    if (!parsed.forecast || typeof parsed.forecast.p50 !== "number") return null;
    return { forecast: parsed.forecast, statusStyle: parseStyle(parsed.statusStyle) };
  } catch {
    return null;
  }
}

/**
 * Tell the daemon how the turn in flight is going.
 *
 * This is the only place the live turn is visible: the daemon scans on demand
 * and cannot see a turn that has not finished. Reporting it here costs nothing
 * extra — this process already ran, already parsed the transcript and already
 * has the daemon on the line — and it is what lets the menu bar show the same
 * measurement as this bar.
 *
 * Numbers only. No prompt or response text is read, held or sent.
 */
async function reportTurn(
  runtime: { port: number; token: string } | null,
  sessionId: string | null,
  turn: { tokens: number; calls: number; complete: boolean },
  forecast: Forecast | null,
  label: string | null,
): Promise<void> {
  if (!runtime || !sessionId) return;
  await post(
    runtime,
    "/turn",
    {
      sessionId,
      label,
      provider: "anthropic",
      outputTokens: turn.tokens,
      calls: turn.calls,
      // The transcript says whether anything is still running in THIS session.
      // Without it the daemon has only the token delta to go on, and every
      // terminal that is merely open looks like a terminal that is working.
      inFlight: !turn.complete,
      p50: forecast?.p50 ?? null,
      p90: forecast?.p90 ?? null,
      usedFallback: forecast?.usedFallback ?? false,
    },
    400,
  );
}

/**
 * The name of the directory this session is working in, or null.
 *
 * Only the last path component: enough to tell two chats apart in the menu,
 * and not the full path, which is nobody's business but this machine's.
 */
function workspaceLabel(input: StatusLineInput): string | null {
  const dir = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? null;
  if (!dir) return null;
  const name = dir.replace(/\/+$/, "").split("/").pop();
  return name && name.length > 0 ? name : null;
}

/** A ten-cell meter of `used` against `p50`, saturating past `p90`. */
export function meter(used: number, p50: number, p90: number): string {
  if (p50 <= 0) return "";
  const cells = 10;
  // Same curve as the menu bar draws, from the one shared definition.
  const filled = Math.round(meterFill(used, p50, p90) * cells);
  const colour = used > p90 ? RED : used > p50 ? YELLOW : GREEN;
  return `${colour}${"▓".repeat(filled)}${DIM}${"░".repeat(cells - filled)}${RESET}`;
}

/**
 * The turn in one or two words: is this normal for you, or not?
 *
 * The whole point of the bar is to answer that without the reader doing
 * arithmetic against a percentile, so the words carry the verdict and the
 * numbers stay out of the way unless asked for.
 */
export function verdict(used: number, p50: number, p90: number): string {
  if (p50 <= 0) return "";
  if (used > p90) return `${RED}very long${RESET}`;
  if (used > p50) return `${YELLOW}running long${RESET}`;
  return `${DIM}typical${RESET}`;
}

/** State the bar draws, gathered by {@link renderStatusLine}. */
export interface LineState {
  style: StatusStyle;
  used: number;
  forecast: Forecast | null;
  contextPercent: number | null;
  sessionTokens: number | null;
  /** Dollars spent in this session so far, when Claude Code reports it. */
  costUsd: number | null;
  /** True between turns: nothing is running, so the bar predicts the next one. */
  pending: boolean;
  /** Input tokens typed so far, when a launcher is reporting a draft. */
  draftTokens: number | null;
}

/** Session spend, in the shape a price is normally written. */
export function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value)}`;
}

/**
 * Colour for a context-window percentage.
 *
 * The number is on the bar to be glanced at, so it has to change appearance
 * long before it is a problem: green while there is room, amber once two
 * thirds are gone, red when a compaction is close, and bold red when it is
 * about to happen anyway.
 */
export function contextColour(percent: number): string {
  if (percent >= 90) return `${BOLD}${RED}`;
  if (percent >= 75) return RED;
  if (percent >= 60) return YELLOW;
  return GREEN;
}

/**
 * The forecast, written so it cannot be mistaken for a measurement.
 *
 * This is the number the whole app exists to show — what the prompt about to
 * be sent is expected to cost in output tokens — so it is the one thing on the
 * bar that is bright and bold while everything around it stays dim.
 */
export function estimate(p50: number, usedFallback: boolean): string {
  return `${DIM}est${RESET} ${BOLD}${CYAN}${compact(p50)}${RESET} ${DIM}tokens out${usedFallback ? " (generic)" : ""}${RESET}`;
}

/** Build the status line text. Pure, so both styles can be tested directly. */
export function renderLine(state: LineState): string {
  const { style, used, forecast } = state;
  const parts: string[] = [];

  if (style === "simple") {
    if (state.pending) {
      // Nothing is running, and Claude Code never puts the prompt being typed
      // on disk — so a line about "the turn you are writing" could only ever be
      // a constant, and a constant on a live bar reads as frozen. What the bar
      // shows instead is the turn that just finished, which is different every
      // time it is looked at, followed by what the next one is expected to
      // cost: the number a caller would set aside as its output budget.
      if (!forecast) {
        parts.push(`${CYAN}\u25c6${RESET} ${DIM}no forecast${RESET}`);
      } else if (state.draftTokens !== null) {
        // A draft is being typed and the forecast is conditioned on it, so the
        // bar is about the prompt in progress and nothing else: what has been
        // typed in, and what sending it is expected to cost coming back out.
        // The arrow is the sentence — "this much in buys about that much out" —
        // and it is why the two halves share one segment.
        parts.push(
          `${CYAN}\u25c6${RESET} ${DIM}prompt${RESET} ${compact(state.draftTokens)} ${DIM}tokens in \u2192${RESET} ${estimate(forecast.p50, forecast.usedFallback)}`,
        );
        parts.push(`${DIM}worst case ${compact(forecast.p90)} tokens${RESET}`);
      } else {
        if (used > 0) {
          parts.push(`${CYAN}\u25c6${RESET} ${DIM}last turn${RESET} ${compact(used)} ${DIM}tokens out${RESET}`);
          parts.push(
            `${meter(used, forecast.p50, forecast.p90)} ${verdict(used, forecast.p50, forecast.p90)}`,
          );
          parts.push(`${DIM}next turn${RESET} ${estimate(forecast.p50, forecast.usedFallback)}`);
        } else {
          parts.push(
            `${CYAN}\u25c6${RESET} ${DIM}next turn${RESET} ${estimate(forecast.p50, forecast.usedFallback)}`,
          );
          parts.push(`${DIM}worst case ${compact(forecast.p90)} tokens${RESET}`);
        }
      }
    } else if (forecast) {
      if (used === 0) {
        // A turn is running but no API call has come back yet \u2014 the first
        // prompt of a session is the whole of this case. Usage lands in the
        // transcript only when a call finishes, so a measured "0 tokens out"
        // would sit there unmoving for the entire reply, under an empty meter
        // and a verdict of "typical" passed on nothing at all. Say what is
        // actually true instead: it is working, and here is what it is
        // expected to cost.
        parts.push(`${CYAN}\u25c6${RESET} ${DIM}working${RESET}`);
        parts.push(estimate(forecast.p50, forecast.usedFallback));
        parts.push(`${DIM}worst case ${compact(forecast.p90)} tokens${RESET}`);
      } else {
        parts.push(`${CYAN}\u25c6${RESET} ${compact(used)} ${DIM}tokens out${RESET}`);
        parts.push(
          `${meter(used, forecast.p50, forecast.p90)} ${verdict(used, forecast.p50, forecast.p90)}`,
        );
        // "usual" is the honest word for a median, and it never claims to be
        // personal when it came out of the bundled profile.
        parts.push(
          `${DIM}usual ${compact(forecast.p50)} tokens${forecast.usedFallback ? " (generic)" : ""}${RESET}`,
        );
      }
    } else if (used === 0) {
      parts.push(`${CYAN}\u25c6${RESET} ${DIM}working${RESET}`);
      parts.push(`${DIM}no forecast${RESET}`);
    } else {
      parts.push(`${CYAN}\u25c6${RESET} ${compact(used)} ${DIM}tokens out${RESET}`);
      parts.push(`${DIM}no forecast${RESET}`);
    }
    if (state.contextPercent !== null) {
      const percent = state.contextPercent;
      parts.push(`${DIM}ctx${RESET} ${contextColour(percent)}${Math.round(percent)}%${RESET}`);
    }
    if (state.costUsd !== null && state.costUsd > 0) parts.push(money(state.costUsd));
    return parts.filter((part) => part.length > 0).join(`  ${DIM}\u00b7${RESET}  `);
  }

  if (forecast && state.pending && state.draftTokens !== null) {
    parts.push(
      `${CYAN}\u25c6${RESET} ${DIM}prompt${RESET} ${compact(state.draftTokens)} ${DIM}tokens in \u2192${RESET} ${estimate(forecast.p50, false)}`,
    );
    parts.push(
      `${DIM}P50${RESET} ${compact(forecast.p50)} ${DIM}P90${RESET} ${compact(forecast.p90)} ${DIM}P99${RESET} ${compact(forecast.p99)}`,
    );
    if (forecast.usedFallback) parts.push(`${DIM}(generic profile)${RESET}`);
  } else if (forecast && state.pending) {
    parts.push(
      used > 0
        ? `${CYAN}\u25c6${RESET} ${DIM}last turn${RESET} ${compact(used)} ${DIM}tokens out \u2192 next${RESET} ${estimate(forecast.p50, false)}`
        : `${CYAN}\u25c6${RESET} ${DIM}next turn${RESET} ${estimate(forecast.p50, false)}`,
    );
    parts.push(
      `${DIM}P50${RESET} ${compact(forecast.p50)} ${DIM}P90${RESET} ${compact(forecast.p90)} ${DIM}P99${RESET} ${compact(forecast.p99)}`,
    );
    if (forecast.usedFallback) parts.push(`${DIM}(generic profile)${RESET}`);
  } else if (forecast && used === 0) {
    // Same as the simple bar: nothing has come back yet, so there is no
    // measurement to draw a meter against \u2014 only the forecast.
    parts.push(`${CYAN}\u25c6${RESET} ${DIM}working${RESET} ${estimate(forecast.p50, false)}`);
    parts.push(
      `${DIM}P50${RESET} ${compact(forecast.p50)} ${DIM}P90${RESET} ${compact(forecast.p90)} ${DIM}P99${RESET} ${compact(forecast.p99)}`,
    );
    if (forecast.usedFallback) parts.push(`${DIM}(generic profile)${RESET}`);
  } else if (forecast) {
    parts.push(`${CYAN}\u25c6${RESET} ${compact(used)} ${DIM}tokens out${RESET}`);
    parts.push(meter(used, forecast.p50, forecast.p90));
    const ratio = forecast.p50 > 0 ? used / forecast.p50 : 0;
    const marker =
      used > forecast.p90 ? `${RED}past P90${RESET}` : `${DIM}${ratio.toFixed(1)}\u00d7 P50${RESET}`;
    parts.push(
      `${DIM}P50${RESET} ${compact(forecast.p50)} ${DIM}P90${RESET} ${compact(forecast.p90)} ${marker}`,
    );
    if (forecast.usedFallback) {
      // Never let a generic number pass as a personal one.
      parts.push(`${DIM}(generic profile)${RESET}`);
    }
  } else {
    parts.push(`${CYAN}\u25c6${RESET} ${DIM}forecaster offline${RESET}`);
    if (used > 0) parts.push(`turn ${compact(used)}`);
  }

  if (state.contextPercent !== null) {
    const percent = state.contextPercent;
    parts.push(`${DIM}ctx${RESET} ${contextColour(percent)}${Math.round(percent)}%${RESET}`);
  }
  if (state.sessionTokens !== null) {
    parts.push(`${DIM}session${RESET} ${compact(state.sessionTokens)}`);
  }
  if (state.costUsd !== null && state.costUsd > 0) {
    parts.push(`${DIM}cost${RESET} ${money(state.costUsd)}`);
  }

  return parts.filter((part) => part.length > 0).join(`  ${DIM}\u00b7${RESET}  `);
}

export async function renderStatusLine(): Promise<void> {
  const input = await readStdin();
  const model = input.model?.id ?? null;
  const reasoning =
    input.effort?.level ?? (input.thinking?.enabled === true ? "thinking" : null);

  const turn = input.transcript_path ? currentTurnOutput(input.transcript_path) : idleTurn();
  const runtime = readRuntime();
  // What the forecast is about: the prompt being typed if a launcher is
  // reporting one, otherwise the prompt that opened the turn in flight. A
  // finished turn's prompt says nothing about the next one, so between turns
  // with no draft the forecast is deliberately unconditioned.
  const draft = turn.complete ? readDraft() : null;
  const features = draft ? draft.features : turn.complete ? null : await promptShape(turn.promptText, turn.images);
  const { forecast, statusStyle } = await fetchForecast(runtime, model, reasoning, features);
  await reportTurn(runtime, input.session_id ?? null, turn, forecast, workspaceLabel(input));

  // The environment wins, so a status line configured by hand can pick its own
  // style without the daemon; otherwise the app's setting decides, and the
  // friendly bar is what a fresh install shows.
  const style = parseStyle(process.env["TOKEN_FORECASTER_STATUS_STYLE"]) ?? statusStyle ?? "simple";

  const context = input.context_window;
  process.stdout.write(
    `${renderLine({
      style,
      used: turn.tokens,
      forecast,
      contextPercent:
        context && typeof context.used_percentage === "number" ? context.used_percentage : null,
      sessionTokens:
        context && typeof context.total_output_tokens === "number"
          ? context.total_output_tokens
          : null,
      costUsd: typeof input.cost?.total_cost_usd === "number" ? input.cost.total_cost_usd : null,
      pending: turn.complete,
      draftTokens: draft?.tokens ?? null,
    })}\n`,
  );
}

// Any failure must still produce a line: an empty status line looks like a bug
// in Claude Code rather than in this script.
if (process.argv[1] && process.argv[1].endsWith("statusline.js")) {
  renderStatusLine().catch(() => {
    process.stdout.write(`${CYAN}\u25c6${RESET} ${DIM}token-forecaster unavailable${RESET}\n`);
  });
}

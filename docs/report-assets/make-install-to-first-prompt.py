#!/usr/bin/env python3
"""Render docs/report-assets/install-to-first-prompt.png — the production flow
from build, through install, to the first forecast and the first send.

House style borrowed from make-extension-architecture.py:
blue = the shipping path, gray = the lab and the page, amber = the optional
consented paths, green = the gate and the verdict, red = the loop that
deliberately does not exist.
"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle

plt.rcParams["font.family"] = "Helvetica"

INK = "#14161a"
BODY = "#3d434c"
MUTED = "#7c828b"
BLUE = "#2b7cd3"
GRAY = "#7f858d"
AMBER = "#a8720c"
GREEN = "#1a8a2e"
RED = "#dd4436"

W, H = 248.0, 400.0
fig, ax = plt.subplots(figsize=(24.8, 40.0), dpi=100)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
fig.patch.set_facecolor("white")

PAD_TOP, TITLE_H, LINE_H, PAD_BOT = 5.0, 6.6, 4.9, 3.6
LEFT, RIGHT = 6.0, 232.0

ROW5 = [(6, 48), (52, 94), (98, 140), (144, 186), (190, 232)]
ROW4 = [(6, 58), (64, 116), (122, 174), (180, 232)]
ROW3 = [(6, 78), (84, 156), (162, 232)]


def section(y_label, y_rule, label):
    ax.text(LEFT, y_label, label, ha="left", va="center", fontsize=13.0,
            fontweight="bold", color=MUTED)
    ax.plot([LEFT, RIGHT], [y_rule, y_rule], color="#d7dade", lw=1.6, zorder=0)


def box(x0, x1, top, n, title, lines=None, color=BLUE, line_size=10.0,
        title_size=12.4):
    lines = lines or []
    h = PAD_TOP + TITLE_H + len(lines) * LINE_H + PAD_BOT
    y0 = top - h
    ax.add_patch(
        FancyBboxPatch((x0, y0), x1 - x0, h,
                       boxstyle="round,pad=0,rounding_size=1.4",
                       linewidth=2.6, edgecolor=color, facecolor="white",
                       zorder=3)
    )
    cx = (x0 + x1) / 2
    ax.text(cx, top - PAD_TOP - TITLE_H / 2, title, ha="center", va="center",
            fontsize=title_size, fontweight="bold", color=color, zorder=4)
    y = top - PAD_TOP - TITLE_H - LINE_H / 2 - 0.5
    for ln in lines:
        ax.text(cx, y, ln, ha="center", va="center", fontsize=line_size,
                color=BODY, fontweight="bold", zorder=4)
        y -= LINE_H
    if n is not None:
        ax.add_patch(Circle((x0 + 5.0, top - 5.0), 3.2, facecolor=color,
                            edgecolor="white", linewidth=1.6, zorder=6))
        ax.text(x0 + 5.0, top - 5.0, str(n), ha="center", va="center",
                fontsize=10.0, fontweight="bold", color="white", zorder=7)
    return y0


def arrow(p0, p1, color=BLUE, lw=2.6, ls="-", rad=0.0):
    ax.add_patch(FancyArrowPatch(p0, p1, arrowstyle="-|>", linewidth=lw,
                                 color=color, linestyle=ls, mutation_scale=22,
                                 zorder=5, shrinkA=0, shrinkB=0,
                                 connectionstyle=f"arc3,rad={rad}"))


def chain(cols, mid, color=BLUE):
    for (_, x1), (x0, _) in zip(cols, cols[1:]):
        arrow((x1, mid), (x0, mid), color=color)


def note(x, y, text, color=MUTED, size=10.0, ha="center", rotation=0):
    ax.text(x, y, text, ha=ha, va="center", fontsize=size, color=color,
            fontweight="bold", zorder=6, linespacing=1.7, rotation=rotation)


# ---------------------------------------------------------------- header
ax.text(119, 392, "Token Forecaster — install to first forecast, in production",
        ha="center", va="center", fontsize=27, fontweight="bold", color=INK)
ax.text(119, 382,
        "Read top to bottom. Everything on the blue spine happens inside one browser tab, synchronously, with no network call of any kind.\n"
        "The profile is fitted once, offline, before the extension is even packaged; nothing is fitted, calibrated or promoted after that.",
        ha="center", va="center", fontsize=13.0, fontweight="bold",
        color=MUTED, linespacing=1.8)

# ---------------------------------------------------------------- band 0
section(372, 368,
        "0  ·  BEFORE ANYONE INSTALLS ANYTHING  ·  OFFLINE, ON A DEVELOPER MACHINE  ·  THE ONLY PLACE A NUMBER IS EVER FITTED")

T0 = 362.0
B0 = box(*ROW5[0], T0, 1, "~/.claude/**/*.jsonl",
         ["load-history.mjs walks", "parentUuid; text is dropped",
          "in the very same pass"], color=GRAY)
box(*ROW5[1], T0, 2, "pnpm evaluate:claude-history",
    ["eval-claude-code-history.mjs", "then eval-winning-boost.mjs",
     "quantile rungs + boost trees"], color=GRAY, title_size=11.4)
box(*ROW5[2], T0, 3, "the adoption gate",
    ["block bootstrap over sessions", "must beat the shipped profile",
     "on a chronological holdout"], color=GREEN)
box(*ROW5[3], T0, 4, "bundled-profile.ts",
    ["235 KB frozen literal", "groups · turnTotals · trees",
     "single-user-corpus, personal:false"], color=BLUE, line_size=9.4)
box(*ROW5[4], T0, 5, "pnpm build:extension",
    ["esbuild -> dist/", "content.js IIFE, profile inlined",
     "TF_TELEMETRY_ORIGIN into manifest"], color=BLUE, line_size=9.2)

chain(ROW5, (T0 + B0) / 2, color=GRAY)
note(120, B0 - 4.0,
     "the browser will only ever run a frozen artefact: no learning code, no fitting code and no training data are packaged at all",
     color=BLUE)

# ---------------------------------------------------------------- band 1
section(324, 320, "1  ·  INSTALL  ·  ONCE, AND NEVER AGAIN ON AN UPDATE")

T1 = 314.0
B1 = box(*ROW3[0], T1, 6, "Chrome loads dist/",
         ["manifest v3  ·  permissions: storage, alarms",
          "optional_host_permissions only — nothing granted yet",
          "content script registered for https://claude.ai/*"], color=GRAY)
box(*ROW3[1], T1, 7, "sw.js  ·  runtime.onInstalled",
    ["shouldOpenWelcome(reason, onboardingSeenVersion)",
     "reason 'install' only; an auto-update opens nothing",
     "alarms.create('tf-telemetry-flush', every 5 minutes)"], color=BLUE)
box(*ROW3[2], T1, 8, "welcome.html opens once",
    ["writes the same chrome.storage.local settings object",
     "profile-info.ts names the profile and says personal:false",
     "both contribution checkboxes ship UNCHECKED"], color=BLUE)

chain(ROW3, (T1 + B1) / 2)
note(120, B1 - 4.0,
     "onboardingSeenVersion is written only AFTER the tab actually opens, so a browser that refuses the tab lets the next install try again   ·   "
     "the worker never imports the predictor, so 235 KB of quantiles stay out of the process that starts on every browser launch")

# ---------------------------------------------------------------- band 2
section(276, 272,
        "2  ·  THE TAB  ·  https://claude.ai/code  ·  content.js RUNS AT document_idle, IN ITS OWN ISOLATED WORLD")

T2 = 266.0
B2 = box(*ROW4[0], T2, 9, "content/index.ts boots",
         ["loadSettings() -> chrome.storage.local",
          "subscribeSettings() for live changes",
          "surfaceFromPath(): /code, or chat if enabled"], color=BLUE,
         line_size=9.4)
box(*ROW4[1], T2, 10, "anchor.ts  ·  watchComposer",
    ["selector ladder ending in a heuristic:",
     "the largest editable box on the page",
     "chip.attachTo() mounts a Shadow DOM"], color=BLUE, line_size=9.4)
box(*ROW4[2], T2, 11, "extract.ts  ·  readPage()",
    ["model label · effort · thinking evidence",
     "attachments · assistant-message count",
     "visible transcript, throttled to 1/s"], color=BLUE, line_size=9.4)
box(*ROW4[3], T2, 12, "scheduleTick()",
    ["1 s idle, 300 ms while a reply writes",
     "an interval, not a MutationObserver:",
     "a stream mutates continuously"], color=BLUE, line_size=9.4)

chain(ROW4, (T2 + B2) / 2)
note(120, B2 - 4.0,
     "if the ladder ever fails the chip hides itself; it never breaks the page")

# ---------------------------------------------------------------- band 3
section(228, 224,
        "3  ·  THE FIRST KEYSTROKE  ·  ONE DOCUMENT-LEVEL 'input' LISTENER IN THE CAPTURE PHASE COVERS THE WHOLE EDITOR")

T3 = 218.0
B3 = box(*ROW4[0], T3, 13, "recompute  ·  120 ms debounce",
         ["textFromEditable(composer)",
          "then readPage() if the throttle allows"], color=BLUE, line_size=9.4,
         title_size=11.6)
box(*ROW4[1], T3, 14, "@token-forecaster/token-counter",
    ["estimateTokensFromText(): char heuristic",
     "CountReconciler.noteInputChanged()"], color=BLUE, line_size=9.4,
    title_size=11.0)
box(*ROW4[2], T3, 15, "render() builds EngineInput",
    ["model-map.ts: page label -> registry id",
     "thinking.ts: setting -> control -> reply -> assumed"], color=BLUE,
    line_size=9.2, title_size=11.6)
B3R = box(*ROW4[3], T3, 16, "lib/engine.ts  ·  buildViewModel",
          ["the entire prediction, synchronously",
           "no sendMessage, no worker, no network"], color=BLUE, line_size=9.4,
          title_size=11.6)

chain(ROW4, (T3 + B3) / 2)
box(6, 172, B3 - 6.0, 17,
    "OPTIONAL, OFF BY DEFAULT  ·  verified counting  ·  a second 750 ms debounce",
    ["content.js -> chrome.runtime.sendMessage(COUNT_TOKENS) -> sw/index.ts -> POST api.anthropic.com/v1/messages/count_tokens",
     "the worker reads the API key from storage itself, so it never enters the page's world; only the draft is sent, never the conversation",
     "on success CountReconciler swaps the label from 'estimate' to 'counted' and the pill's dot turns green"],
    color=AMBER, line_size=9.4, title_size=11.6)
note(204, B3 - 21.0,
     "the forecast never waits on this:\n"
     "the band is already drawn from the\n"
     "local estimate before the request is made",
     color=AMBER)

# ---------------------------------------------------------------- band 4
section(148, 144,
        "4  ·  THE FORECAST ITSELF  ·  @token-forecaster/predictor, READING THE PROFILE COMPILED INTO content.js")

T4 = 138.0
B4 = box(*ROW5[0], T4, 18, "promptForecastFeatures",
         ["characterCount · requirements", "hasLimit · hasExpansive",
          "artifactIntent · requestedFormat",
          "deliverableType · followupCompression"], color=BLUE, line_size=9.0,
         title_size=11.0)
box(*ROW5[1], T4, 19, "historicalBaselineForecast",
    ["rung ladder, specific first:", "model|thinking|effort|task  ->  ...",
     "-> model|thinking  ->  model  -> pooled",
     "first rung with enough samples wins"], color=BLUE, line_size=9.0,
    title_size=11.0)
box(*ROW5[2], T4, 20, "applyQuantileBoost",
    ["the per-call correction tree", "loopDepth 0, priorCallCount 0 is",
     "EXACT for a composer message,", "so the correction really applies"],
    color=BLUE, line_size=9.0)
box(*ROW5[3], T4, 21, "historicalTurnTotalForecast",
    ["pooled turn-opener rungs, then", "the turnTotalBoost tree",
     "the whole agent loop, not one call:", "this is what reads your wording"],
    color=BLUE, line_size=9.0, title_size=10.6)
box(*ROW5[4], T4, 22, "core + model-registry",
    ["calculateContextBudget() -> meter", "projectCostUsd() -> dollar range",
     "confidence HARD-CAPPED to 'low'", "until the transfer probe clears"],
    color=BLUE, line_size=9.0, title_size=11.4)

chain(ROW5, (T4 + B4) / 2)
note(120, B4 - 4.0,
     "one debounce, zero I/O: p50 · p90 · p99 for the next call, the same three for the whole turn, plus geometry, strings and aria labels")

# ---------------------------------------------------------------- band 5
section(95, 91, "5  ·  WHAT THE USER SEES, AND WHAT HAPPENS THE MOMENT THEY SEND")

T5 = 85.0
B5 = box(*ROW5[0], T5, 23, "chip.render(view)",
         ["pill · band · meter · panel", "all inside a Shadow DOM",
          "every decision already made"], color=BLUE)
box(*ROW5[1], T5, 24, "view.snapshot kept",
    ["the last non-empty draft's", "forecast, held on the composer",
     "because that is what gets sent"], color=BLUE, line_size=9.4)
box(*ROW5[2], T5, 25, "armTurn()",
    ["keydown Enter, or pointerdown", "on the send button — pointerdown,",
     "so it freezes BEFORE the turn starts"], color=BLUE, line_size=9.0)
box(*ROW5[3], T5, 26, "TurnTracker.tick()  300 ms",
    ["re-estimates the visible reply", "with the same char heuristic",
     "walks the chip to the writing edge"], color=BLUE, line_size=9.0,
    title_size=11.0)
box(*ROW5[4], T5, 27, "VerdictLayer",
    ["badge pinned under the reply", "'FORECAST SO FAR' ledger line",
     "only turns it forecast are scored"], color=GREEN, line_size=9.2)

chain(ROW5, (T5 + B5) / 2)
note(120, B5 - 4.0,
     "the frozen snapshot is NEVER recomputed mid-turn — only the marker moves — because a prediction that drifts towards the outcome cannot be checked against it",
     color=GREEN)

# ---------------------------------------------------------------- band 6
section(47, 43, "6  ·  WHAT LEAVES THE BROWSER  ·  AND WHAT NEVER, EVER TRAINS")

T6 = 37.0
B6 = box(*ROW4[0], T6, 28, "default build",
         ["TF_TELEMETRY_ORIGIN is empty",
          "the collector is not even in the manifest",
          "zero network requests, ever"], color=GRAY, line_size=9.4)
box(*ROW4[1], T6, 29, "consented build + a click",
    ["Chrome is asked for the host permission",
     "from the consent click, not at install",
     "queue: 250 max, batches of 25, 5 min alarm"], color=AMBER,
    line_size=9.0, title_size=11.6)
B6C = box(*ROW4[2], T6, 30, "extension-ingest.ts",
          ["POST /v1/installations, POST /v1/events",
           "zod schema, rate limits, JSONL append",
           "DELETE revokes and physically removes rows"], color=AMBER,
          line_size=9.0)
box(*ROW4[3], T6, 31, "NOTHING TRAINS IN PRODUCTION",
    ["no online update, no per-user calibration",
     "no automatic promotion of anything",
     "MV3 cannot read ~/.claude in the first place"], color=RED,
    line_size=9.0, title_size=10.6)

chain(ROW4, (T6 + B6) / 2, color=AMBER)
note(120, B6 - 4.0,
     "every research row is tagged  outputTokenQuality: \"dom_estimate\"  and  forecastScale: \"call\" | \"turn\",  so a screen-read reply can never enter a provider-exact fit",
     color=AMBER)

# the only way a collected row becomes a shipped number: back to band 0, by hand.
# Routed through the free margins so it crosses no box on the way.
m6 = (T6 + B6C) / 2
lane_x, lane_y_bot, lane_y_top = 241.0, 46.0, 365.0
seg = [(ROW4[2][1], m6), (177.0, m6), (177.0, lane_y_bot),
       (lane_x, lane_y_bot), (lane_x, lane_y_top),
       ((ROW5[1][0] + ROW5[1][1]) / 2, lane_y_top)]
for (x0, y0), (x1, y1) in zip(seg, seg[1:]):
    ax.plot([x0, x1], [y0, y1], color=RED, lw=2.4, ls=(0, (5, 4)), zorder=5,
            solid_capstyle="butt")
arrow(seg[-1], (seg[-1][0], T0), color=RED, ls=(0, (5, 4)), lw=2.4)
note(245.5, 200, "a collected row is evidence for a HUMAN-RUN re-fit  —  never an automatic promotion",
     color=RED, rotation=90)

fig.savefig("docs/report-assets/install-to-first-prompt.png",
            facecolor="white", bbox_inches="tight", pad_inches=0.4)
print("wrote docs/report-assets/install-to-first-prompt.png")

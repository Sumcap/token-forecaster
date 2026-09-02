#!/usr/bin/env python3
"""Render docs/report-assets/extension-architecture.png — what runs where when
the Chrome extension is in production.

Same house style as make-architecture.py: white ground, heavy sans,
blue = the shipping path, amber = the optional consented path, gray = the lab,
green = the verdict, red = the path that deliberately does not exist.
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

W, H = 240.0, 288.0
fig, ax = plt.subplots(figsize=(24.0, 28.8), dpi=100)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
fig.patch.set_facecolor("white")

PAD_TOP, TITLE_H, LINE_H, PAD_BOT = 5.0, 6.6, 4.9, 3.6
LEFT, RIGHT = 6.0, 222.0


def section(y_label, y_rule, label):
    ax.text(LEFT, y_label, label, ha="left", va="center", fontsize=13.5,
            fontweight="bold", color=MUTED)
    ax.plot([LEFT, RIGHT], [y_rule, y_rule], color="#d7dade", lw=1.6, zorder=0)


def box(x0, x1, top, n, title, lines=None, color=BLUE, line_size=10.4,
        title_size=13.6):
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
        ax.add_patch(Circle((x0 + 5.4, top - 5.4), 3.4, facecolor=color,
                            edgecolor="white", linewidth=1.6, zorder=6))
        ax.text(x0 + 5.4, top - 5.4, str(n), ha="center", va="center",
                fontsize=10.5, fontweight="bold", color="white", zorder=7)
    return y0


def arrow(p0, p1, color=BLUE, lw=2.6, ls="-", rad=0.0):
    ax.add_patch(FancyArrowPatch(p0, p1, arrowstyle="-|>", linewidth=lw,
                                 color=color, linestyle=ls, mutation_scale=24,
                                 zorder=5, shrinkA=0, shrinkB=0,
                                 connectionstyle=f"arc3,rad={rad}"))


def note(x, y, text, color=MUTED, size=10.4, ha="center", rotation=0):
    ax.text(x, y, text, ha=ha, va="center", fontsize=size, color=color,
            fontweight="bold", zorder=6, linespacing=1.7, rotation=rotation)


# ---------------------------------------------------------------- header
ax.text(120, 280, "Token Forecaster for claude.ai — what runs where in production",
        ha="center", va="center", fontsize=27, fontweight="bold", color=INK)
ax.text(120, 271,
        "The forecast is local, offline and synchronous. Every network call is optional, separately consented, and owned by the service worker.\n"
        "Nothing is trained in the browser or on the collector: the profile is fitted offline, gated, and shipped as a frozen constant inside content.js.",
        ha="center", va="center", fontsize=13.0, fontweight="bold",
        color=MUTED, linespacing=1.8)

# ---------------------------------------------------------------- lane 1
section(258, 254, "1  ·  IN THE BROWSER   ·   THE ONLY PATH A FORECAST EVER TAKES   ·   ZERO NETWORK REQUESTS")

T1, B1 = 248.0, 219.9
box(6, 56, T1, 1, "claude.ai/code",
    ["the composer's draft text", "model + effort labels",
     "visible transcript, attachments"], color=GRAY)
box(62, 112, T1, 2, "content.js   (IIFE)",
    ["anchor · extract · turn-tracker", "chip + verdicts in a Shadow DOM",
     "arms on send, freezes the forecast"])
box(118, 168, T1, 3, "lib/engine.ts",
    ["local char-heuristic input count", "band geometry, meter, cost, strings",
     "no DOM, no chrome.*  —  all testable"])
box(172, 222, T1, 4, "@token-forecaster/predictor",
    ["rung ladder, then boost trees", "per-call AND whole-turn quantiles",
     "BUNDLED_CLAUDE_CODE_PROFILE"])

mid1 = (T1 + B1) / 2
arrow((56, mid1), (62, mid1), color=GRAY)
arrow((112, mid1), (118, mid1))
arrow((168, mid1), (172, mid1))
arrow((197, B1), (143, B1), rad=-0.30)
note(170, 208.5, "p50 · p90 · p99, and the whole-turn total the /code chip scores against")
arrow((87, B1), (31, B1), rad=-0.30)
note(59, 208.5, "the pill, the panel, the live badge")
note(114, 201.5,
     "all bundled into content.js:   token-counter (local estimate + reconciler)   ·   core (context budget, schemas)   ·   model-registry (context window, output cap, list prices)",
     color=BLUE)

# ---------------------------------------------------------------- lane 2
section(192, 188, "2  ·  THE SERVICE WORKER   ·   THE ONLY PRIVILEGED BOUNDARY   ·   BOTH PATHS OFF BY DEFAULT")

T2 = 182.0
B2_4 = box(6, 80, T2, 5, "sw/index.ts",
           ["reads the API key itself, so it never",
            "enters the page's world",
            "enforces consent per event kind",
            "chrome.alarms flush every 5 minutes"], color=AMBER)
B2_3 = box(92, 152, T2, 6, "api.anthropic.com  ·  count_tokens",
           ["opt-in verified counting",
            "the user's own key, draft text only",
            "the conversation is never sent"], color=AMBER, title_size=12.4)
box(162, 222, T2, 7, "sw/telemetry.ts  ·  durable queue",
    ["chrome.storage.local, 250 events max",
     "batches of 25, idempotent event ids",
     "diagnostics and research consented apart"], color=AMBER, title_size=12.4)

arrow((87, B1 - 0.2), (30, T2), color=AMBER, rad=-0.16)
note(52, 194.5, "chrome.runtime.sendMessage", color=AMBER)
mid2 = (T2 + B2_3) / 2
arrow((80, mid2), (92, mid2), color=AMBER)
arrow((152, mid2), (162, mid2), color=AMBER)
note(114, 145.5,
     "the collector origin is a BUILD-TIME constant (TF_TELEMETRY_ORIGIN, written into optional_host_permissions); an empty origin builds an offline-only extension,\n"
     "and Chrome is asked for that host permission from the user's own consent click — never at install time",
     color=AMBER)

# ---------------------------------------------------------------- lane 3
section(133, 129, "3  ·  THE COLLECTOR VM   ·   COLLECTION ONLY   ·   NOTHING IS TRAINED OR PROMOTED HERE")

T3 = 123.0
box(6, 56, T3, 8, "TLS edge",
    ["HTTPS proxy / load balancer", "rate limits, request-size caps",
     "never logs bodies or auth headers"], color=GRAY)
B3_4 = box(62, 112, T3, 9, "telemetry-server.mjs",
           ["POST /v1/installations", "POST /v1/events   (25 per batch max)",
            "DELETE /v1/installations/current",
            "GET /healthz   (only public route)"], color=GRAY)
box(118, 168, T3, 10, "append-only JSONL  ·  0600",
    ["extension-events.jsonl", "installations.jsonl — token HASHES only",
     "no shared secret ships in the extension"], color=GRAY)
box(172, 222, T3, 11, "telemetry:report:extension",
    ["call and turn scales kept apart", "15 installs / 20 sessions to open a study",
     "8+ users before a segment is publishable"], color=GRAY)

arrow((192, B2_3), (31, T3), color=AMBER, rad=0.10)
note(118, 126.0, "HTTPS, and only after the user has granted a consent", color=AMBER)
mid3 = T3 - 16.0
arrow((56, mid3), (62, mid3), color=GRAY)
arrow((112, mid3), (118, mid3), color=GRAY)
arrow((168, mid3), (172, mid3), color=GRAY)
note(114, 84.0,
     "every research row is tagged  outputTokenQuality: \"dom_estimate\"  and  forecastScale: \"call\" | \"turn\",  so a screen-read reply can never enter a provider-exact fit",
     color=GRAY)

# ---------------------------------------------------------------- lane 4
section(76, 72, "4  ·  OFFLINE, ON A DEVELOPER MACHINE   ·   WHERE THE PROFILE IS ACTUALLY TRAINED")

T4, B4 = 66.0, 37.9
box(6, 46, T4, 12, "~/.claude transcripts",
    ["471 session files", "16,687 eligible calls",
     "censored calls excluded"], color=GRAY, title_size=12.4)
box(50.5, 90.5, T4, 13, "lib/load-history.mjs",
    ["counts, booleans, buckets", "prompt text discarded",
     "in the very same pass"], color=GRAY, title_size=12.4)
box(95, 135, T4, 14, "eval-claude-code-history",
    ["rung ladder + quantiles", "chronological holdout",
     "descriptive stats + report"], color=GRAY, title_size=12.4)
box(139.5, 179.5, T4, 15, "eval-winning-boost",
    ["quantile-correction trees", "rolling-origin scoring",
     "segment breakdowns"], color=GRAY, title_size=12.4)
box(182, 222, T4, 16, "the adoption gate",
    ["block bootstrap over SESSIONS", "the whole 95% CI below zero",
     "or the change does not ship"], color=GREEN, title_size=12.4)

mid4 = T4 - 16.0
for x0, x1 in [(46, 50.5), (90.5, 95), (135, 139.5), (179.5, 182)]:
    arrow((x0, mid4), (x1, mid4), color=GRAY)

T5 = 29.0
box(6, 76, T5, 17, "packages/predictor/src/bundled-profile.ts",
    ["privacy-safe aggregates and shallow trees only",
     "id claude-code-local-2026-08-12  ·  single-user-corpus"],
    color=BLUE, title_size=12.4)
B5 = box(86, 156, T5, 18, "apps/extension/build.mjs   (esbuild)",
         ["content.js as IIFE, sw.js and the pages as ESM",
          "TF_TELEMETRY_ORIGIN written into the manifest"],
         color=BLUE, title_size=12.4)
box(166, 222, T5, 19, "dist/  ·  Chrome Web Store",
    ["the frozen profile travels inside content.js",
     "nothing adapts to the installing user"], color=BLUE, title_size=12.4)

arrow((202, B4), (41, T5), color=GREEN, rad=-0.05)
note(120, 34.8, "only a profile that beat the one already shipped is compiled in", color=GREEN)
mid5 = (T5 + B5) / 2
arrow((76, mid5), (86, mid5))
arrow((156, mid5), (166, mid5))

# the loop back into the browser, hugging the right margin
arrow((222, mid5), (222, B1 + 6), rad=-0.16, ls=(0, (6, 4)), lw=2.4)
note(236, 130, "the browser only ever runs a frozen artefact", color=BLUE, rotation=90)

# the path that deliberately does not exist
arrow((150, 90.2), (206, T4), color=RED, ls=(0, (5, 4)), lw=2.4, rad=-0.32)
note(186, 96.5, "evidence for a HUMAN-RUN evaluation —\nnever an automatic promotion", color=RED)

fig.savefig("docs/report-assets/extension-architecture.png",
            facecolor="white", bbox_inches="tight", pad_inches=0.4)
print("wrote docs/report-assets/extension-architecture.png")

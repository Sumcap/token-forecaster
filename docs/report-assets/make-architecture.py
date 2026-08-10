#!/usr/bin/env python3
"""Render docs/report-assets/architecture.png — where L_p sits in the system.

Styled to match the other REPORT-2026-08-09 assets: white ground, heavy sans,
blue = the thing that ships, gray = the lab, amber = the object of interest,
green/red = the verdict.
"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle

plt.rcParams["font.family"] = "Helvetica"
plt.rcParams["mathtext.fontset"] = "stixsans"
plt.rcParams["mathtext.default"] = "it"

INK = "#14161a"
BODY = "#3d434c"
MUTED = "#7c828b"
BLUE = "#2b7cd3"
GRAY = "#7f858d"
AMBER = "#a8720c"
GREEN = "#1a8a2e"
RED = "#dd4436"

W, H = 220.0, 178.0
fig, ax = plt.subplots(figsize=(22.0, 17.8), dpi=100)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
fig.patch.set_facecolor("white")

PAD_TOP, TITLE_H, LINE_H, PAD_BOT = 4.2, 6.4, 4.7, 3.4


def section(y_label, y_rule, label, x=6):
    ax.text(x, y_label, label, ha="left", va="center", fontsize=13.5,
            fontweight="bold", color=MUTED)
    ax.plot([6, 214], [y_rule, y_rule], color="#d7dade", lw=1.6, zorder=0)


def step(x0, top, n, color):
    if n is None:
        return
    ax.add_patch(Circle((x0 + 5.0, top + 5.4), 3.6, facecolor=color,
                        edgecolor="white", linewidth=2.0, zorder=6))
    ax.text(x0 + 5.0, top + 5.4, str(n), ha="center", va="center",
            fontsize=11.5, fontweight="bold", color="white", zorder=7)


def box(x0, x1, top, n, title, lines=None, color=BLUE, line_size=11.0,
        title_size=15.0, height=None):
    lines = lines or []
    h = height or (PAD_TOP + TITLE_H + len(lines) * LINE_H + PAD_BOT)
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
    y = top - PAD_TOP - TITLE_H - LINE_H / 2 - 0.4
    for ln in lines:
        ax.text(cx, y, ln, ha="center", va="center", fontsize=line_size,
                color=BODY, fontweight="bold", zorder=4)
        y -= LINE_H
    step(x0, top, n, color)
    return y0


def arrow(p0, p1, color=BLUE, lw=2.6, ls="-", cs="arc3,rad=0"):
    ax.add_patch(FancyArrowPatch(p0, p1, arrowstyle="-|>", linewidth=lw,
                                 color=color, linestyle=ls, mutation_scale=26,
                                 zorder=5, shrinkA=0, shrinkB=0,
                                 connectionstyle=cs))


def note(x, y, text, color=MUTED, size=11.0, ha="center", weight="bold"):
    ax.text(x, y, text, ha=ha, va="center", fontsize=size, color=color,
            fontweight=weight, zorder=6, linespacing=1.6)


# ---------------------------------------------------------------- header
ax.text(110, 172, "The predictor makes the forecast. The loss only grades it.",
        ha="center", va="center", fontsize=26, fontweight="bold", color=INK)
ax.text(110, 164.5,
        "$L_p$ needs $y$, and $y$ does not exist until the reply is already back — so the loss can never steer a live forecast.\n"
        "It can only choose which predictor makes the next one.",
        ha="center", va="center", fontsize=13.5, fontweight="bold",
        color=MUTED, linespacing=1.7)

# ---------------------------------------------------------------- lane 1
section(155, 152.5, "BEFORE THE CALL   ·   THIS IS THE PART THAT SHIPS")

known = box(6, 46, 141, 1, "Known up front",
            ["model  ·  thinkingEnabled", "effort  ·  taskType",
             "promptMentionsPath", "maxTokens"])
note(26, 103, "sheep-manager composes the call itself,\nso it holds every one of these up front",
     size=10.5)

# ladder
lad_top, lad_bot = 141, 82
ax.add_patch(FancyBboxPatch((52, lad_bot), 44, lad_top - lad_bot,
                            boxstyle="round,pad=0,rounding_size=1.4",
                            linewidth=2.6, edgecolor=BLUE, facecolor="white",
                            zorder=3))
step(52, lad_top, 2, BLUE)
ax.text(74, lad_top - PAD_TOP - TITLE_H / 2, "Rung ladder", ha="center",
        va="center", fontsize=15, fontweight="bold", color=BLUE, zorder=4)
ax.text(74, 125.5, "takes the first group with $\\geq$ 100 samples",
        ha="center", va="center", fontsize=10.2, fontweight="bold",
        color=MUTED, zorder=4)
rungs = [
    "model + thinking + effort + task",
    "model + thinking + effort",
    "model + thinking + promptPath",
    "model + thinking",
    "model",
    None,
    "thinking + effort  ·  thinking",
    "promptPath  ·  overall  ·  static",
]
ry = 120.0
for label in rungs:
    if label is None:
        ax.plot([55, 93], [ry + 0.6, ry + 0.6], color=AMBER, lw=1.6,
                ls=(0, (5, 3)), zorder=4)
        ax.text(74, ry - 3.6, "unknown model  ·  usedFallback  ·  no boost",
                ha="center", va="center", fontsize=9.4, fontweight="bold",
                color=AMBER, zorder=4)
        ry -= 8.0
        continue
    ax.text(74, ry, label, ha="center", va="center", fontsize=10.6,
            fontweight="bold", color=BLUE if ry > 99 else AMBER, zorder=4)
    ry -= 4.3

prof = box(52, 96, 78, None, "Bundled profile",
           ["p50  ·  p90  ·  p99  ·  n,  per group", "ships inside the package",
            "rebuilt only from opt-in telemetry"],
           color=GRAY, line_size=10.4)
arrow((74, 78), (74, 82), color=GRAY)

boost = box(102, 136, 141, 3, "Boosted correction",
            ["$\\Delta_p=\\eta\\,\\sum_{t=1}^{24}\\,\\mathrm{tree}_t(x)$", "",
             "$\\eta=0.12$   ·   depth-2 trees",
             "36 pre-call features", "",
             "added to the ladder's base$_p$;",
             "skipped when context is thin"],
            line_size=9.8)

fc = box(142, 176, 141, 4, "The forecast  $\\hat{q}$",
         ["$\\hat{q}_p = \\mathrm{base}_p + \\Delta_p$",
          "clipped to $[\\,0,\\ \\mathrm{maxTokens}\\,]$",
          "then forced monotone", "",
          "p50        p90        p99",
          "this call:   730   ·   2,100", "",
          "confidence  ·  usedFallback"],
         line_size=9.8)

send = box(182, 214, 141, 5, "Reserve and send",
           ["$R = \\hat{q}_{0.9}$   by default",
            "$R = \\hat{q}_{0.99}$   when an",
            "overflow is expensive", "",
            "$R$ books context window;",
            "it never sets maxTokens", "",
            "this call:  $R = 2{,}100$"],
           line_size=9.8)
note(190, 84, "choosing $p$ prices one overflow\n"
              "token at $k=p/(1-p)$ wasted ones:\n"
              "$k=9$ at p90,   $k=99$ at p99",
     color=AMBER, size=9.8)

arrow((46, 124), (52, 124))
arrow((96, 124), (102, 124))
arrow((136, 124), (142, 124))
arrow((176, 124), (182, 124))

# ---------------------------------------------------------------- handoff
ax.plot([159, 159], [fc, 35], color=BLUE, lw=2.6, zorder=2)
arrow((159, 43), (159, 35), color=BLUE)
note(155, 70, "the three quantiles\nwe published", ha="right", color=BLUE, size=11)

ax.plot([210, 210], [send, 35], color=AMBER, lw=2.6, zorder=2)
arrow((210, 43), (210, 35), color=AMBER)
note(206, 62, "the reply comes back:\n$y$ = what the length\nactually turned out to be",
     ha="right", color=AMBER, size=11)

# ---------------------------------------------------------------- lane 2
section(48, 45.5, "AFTER THE CALL   ·   NEVER LEAVES THE LAB", x=24)

# loss box — the anchor
lx0, ly0, lx1, ly1 = 130, 0, 214, 35
ax.add_patch(FancyBboxPatch((lx0, ly0), lx1 - lx0, ly1 - ly0,
                            boxstyle="round,pad=0,rounding_size=1.6",
                            linewidth=3.4, edgecolor=AMBER,
                            facecolor="#fdf7ea", zorder=3))
step(lx0, ly1, 6, AMBER)
ax.text(172, ly1 - 5.6, "Pinball loss    $L_p(y,\\hat{q})$", ha="center",
        va="center", fontsize=17, fontweight="bold", color=AMBER, zorder=4)
ax.text(136, 20.4, "{", ha="left", va="center", fontsize=46, color=AMBER,
        zorder=4)
ax.text(141, 24.0, "$p\\,(y-\\hat{q})$", ha="left", va="center", fontsize=15,
        color=INK, zorder=4)
ax.text(160, 24.0, "if $y \\geq \\hat{q}$", ha="left", va="center", fontsize=12,
        fontweight="bold", color=BODY, zorder=4)
ax.text(176, 24.0, "GUESSED UNDER — COSTLY", ha="left", va="center",
        fontsize=10.2, fontweight="bold", color=RED, zorder=4)
ax.text(141, 16.4, "$(1-p)\\,(\\hat{q}-y)$", ha="left", va="center",
        fontsize=15, color=INK, zorder=4)
ax.text(160, 16.4, "if $y < \\hat{q}$", ha="left", va="center", fontsize=12,
        fontweight="bold", color=BODY, zorder=4)
ax.text(176, 16.4, "GUESSED OVER — CHEAP", ha="left", va="center",
        fontsize=10.2, fontweight="bold", color=GREEN, zorder=4)
ax.plot([136, 208], [11.2, 11.2], color=AMBER, lw=1.4, alpha=0.6, zorder=4)
ax.text(172, 7.4, "scored per call at all three levels:    $L_{0.5} + L_{0.9} + L_{0.99}$",
        ha="center", va="center", fontsize=13, fontweight="bold", color=INK,
        zorder=4)
ax.text(172, 2.8,
        "same call as the ELI5 poster:  $R$ = 2,100, reply came back $y$ = 1,500  $\\rightarrow$  0.1 $\\times$ 600 = 60",
        ha="center", va="center", fontsize=10.6, fontweight="bold",
        color=MUTED, zorder=4)

delta = box(96, 124, 35, 7, "Per-call  $\\Delta$",
            ["$\\Delta_i = L_i^{\\,cand} - L_i^{\\,cur}$", "",
             "both predictors scored on", "the same held-out calls"],
            color=GRAY, line_size=10.4)

boot = box(60, 90, 35, 8, "Bootstrap",
           ["resamples whole sessions,", "never single calls", "",
            "$\\rightarrow$  95% CI on $\\bar{\\Delta}$"],
           color=GRAY, line_size=10.4, title_size=14.5)

gate = box(24, 54, 35, 9, "The gate",
           ["is the whole interval", "below zero?", "",
            "$CI_{97.5\\%}(\\bar{\\Delta}) < 0$"],
           color=GRAY, line_size=10.4)

arrow((130, 22), (124, 22), color=GRAY)
arrow((96, 22), (90, 22), color=GRAY)
arrow((60, 22), (54, 22), color=GRAY)

# verdict chips
for y0c, y1c, label, col in [(24, 32, "SHIP", GREEN), (10, 18, "REJECT", RED)]:
    ax.add_patch(FancyBboxPatch((4, y0c), 16, y1c - y0c,
                                boxstyle="round,pad=0,rounding_size=1.4",
                                linewidth=0, facecolor=col, zorder=4))
    ax.text(12, (y0c + y1c) / 2, label, ha="center", va="center",
            fontsize=13, fontweight="bold", color="white", zorder=5)
arrow((24, 25), (20, 28), color=GREEN)
arrow((24, 19), (20, 14), color=RED)
note(12, 5.6, "recorded, never retried", color=RED, size=9.6)

arrow((12, 32), (52, 64), color=GREEN, lw=2.6,
      cs="angle,angleA=90,angleB=180,rad=6")
note(16, 70, "the only way the\nprofile ever changes", ha="left",
     color=GREEN, size=10.6)

fig.savefig(
    "/Users/polpedu/Projects/token-forecaster/docs/report-assets/architecture.png",
    bbox_inches="tight", pad_inches=0.4, facecolor="white",
)
print("ok")

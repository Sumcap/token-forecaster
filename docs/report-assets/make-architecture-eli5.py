#!/usr/bin/env python3
"""Render docs/report-assets/architecture-eli5.png — the plain-language version.

Companion to architecture.png. Same nine numbered steps, same order, same
colours, no notation. Step n here IS step n there, so the two can be read side
by side.

Two house rules for this asset:

1. Nothing is named that is not connected. Every step says which earlier step
   it consumes, every arrow carries the thing being handed down, and no number
   appears that was not produced by a box above it.
2. The loop closes. The last step feeds the shelf that the second step reads
   from, drawn as a real return path rather than implied by a caption.
"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pathlib

OUT = pathlib.Path(__file__).resolve().parent
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle

plt.rcParams["font.family"] = "Helvetica"
plt.rcParams["mathtext.fontset"] = "stixsans"

INK = "#14161a"
BODY = "#3d434c"
MUTED = "#7c828b"
BLUE = "#2b7cd3"
GRAY = "#7f858d"
AMBER = "#a8720c"
GREEN = "#1a8a2e"
RED = "#dd4436"
WASH = "#f3f7fc"

W, H = 172.0, 346.0
fig, ax = plt.subplots(figsize=(17.2, 34.6), dpi=100)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
fig.patch.set_facecolor("white")

ROW_H = 15.0
GAP = 7.0
X0, X1 = 16.0, 166.0


def section(y, label):
    ax.text(X0, y, label, ha="left", va="center", fontsize=12.5,
            fontweight="bold", color=MUTED)
    ax.plot([X0, X1], [y - 3.4, y - 3.4], color="#d7dade", lw=1.6, zorder=0)
    return y - 8.0


def row(top, n, headline, plain, chip, chip_label, color=BLUE, plain2=None):
    """One step: headline, one plain sentence, one number chip.

    `plain` always names the step it consumes, so no box stands alone.
    `n` is None for the shelf, which is unnumbered in architecture.png too.
    `plain2` adds a second sentence and grows the box — used only where a word
    has to be defined rather than merely used.
    """
    h = ROW_H + (5.2 if plain2 else 0.0)
    y0 = top - h
    ax.add_patch(
        FancyBboxPatch((X0, y0), X1 - X0, h,
                       boxstyle="round,pad=0,rounding_size=1.4",
                       linewidth=2.4, edgecolor=color, facecolor="white",
                       zorder=3)
    )
    if n is not None:
        ax.add_patch(Circle((X0, top - h / 2), 4.4, facecolor=color,
                            edgecolor="white", linewidth=2.2, zorder=6))
        ax.text(X0, top - h / 2, str(n), ha="center", va="center",
                fontsize=13, fontweight="bold", color="white", zorder=7)
    ax.text(25, top - 5.3, headline, ha="left", va="center", fontsize=14.0,
            fontweight="bold", color=color, zorder=4)
    ax.text(25, top - 11.1, plain, ha="left", va="center", fontsize=11.0,
            fontweight="bold", color=BODY, zorder=4)
    if plain2:
        ax.text(25, top - 16.3, plain2, ha="left", va="center", fontsize=11.0,
                fontweight="bold", color=BODY, zorder=4)
    ax.add_patch(
        FancyBboxPatch((114, y0 + 2.4), 49, h - 4.8,
                       boxstyle="round,pad=0,rounding_size=1.2",
                       linewidth=0, facecolor=WASH, zorder=4)
    )
    ax.text(138.5, top - h / 2 + 2.2, chip, ha="center", va="center",
            fontsize=13, fontweight="bold", color=INK, zorder=5)
    ax.text(138.5, top - h / 2 - 2.6, chip_label, ha="center", va="center",
            fontsize=9.0, fontweight="bold", color=MUTED, zorder=5)
    return y0


def handoff(y, label, color=BLUE):
    """The labelled arrow. The label IS the thing the next box receives."""
    ax.add_patch(FancyArrowPatch((32, y), (32, y - GAP), arrowstyle="-|>",
                                 linewidth=2.4, color=color, mutation_scale=22,
                                 zorder=5, shrinkA=0, shrinkB=0))
    ax.text(36, y - GAP / 2, label, ha="left", va="center", fontsize=10.2,
            fontweight="bold", color=color, zorder=5)
    return y - GAP


# ---------------------------------------------------------------- header
ax.text(86, 340, "How we guess how long the answer will be",
        ha="center", va="center", fontsize=25, fontweight="bold", color=INK)
ax.text(86, 333.2,
        "One real call, top to bottom, then back to the start. The step numbers match architecture.png —\n"
        "step 4 here is step 4 there. Each box only uses what the box above handed down.",
        ha="center", va="center", fontsize=12.6, fontweight="bold",
        color=MUTED, linespacing=1.7)

# ---------------------------------------------------------------- lane 1
y = section(322, "BEFORE THE CALL   ·   THIS IS THE PART THAT SHIPS")

y = row(y, 1, "What we know before we ask",
        "Two facts. Nothing about the answer, because it does not exist yet.",
        "Opus 5", "thinking: on")
y = handoff(y, "hand down: those two facts")

y = row(y, None, "The shelf of past lengths",
        "Every reply we ever measured, sorted into piles. Ships inside the package.",
        "15,374", "replies on the shelf", color=GRAY)
shelf_mid = y + ROW_H / 2
y = handoff(y, "hand down: the pile matching those two facts", GRAY)

y = row(y, 2, "Read two numbers off that pile",
        "Sort the pile short to long. Take the middle one, and the 9-in-10 one.",
        "500  ·  1,870", "starting guess")
y = handoff(y, "hand down: the starting guess")

y = row(y, 3, "Nudge it for this prompt's wording",
        "The prompt says \"write the whole file\", so step 2's numbers are too low.",
        "+230", "the nudge")
y = handoff(y, "hand down: starting guess + nudge")

y = row(y, 4, "Add them together. That is the guess",
        "500 + 230 = 730 in the middle. 1,870 + 230 = 2,100 for the 9-in-10.",
        "730  ·  2,100", "the final guess")
y = handoff(y, "hand down: the 9-in-10 number, 2,100")

y = row(y, 5, "Set aside that much room, then send",
        "\"Reserve\" = keep 2,100 tokens of the context window free, so the answer "
        "has somewhere to land.",
        "2,100", "room reserved", color=AMBER)
y = handoff(y, "send it, then wait — the reply comes back 1,500 tokens long", AMBER)

# ---------------------------------------------------------------- lane 2
y = section(y - 6.0, "AFTER THE CALL   ·   NEVER LEAVES THE LAB")

y = row(y, 6, "Score the guess, now that we know",
        "Step 5 reserved 2,100. It really was 1,500. Over by 600, which is cheap.",
        "60", "penalty for this call", color=AMBER)
y = handoff(y, "hand down: this call's penalty", GRAY)

y = row(y, 7, "Do that for every call, for both recipes",
        "The recipe we ship and the new candidate, scored on the exact same calls.",
        "15,374", "calls scored twice", color=GRAY)
y = handoff(y, "hand down: the difference, call by call", GRAY)

y = row(y, 8, "Shuffle whole sessions to get an error bar",
        "One lucky session must not decide it, so we resample sessions, not calls.",
        "95%", "confidence interval", color=GRAY)
y = handoff(y, "hand down: the interval", GRAY)

y = row(y, 9, "The gate: better beyond doubt, or rejected",
        "The whole interval must sit below zero. Not most of it. All of it.",
        "SHIP", "or reject, and record it", color=GRAY)
row9_bot = y

# ---------------------------------------------------------------- the loop
LOOP_X = 5.5
turn = row9_bot - 5.0
ax.plot([40, 40], [row9_bot, turn], color=GREEN, lw=2.6, zorder=2)
ax.plot([40, LOOP_X], [turn, turn], color=GREEN, lw=2.6, zorder=2)
ax.plot([LOOP_X, LOOP_X], [turn, shelf_mid], color=GREEN, lw=2.6, zorder=2)
ax.add_patch(FancyArrowPatch((LOOP_X, shelf_mid), (X0 - 4.8, shelf_mid),
                             arrowstyle="-|>", linewidth=2.6, color=GREEN,
                             mutation_scale=24, zorder=5, shrinkA=0, shrinkB=0))
ax.text(2.4, (turn + shelf_mid) / 2,
        "SHIP rebuilds the shelf — the only way step 2's numbers ever change",
        ha="center", va="center", rotation=90, fontsize=11.6,
        fontweight="bold", color=GREEN, zorder=5)
ax.text(44, turn - 3.6, "and only then does the loop close",
        ha="left", va="center", fontsize=10.6, fontweight="bold", color=GREEN,
        zorder=5)

# ---------------------------------------------------------------- the why
py1 = row9_bot - 16.0
py0 = py1 - 55.0
ax.add_patch(FancyBboxPatch((12, py0), 154, py1 - py0,
                            boxstyle="round,pad=0,rounding_size=1.6",
                            linewidth=3.2, edgecolor=AMBER,
                            facecolor="#fdf7ea", zorder=3))
ax.text(89, py1 - 4.8, "Why step 5 reserved 2,100 and not 730",
        ha="center", va="center", fontsize=16.5, fontweight="bold",
        color=AMBER, zorder=4)

ax.text(89, py1 - 11.2,
        "Booking a table before you know how many people turn up. Book too small and the party "
        "does not fit;\nbook generously and a few chairs sit empty. Empty chairs are the "
        "cheaper mistake.",
        ha="center", va="center", fontsize=11.4, fontweight="bold", color=BODY,
        zorder=4, linespacing=1.6)

ax.text(18, py1 - 18.6, "Reserved 2,100  ·  it really was 1,500", ha="left",
        va="center", fontsize=12.0, fontweight="bold", color=BODY, zorder=4)
ax.text(18, py1 - 22.6, "600 tokens of room sat idle", ha="left", va="center",
        fontsize=10.2, fontweight="bold", color=GREEN, zorder=4)
ax.add_patch(FancyBboxPatch((84, py1 - 22.4), 12, 4.4,
                            boxstyle="round,pad=0,rounding_size=0.8",
                            linewidth=0, facecolor=GREEN, zorder=4))
ax.text(99, py1 - 20.2, "penalty 60  —  this is step 6's number", ha="left",
        va="center", fontsize=11.4, fontweight="bold", color=GREEN, zorder=4)

ax.text(18, py1 - 29.8, "Had we reserved 730  ·  it really was 1,500",
        ha="left", va="center", fontsize=12.0, fontweight="bold", color=BODY,
        zorder=4)
ax.text(18, py1 - 33.8, "the answer overflowed the room we planned for",
        ha="left", va="center", fontsize=10.2, fontweight="bold", color=RED,
        zorder=4)
ax.add_patch(FancyBboxPatch((84, py1 - 33.6), 54, 4.4,
                            boxstyle="round,pad=0,rounding_size=0.8",
                            linewidth=0, facecolor=RED, zorder=4))
ax.text(140, py1 - 31.4, "penalty 693", ha="left", va="center", fontsize=11.4,
        fontweight="bold", color=RED, zorder=4)

ax.text(89, py1 - 45.5,
        "Every token you run short is punished 9x harder than every token you leave spare.\n"
        "That is the whole reason step 5 takes the 9-in-10 number instead of the middle one.",
        ha="center", va="center", fontsize=12.2, fontweight="bold", color=INK,
        zorder=4, linespacing=1.6)

fig.savefig(
    OUT / "architecture-eli5.png",
    bbox_inches="tight", pad_inches=0.4, facecolor="white",
)
print("ok")

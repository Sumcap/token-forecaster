#!/usr/bin/env python3
"""Render the accuracy chart pack — docs/report-assets/accuracy-*.png.

Four charts, one question each, all read live from experiments/artifacts:

  accuracy-calibration.png   does the forecast keep its promise?
  accuracy-loss-ladder.png   how much better than the naive baselines?
  accuracy-rolling-folds.png does the win hold across time slices?
  accuracy-cold-start.png    what does a caller who knows nothing get?

Same styling as the other REPORT-2026-08-09 assets: white ground, heavy sans,
blue = the shipped predictor, gray = what it replaced.
"""

import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.family"] = "Helvetica"

ROOT = pathlib.Path(__file__).resolve().parents[2]
ART = ROOT / "experiments" / "artifacts"
OUT = ROOT / "docs" / "report-assets"

INK = "#14161a"
BODY = "#3d434c"
MUTED = "#7c828b"
GRID = "#e3e6ea"
BLUE = "#2a78d6"
GRAY = "#9aa1a9"
ORANGE = "#eb6834"
GREEN = "#1a8a2e"


def load(name):
    return json.loads((ART / f"{name}.json").read_text())


def frame(ax):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=BODY, labelsize=13, length=0)


def titles(fig, title, subtitle, footer):
    fig.text(0.045, 0.955, title, fontsize=23, fontweight="bold", color=INK,
             ha="left", va="top")
    fig.text(0.045, 0.895, subtitle, fontsize=14.5, color=BODY,
             ha="left", va="top")
    fig.text(0.045, 0.035, footer, fontsize=11.5, color=MUTED,
             ha="left", va="bottom")


def save(fig, name):
    path = OUT / name
    fig.savefig(path, dpi=150, facecolor="white")
    plt.close(fig)
    print(path)


# --------------------------------------------------------------- chart 1
def calibration():
    boost = load("winning-boost-eval")
    cov = boost["rolling"]["boosted"]["coverage"]
    n = boost["rolling"]["boosted"]["n"]
    targets = [0.50, 0.90, 0.99]
    labels = ["p50\nhalf the replies", "p90\n9 replies in 10",
              "p99\n99 replies in 100"]

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.72, bottom=0.16)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    x = range(3)
    ax.bar(x, [c * 100 for c in cov], width=0.46, color=BLUE, zorder=3)
    for i, (c, t) in enumerate(zip(cov, targets)):
        ax.plot([i - 0.31, i + 0.31], [t * 100, t * 100], color=INK, lw=2.4,
                zorder=5, solid_capstyle="round")
        ax.text(i + 0.34, t * 100, f"promised {t*100:.0f}%", fontsize=12,
                color=INK, va="center", ha="left")
        ax.text(i, c * 100 - 4.0, f"{c*100:.1f}%", fontsize=15,
                fontweight="bold", color="white", ha="center", va="top",
                zorder=6)

    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, fontsize=13.5, color=BODY)
    ax.set_xlim(-0.55, 2.95)
    ax.set_ylim(0, 105)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.set_ylabel("replies that fitted inside the reservation", fontsize=13,
                  color=BODY, labelpad=10)
    ax.yaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    frame(ax)

    titles(fig, "The forecast keeps its promise",
           "Each bar is how often the real reply actually fitted. The black rule "
           "is what that\nlevel promised. Bar on the rule = honest forecast; bar "
           "below it = replies get cut off.",
           f"Held-out calls only, n = {n:,}. p50 sits high because half of all "
           "replies are very short — a known, harmless bias.")
    save(fig, "accuracy-calibration.png")


# --------------------------------------------------------------- chart 2
def loss_ladder():
    ev = load("claude-code-history-eval")["chronologicalHoldout"]["evaluation"]
    boost = load("winning-boost-eval")["singleSplit"]

    rows = [
        ("Fixed numbers (no model)", ev["static"]["totalPinballLoss"], GRAY),
        ("+ own history", ev["historicalGlobal"]["totalPinballLoss"], GRAY),
        ("+ which model", ev["historicalModel"]["totalPinballLoss"], GRAY),
        ("+ thinking on/off", ev["historicalModelThinking"]["totalPinballLoss"], GRAY),
        ("+ boosted correction  (shipped)", boost["boosted"]["loss"], BLUE),
    ]
    best = rows[-1][1]
    worst = rows[0][1]

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.30, right=0.95, top=0.72, bottom=0.14)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    ys = range(len(rows))
    ax.barh(list(ys), [r[1] for r in rows], height=0.55,
            color=[r[2] for r in rows], zorder=3)
    for i, (label, val, _) in enumerate(rows):
        ax.text(val + 12, i, f"{val:,.0f}", fontsize=14, fontweight="bold",
                color=INK, va="center", ha="left")
    ax.set_yticks(list(ys))
    ax.set_yticklabels([r[0] for r in rows], fontsize=13.5, color=BODY)
    ax.invert_yaxis()
    ax.set_xlim(0, worst * 1.16)
    ax.set_xlabel("pinball loss per call  (lower is better)", fontsize=13,
                  color=BODY, labelpad=10)
    ax.xaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    frame(ax)

    cut = (1 - best / worst) * 100
    titles(fig, "Each signal had to earn its place",
           "Error per call as the predictor is given more to work with. Each rung "
           "adds one input.\nThe shipped predictor is the blue bar.",
           f"Same held-out calls for every rung. Total cut against fixed numbers: "
           f"{cut:.0f}%. On this split the last rung is a wash; "
           f"its win is on the rolling comparison, not here.")
    save(fig, "accuracy-loss-ladder.png")


# --------------------------------------------------------------- chart 3
def rolling_folds():
    roll = load("winning-boost-eval")["rolling"]
    folds = roll["folds"]

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.72, bottom=0.16)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    xs = [f["fold"] for f in folds]
    base = [f["baseline"]["loss"] for f in folds]
    boost = [f["boosted"]["loss"] for f in folds]
    w = 0.36
    ax.bar([x - w / 2 - 0.01 for x in xs], base, width=w, color=GRAY, zorder=3,
           label="previous predictor")
    ax.bar([x + w / 2 + 0.01 for x in xs], boost, width=w, color=BLUE, zorder=3,
           label="shipped predictor")
    for x, b, o in zip(xs, base, boost):
        ax.text(x + w / 2 + 0.01, o + 10, f"−{b - o:.0f}", fontsize=12.5,
                fontweight="bold", color=GREEN, ha="center", va="bottom")

    ax.set_xticks(xs)
    ax.set_xticklabels([f"time slice {x}" for x in xs], fontsize=13, color=BODY)
    ax.set_ylabel("pinball loss per call  (lower is better)", fontsize=13,
                  color=BODY, labelpad=10)
    ax.set_ylim(0, max(base) * 1.22)
    ax.yaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=13, loc="upper right",
              labelcolor=BODY, ncols=2)
    frame(ax)

    c = roll["comparison"]
    titles(fig, "The win holds in every slice of time",
           "Five consecutive slices of held-out traffic, scored on the same calls "
           "for both predictors.\nGreen is the improvement in that slice.",
           f"Pooled gain {abs(c['meanDifference']):.1f} points per call, 95% CI "
           f"[{c['ciLower']:.1f}, {c['ciUpper']:.1f}], n = {c['n']:,}. "
           "The absolute level moves with how hard the traffic was, the gap does not.")
    save(fig, "accuracy-rolling-folds.png")


# --------------------------------------------------------------- chart 4
def cold_start():
    tiers = load("cold-start-probe")["tiers"]
    rows = [
        ("Full local history", tiers["full"], BLUE),
        ("Day one: model + thinking flag", tiers["coldModelThinking"], BLUE),
        ("Day one: model only", tiers["coldModel"], ORANGE),
        ("Day one: nothing declared", tiers["overallOnly"], ORANGE),
    ]

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.33, right=0.95, top=0.72, bottom=0.14)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    ys = range(len(rows))
    ax.barh(list(ys), [r[1]["loss"] for r in rows], height=0.55,
            color=[r[2] for r in rows], zorder=3)
    for i, (_, t, _) in enumerate(rows):
        ax.text(t["loss"] + 6, i, f"{t['loss']:,.0f}", fontsize=14,
                fontweight="bold", color=INK, va="center", ha="left")
    ax.set_yticks(list(ys))
    ax.set_yticklabels([r[0] for r in rows], fontsize=13.5, color=BODY)
    ax.invert_yaxis()
    ax.set_xlim(0, max(r[1]["loss"] for r in rows) * 1.16)
    ax.set_xlabel("pinball loss per call  (lower is better)", fontsize=13,
                  color=BODY, labelpad=10)
    ax.xaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    frame(ax)

    gap_ok = tiers["coldModelThinking_vs_full"]
    gap_bad = tiers["coldModel_vs_coldModelThinking"]
    titles(fig, "A brand-new machine gets almost the full predictor",
           "Same held-out calls, scored four times, each time hiding more from the "
           "predictor.\nThe top two bars are the same forecast quality.",
           f"n = {tiers['full']['n']:,}. Cold vs full: "
           f"{gap_ok['meanDifference']:+.1f} points, CI "
           f"[{gap_ok['ciLower']:.1f}, {gap_ok['ciUpper']:.1f}] — indistinguishable. "
           f"Dropping the thinking flag costs {gap_bad['meanDifference']:.0f} points, "
           f"CI [{gap_bad['ciLower']:.0f}, {gap_bad['ciUpper']:.0f}] — always pass it.")
    save(fig, "accuracy-cold-start.png")


if __name__ == "__main__":
    calibration()
    loss_ladder()
    rolling_folds()
    cold_start()

#!/usr/bin/env python3
"""Render the README data charts — docs/report-assets/data-*.png.

Two charts, read live from experiments/artifacts/claude-code-history-eval.json:

  data-distribution.png   what the 16,011 measured replies actually look like
  data-per-model.png      how different the three main models are

Same styling as the other report assets: white ground, heavy sans, blue marks.
"""

import json
import math
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
# sequential blue ramp, light -> dark, for the p50/p90/p99 magnitude scale
BLUE_RAMP = ["#8ab6e8", "#3d87dc", "#1c5aa8"]


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


def fmt(n):
    return f"{n:,.0f}"


# --------------------------------------------------------------- chart 1
def distribution(ev):
    hist = ev["overall"]["histogram"]
    emp = ev["overall"]["empirical"]
    n = ev["overall"]["n"]

    # merge the tiny sub-64 buckets so the left tail reads as one bar
    merged = [("< 64", sum(b["count"] for b in hist if b["upper"] <= 64))]
    for b in hist:
        if b["lower"] >= 64:
            merged.append((f"{b['lower']:,}–{b['upper']:,}", b["count"]))

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.72, bottom=0.20)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    xs = range(len(merged))
    ax.bar(xs, [c for _, c in merged], width=0.72, color=BLUE, zorder=3)
    for i, (_, c) in enumerate(merged):
        ax.text(i, c + 45, fmt(c), fontsize=11.5, color=BODY,
                ha="center", va="bottom")

    # place the three quantiles on the log2 bucket scale
    def to_x(tokens):
        # bucket i >= 1 spans log2 range [i + 5, i + 6) and is centered at x=i
        return math.log2(tokens) - 5.5

    for q, label in ((emp["p50"], "p50"), (emp["p90"], "p90"),
                     (emp["p99"], "p99")):
        x = to_x(q)
        ax.axvline(x, color=INK, lw=1.6, ymax=0.78, zorder=4)
        ax.text(x + 0.12, ax.get_ylim()[1] * 0.965, f"{label} = {fmt(q)}",
                fontsize=12, fontweight="bold", color=INK,
                ha="left", va="top")

    ax.set_xticks(list(xs))
    ax.set_xticklabels([lbl for lbl, _ in merged], fontsize=11, color=BODY,
                       rotation=30, ha="right")
    ax.set_ylabel("calls in this bucket", fontsize=13, color=BODY, labelpad=10)
    ax.yaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    frame(ax)

    titles(fig, "Most replies are short. A few are enormous.",
           "Every measured reply, sorted into doubling buckets of output "
           "tokens.\nThis long right tail is the whole reason the forecast is "
           "a distribution, not a number.",
           f"n = {n:,} API calls from real Claude Code transcripts. "
           f"Median reply {fmt(emp['p50'])} tokens; the longest "
           f"{fmt(ev['overall']['max'])}.")
    save(fig, "data-distribution.png")


# --------------------------------------------------------------- chart 2
def per_model(ev):
    keep = ["claude-opus-5", "claude-fable-5", "claude-opus-4-8"]
    names = {"claude-opus-5": "Opus 5", "claude-fable-5": "Fable 5",
             "claude-opus-4-8": "Opus 4.8"}
    rows = [(names[m], ev["byModel"][m]) for m in keep]

    fig, ax = plt.subplots(figsize=(11.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.70, bottom=0.14)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    w = 0.26
    qlabels = ["p50", "p90", "p99"]
    for qi, (q, color) in enumerate(zip(qlabels, BLUE_RAMP)):
        xs = [i + (qi - 1) * (w + 0.015) for i in range(len(rows))]
        vals = [r[1]["empirical"][q] for r in rows]
        ax.bar(xs, vals, width=w, color=color, zorder=3, label=q)
        for x, v in zip(xs, vals):
            ax.text(x, v + 80, fmt(v), fontsize=11.5, fontweight="bold",
                    color=INK, ha="center", va="bottom")

    ax.set_xticks(range(len(rows)))
    ax.set_xticklabels([f"{r[0]}\n{r[1]['n']:,} calls" for r in rows],
                       fontsize=13, color=BODY)
    ax.set_ylabel("output tokens per reply", fontsize=13, color=BODY,
                  labelpad=10)
    ax.set_ylim(0, max(r[1]["empirical"]["p99"] for r in rows) * 1.18)
    ax.yaxis.grid(True, color=GRID, lw=1.1, zorder=0)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=13, loc="upper left", labelcolor=BODY,
              ncols=3)
    frame(ax)

    titles(fig, "The three main models write very different amounts",
           "Measured output-length quantiles per model, darker blue = higher "
           "quantile.\nThis is why the model id is the first thing the "
           "predictor asks for.",
           "Empirical quantiles over the full corpus. Models with under 100 "
           "calls are excluded from per-model groups by the predictor's "
           "minimum-sample rule.")
    save(fig, "data-per-model.png")


if __name__ == "__main__":
    ev = json.loads((ART / "claude-code-history-eval.json").read_text())
    distribution(ev)
    per_model(ev)

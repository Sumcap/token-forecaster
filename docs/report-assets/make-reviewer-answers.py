#!/usr/bin/env python3
"""Render the reviewer answer pack - docs/report-assets/reviewer-*.png.

Six charts, one reviewer question each:

  reviewer-holdout-split.png   was the holdout per call or per session?
  reviewer-coverage-ci.png     does the band keep its promise, with error bars?
  reviewer-sharpness.png       how much narrower are the rungs at equal coverage?
  reviewer-scale-switch.png    why does the band fall from 27k to 7.7k on send?
  reviewer-conditional-coverage.png  does 90% overall hold on the heavy calls?

Numbers come from experiments/artifacts/reviewer-checks.json, written by
experiments/evaluation/probe-reviewer-checks.mjs. Same styling as the rest of
the report assets: white ground, blue = shipped predictor, gray = what it
replaced.
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

D = json.loads((ART / "reviewer-checks.json").read_text())


def frame(ax):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=BODY, labelsize=13, length=0)


def titles(fig, title, subtitle, footer):
    fig.text(0.045, 0.955, title, fontsize=23, fontweight="bold", color=INK,
             ha="left", va="top")
    fig.text(0.045, 0.893, subtitle, fontsize=14.5, color=BODY,
             ha="left", va="top")
    fig.text(0.045, 0.035, footer, fontsize=11.5, color=MUTED,
             ha="left", va="bottom")


def save(fig, name):
    path = OUT / name
    fig.savefig(path, dpi=150, facecolor="white")
    plt.close(fig)
    print(path)


def tok(value):
    return f"{value:,.0f}"


# --------------------------------------------------------------- chart 1
def holdout_split():
    """The split question: does grouping by session change the verdict?"""
    rows = [
        ("Split by call", "chronological cut, as shipped", D["callBoundary"]),
        ("Split by session", "whole sessions held out", D["sessionBoundary"]),
    ]
    delta = abs(D["callBoundary"]["models"]["boosted"]["coverage"][1]
                - D["sessionBoundary"]["models"]["boosted"]["coverage"][1]) * 100
    loss_delta = abs(D["callBoundary"]["models"]["boosted"]["loss"]
                     - D["sessionBoundary"]["models"]["boosted"]["loss"])

    fig, ax = plt.subplots(figsize=(11.4, 6.2), dpi=150)
    fig.subplots_adjust(left=0.31, right=0.94, top=0.70, bottom=0.17)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    ax.axvline(0.90, color=ORANGE, lw=2, ls="--", zorder=1)
    ax.text(0.9012, 1.60, "promised 90%", color=ORANGE, fontsize=12.5,
            fontweight="bold", va="center")

    ticks = []
    for index, (label, note, split) in enumerate(rows):
        model = split["models"]["boosted"]
        point = model["coverage"][1]
        low, high = model["coverageCi"][1]
        y = 1 - index
        ax.plot([low, high], [y, y], color=BLUE, lw=9, solid_capstyle="round",
                alpha=0.30, zorder=2)
        ax.plot([point], [y], "o", ms=15, color=BLUE, zorder=3)
        ax.text(point, y + 0.22, f"{point * 100:.1f}%", color=INK, fontsize=15,
                fontweight="bold", ha="center")
        ax.text(high + 0.0015, y, f"95% CI [{low * 100:.1f}, {high * 100:.1f}]",
                color=MUTED, fontsize=11.5, va="center")
        ticks.append(f"{label}\n{note}\n{split['testCalls']:,} calls, "
                     f"{split['sessionCount']} sessions, loss {model['loss']:.0f}")

    ax.set_yticks([0, 1])
    ax.set_yticklabels([ticks[1], ticks[0]], fontsize=12.5, color=INK)
    ax.set_ylim(-0.6, 1.75)
    ax.set_xlim(0.885, 0.932)
    ax.set_xticks([0.89, 0.90, 0.91, 0.92, 0.93])
    ax.set_xticklabels(["89%", "90%", "91%", "92%", "93%"])
    ax.set_xlabel("P90 coverage on held-out calls", fontsize=13, color=BODY,
                  labelpad=10)
    ax.xaxis.grid(True, color=GRID, lw=1)
    ax.set_axisbelow(True)
    frame(ax)

    titles(
        fig,
        "The split was per call, but chronological, not random",
        "Holding out whole sessions instead moves P90 coverage by %s and the loss\n"
        "by %.0f. Only %d of %d holdout sessions straddle the call cut."
        % ("less than 0.1 points" if delta < 0.05 else "%.1f points" % delta,
           loss_delta, D["straddlingSessions"], D["holdoutSessions"]),
        "Shipped predictor: rung ladder plus trained correction. Intervals are 95%% "
        "session-cluster bootstraps, 2,000 resamples, on a %s-call corpus."
        % tok(D["corpusCalls"]),
    )
    save(fig, "reviewer-holdout-split.png")


# --------------------------------------------------------------- chart 2
def coverage_ci():
    """The promise, with an error bar, measured after the trained correction."""
    model = D["sessionBoundary"]["models"]["boosted"]
    targets = [0.50, 0.90, 0.99]
    labels = ["p50\nhalf the replies", "p90\n9 replies in 10",
              "p99\n99 replies in 100"]

    fig, ax = plt.subplots(figsize=(11.0, 6.4), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.71, bottom=0.16)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    x = range(3)
    for index in x:
        point = model["coverage"][index]
        low, high = model["coverageCi"][index]
        ax.bar(index, point, width=0.42, color=BLUE, zorder=2)
        ax.plot([index, index], [low, high], color=INK, lw=2.5, zorder=4)
        for edge in (low, high):
            ax.plot([index - 0.06, index + 0.06], [edge, edge], color=INK,
                    lw=2.5, zorder=4)
        ax.plot([index - 0.30, index + 0.30], [targets[index]] * 2,
                color=ORANGE, lw=2.5, ls="--", zorder=5)
        ax.text(index, point - 0.095, f"{point * 100:.1f}%", ha="center",
                color="white", fontsize=17, fontweight="bold")
        ax.text(index, high + 0.025,
                f"95% CI [{low * 100:.1f}, {high * 100:.1f}]", ha="center",
                color=MUTED, fontsize=12)

    ax.plot([], [], color=ORANGE, lw=2.5, ls="--", label="what the band promises")
    ax.plot([], [], color=BLUE, lw=8, label="what it delivered out of sample")
    legend = ax.legend(loc="upper left", frameon=False, fontsize=12.5,
                       handlelength=1.8)
    for text in legend.get_texts():
        text.set_color(BODY)
    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, fontsize=13.5, color=INK)
    ax.set_ylim(0, 1.13)
    ax.set_yticks([0, 0.25, 0.50, 0.75, 1.0])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.yaxis.grid(True, color=GRID, lw=1)
    ax.set_axisbelow(True)
    frame(ax)

    titles(
        fig,
        "The band keeps its promise, and now carries an error bar",
        "Measured after the trained correction, on %s held-out calls in %d sessions\n"
        "the model never saw. Train and holdout are disjoint in time."
        % (tok(D["sessionBoundary"]["testCalls"]), D["sessionBoundary"]["sessionCount"]),
        "Intervals are 95% session-cluster bootstraps, so correlated calls inside "
        "one session count once, not many times.",
    )
    save(fig, "reviewer-coverage-ci.png")


# --------------------------------------------------------------- chart 3
def sharpness():
    """Width at MATCHED coverage: the number a wide band cannot fake."""
    order = [("pooled", "All calls\npooled", GRAY),
             ("ladder", "Rung\nladder", "#6fa8e8"),
             ("boosted", "Rungs +\ncorrection", BLUE)]

    fig, axes = plt.subplots(1, 2, figsize=(12.2, 6.4), dpi=150)
    fig.subplots_adjust(left=0.075, right=0.975, top=0.70, bottom=0.17,
                        wspace=0.22)
    fig.patch.set_facecolor("white")

    for ax, target in zip(axes, ["0.9", "0.92"]):
        ax.set_facecolor("white")
        block = D["sharpness"][target]
        base = block["pooled"]["meanP90"]
        for index, (field, label, color) in enumerate(order):
            value = block[field]["meanP90"]
            ax.bar(index, value, width=0.55, color=color, zorder=2)
            ax.text(index, value + 40, tok(value), ha="center", color=INK,
                    fontsize=15, fontweight="bold")
            if field != "pooled":
                ax.text(index, value / 2, f"{(value / base - 1) * 100:+.1f}%",
                        ha="center", va="center", color="white", fontsize=14,
                        fontweight="bold")
        ax.set_xticks(range(3))
        ax.set_xticklabels([label for _, label, _ in order], fontsize=12.5,
                           color=INK)
        ax.set_ylim(0, max(block[f]["meanP90"] for f, _, _ in order) * 1.22)
        ax.set_title(f"every band rescaled to {float(target) * 100:.0f}% coverage",
                     fontsize=13.5, color=BODY, pad=14)
        ax.set_ylabel("mean p90, output tokens", fontsize=12.5, color=BODY)
        ax.yaxis.grid(True, color=GRID, lw=1)
        ax.set_axisbelow(True)
        frame(ax)

    titles(
        fig,
        "At equal coverage, the rungs are the narrower band",
        "Coverage alone proves nothing: any band passes if it is wide enough. So each\n"
        "band is scaled until it covers exactly the same share, then compared on width.\n"
        "Pooled = one band for every call. Ladder = model, reasoning and task shape.",
        "Session-boundary holdout, %s calls. Scale factors are fitted on the holdout, "
        "so this is a sharpness comparison, not a second accuracy claim."
        % tok(D["sessionBoundary"]["testCalls"]),
    )
    save(fig, "reviewer-sharpness.png")


# --------------------------------------------------------------- chart 4
def scale_switch():
    """Why the chip's band collapses the moment you press send."""
    fig, ax = plt.subplots(figsize=(11.4, 6.6), dpi=150)
    fig.subplots_adjust(left=0.075, right=0.97, top=0.69, bottom=0.19)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    before = {"p50": 4871, "p90": 27756, "label": "While you type",
              "source": "bundled profile, prompt-aware turn total\n"
                        "rung thinking=yes | promptPath=no, 777 turns"}
    after = {"p50": 900, "p90": 7700, "label": "The moment you send",
             "source": "this machine's own turn pool\n"
                       "unconditional local rung, tens of turns"}

    for index, band in enumerate([before, after]):
        y = 1 - index
        color = BLUE if index == 0 else ORANGE
        ax.plot([0, band["p90"]], [y, y], color=color, lw=16,
                solid_capstyle="round", alpha=0.28, zorder=2)
        ax.plot([band["p50"]], [y], "o", ms=13, color=color, zorder=4)
        ax.plot([band["p90"]], [y], "|", ms=24, mew=4, color=color, zorder=4)
        ax.text(600, y + 0.47, f"p90 {tok(band['p90'])}", color=INK,
                fontsize=15, fontweight="bold", va="center")
        ax.text(600, y + 0.28, band["source"], color=MUTED, fontsize=11,
                va="center", linespacing=1.35)
        ax.text(-900, y, band["label"], color=INK, fontsize=13.5,
                fontweight="bold", ha="right", va="center")

    ax.annotate("", xy=(24000, 0.05), xytext=(24000, 0.85),
                arrowprops=dict(arrowstyle="-|>", color=INK, lw=2.2))
    ax.text(24700, 0.45, "not new information about your prompt:\n"
                        "a switch to a different population",
            color=INK, fontsize=13, va="center", fontweight="bold")

    ax.set_xlim(-9000, 40000)
    ax.set_ylim(-0.45, 1.85)
    ax.set_yticks([])
    ax.set_xticks([0, 10000, 20000, 30000, 40000])
    ax.set_xticklabels(["0", "10k", "20k", "30k", "40k"])
    ax.set_xlabel("output tokens for the whole turn", fontsize=13, color=BODY,
                  labelpad=10)
    ax.xaxis.grid(True, color=GRID, lw=1)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=BODY, labelsize=13, length=0)

    titles(
        fig,
        "The 27k to 7.7k drop is a source switch, not a forecast",
        "Both surfaces say \"p90\". Before send it is the Claude Code corpus conditioned on\n"
        "your draft. After send an unconditional local pool overwrites it with its own turns.",
        "server/forecast.js:469 now blocks exactly this overwrite (commit 3fe0db9, "
        "12 Aug 2026). Two surfaces must show one quantity.",
    )
    save(fig, "reviewer-scale-switch.png")


# --------------------------------------------------------------- chart 5
def cold_start_width():
    """The published -24% cold-start gap, re-measured honestly."""
    raw = D["coldStart"]["raw"]
    matched = D["coldStart"]["matched"]
    panels = [
        ("As published, 9 Aug corpus\nraw width, coverage not matched",
         [("all calls pooled", 6447, "99.5% coverage"),
          ("full rung ladder", 4879, "99.1% coverage")]),
        ("Today's corpus\nraw width, coverage not matched",
         [("all calls pooled", raw["pooled"]["width"],
           f"{raw['pooled']['p99Coverage'] * 100:.1f}% coverage"),
          ("full rung ladder", raw["ladder"]["width"],
           f"{raw['ladder']['p99Coverage'] * 100:.1f}% coverage")]),
        ("Today's corpus\nboth scaled to 99.0% coverage",
         [("all calls pooled", matched["pooled"]["width"], "99.0% coverage"),
          ("full rung ladder", matched["ladder"]["width"], "99.0% coverage")]),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(13.0, 6.6), dpi=150)
    fig.subplots_adjust(left=0.065, right=0.98, top=0.66, bottom=0.17, wspace=0.24)
    fig.patch.set_facecolor("white")

    top = max(value for _, bars in panels for _, value, _ in bars) * 1.28
    for ax, (heading, bars) in zip(axes, panels):
        ax.set_facecolor("white")
        base = bars[0][1]
        for index, (label, value, note) in enumerate(bars):
            color = GRAY if index == 0 else BLUE
            ax.bar(index, value, width=0.55, color=color, zorder=2)
            ax.text(index, value + top * 0.025, tok(value), ha="center",
                    color=INK, fontsize=14.5, fontweight="bold")
            ax.text(index, value / 2, note, ha="center", va="center",
                    color="white", fontsize=11)
            if index == 1:
                ax.text(index, value + top * 0.10,
                        f"{(value / base - 1) * 100:+.1f}%", ha="center",
                        color=BLUE, fontsize=15, fontweight="bold")
        ax.set_xticks(range(2))
        ax.set_xticklabels([label.replace(" ", "\n", 1) for label, _, _ in bars],
                           fontsize=11.5, color=INK)
        ax.set_title(heading, fontsize=12.5, color=BODY, pad=12)
        ax.set_ylim(0, top)
        ax.yaxis.grid(True, color=GRID, lw=1)
        ax.set_axisbelow(True)
        frame(ax)
    axes[0].set_ylabel("mean p50-to-p99 width, output tokens", fontsize=12.5,
                       color=BODY)

    titles(
        fig,
        "The cold-start gap, measured three ways",
        "The 24% in the proposal is a raw width comparison where the pooled band also\n"
        "covered more. Matched coverage on today's corpus puts the real gap near 17%.",
        "Session-boundary holdout, %s calls. The 9 Aug panel is the published "
        "cold-start probe; the workload moved since." % tok(D["sessionBoundary"]["testCalls"]),
    )
    save(fig, "reviewer-cold-start-width.png")


# --------------------------------------------------------------- chart 6
def conditional_coverage():
    """90% overall can hide 74% on the calls that matter."""
    cond = D["conditional"]["models"]
    buckets = cond["boosted"]["buckets"]
    x = list(range(len(buckets)))
    labels = [
        "lightest\nfifth\n~%s tok" % tok(b["medianOutput"]) if i == 0
        else ("heaviest\nfifth\n~%s tok" % tok(b["medianOutput"]) if i == len(buckets) - 1
              else "\n\n~%s tok" % tok(b["medianOutput"]))
        for i, b in enumerate(buckets)
    ]

    fig, ax = plt.subplots(figsize=(11.0, 6.4), dpi=150)
    fig.subplots_adjust(left=0.09, right=0.97, top=0.71, bottom=0.17)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    series = [("pooled", "All calls pooled, re-scaled to 90%", GRAY, "o"),
              ("ladder", "Rung ladder", "#6fa8e8", "s"),
              ("boosted", "Shipped predictor", BLUE, "o")]
    for field, label, color, marker in series:
        ys = [b["coverage"] for b in cond[field]["buckets"]]
        ax.plot(x, ys, color=color, lw=3, marker=marker, ms=9, zorder=3,
                label=label)
    last = len(buckets) - 1
    for field, color, offsets in (("pooled", GRAY, {0: 0.026, last: -0.05}),
                                  ("boosted", BLUE, {0: -0.05, last: -0.05})):
        for i, b in enumerate(cond[field]["buckets"]):
            if i in offsets:
                ax.text(i, b["coverage"] + offsets[i],
                        f"{b['coverage'] * 100:.1f}%", ha="center", color=color,
                        fontsize=14, fontweight="bold")

    ax.axhline(0.90, color=ORANGE, lw=2.5, ls="--", zorder=2)
    ax.text(last + 0.12, 0.906, "90% promised", color=ORANGE, fontsize=12,
            va="bottom", ha="left")

    legend = ax.legend(loc="lower left", frameon=False, fontsize=12.5,
                       handlelength=1.8)
    for text in legend.get_texts():
        text.set_color(BODY)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=12.5, color=INK)
    ax.set_xlim(-0.35, len(buckets) - 0.20)
    ax.set_ylim(0.68, 1.03)
    ax.set_yticks([0.70, 0.80, 0.90, 1.0])
    ax.set_yticklabels(["70%", "80%", "90%", "100%"])
    ax.yaxis.grid(True, color=GRID, lw=1)
    ax.set_axisbelow(True)
    frame(ax)

    titles(
        fig,
        "Every band below hits 90% overall. Only one keeps it on the big calls",
        "Each model is scaled until it covers exactly 90% of the holdout, then read again\n"
        "inside each fifth of the workload, sorted by the size the predictor expects.",
        "Session-boundary holdout, %s calls, about %d per fifth. Buckets are quintiles "
        "of the expected p90, not of the realised output."
        % (tok(D["sessionBoundary"]["testCalls"]), buckets[0]["n"]),
    )
    save(fig, "reviewer-conditional-coverage.png")


holdout_split()
coverage_ci()
sharpness()
scale_switch()
cold_start_width()
conditional_coverage()

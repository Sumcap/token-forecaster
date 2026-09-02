import type {
  PersonalEvaluation,
  PersonalProfile,
  SufficiencyReport,
} from "@token-forecaster/personal";

import {
  barChart,
  bytes,
  calibrationPlot,
  compact,
  details,
  esc,
  learningCurve,
  metricStrip,
  pct,
  pill,
  plain,
  quantileStrip,
  stackedBar,
  table,
  timeSeries,
  type Tone,
} from "./charts.js";
import { section, shell, type PageSlug } from "./shell.js";

/**
 * The dashboard, as one scrolling page in five sections.
 *
 * Each section answers exactly one question with a chart and carries at most
 * two short paragraphs of prose. Where a chart cannot carry a value on its own,
 * a collapsed table sits beneath it rather than a wall of text.
 */

/** Everything a page can draw from. */
export interface PageData {
  health: Record<string, unknown>;
  profile: PersonalProfile | null;
  evaluation: PersonalEvaluation | null;
  sufficiency: SufficiencyReport | null;
  weekly: { week: string; provider: string; count: number }[];
  token: string;
}

const SOURCE_LABEL: Record<string, string> = { openai: "Codex", anthropic: "Claude Code" };
const SCALE_LABEL: Record<string, string> = { call: "one reply", turn: "one whole task" };

const sliceName = (provider: string, scale: string): string =>
  `${SOURCE_LABEL[provider] ?? provider} · ${SCALE_LABEL[scale] ?? scale}`;

const VERDICT: Record<string, { label: string; tone: Tone }> = {
  cold: { label: "Needs more", tone: "critical" },
  thin: { label: "Still learning", tone: "warning" },
  usable: { label: "Working", tone: "good" },
  saturated: { label: "Maxed out", tone: "good" },
};

function footerLine(data: PageData): string {
  const p = data.profile;
  return `${p ? `Profile ${esc(p.id)} · built from your history only` : "No profile yet"} · nothing here leaves this Mac · no prompt text is stored`;
}

/** The raw source rows behind most of the counting. */
function sourceRows(data: PageData): Record<string, unknown>[] {
  return (data.health["sources"] ?? []) as Record<string, unknown>[];
}

const sumOf = (rows: Record<string, unknown>[], key: string): number =>
  rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);

// ---------------------------------------------------------------------------
// Status: is it working?
// ---------------------------------------------------------------------------

function statusSection(data: PageData): string {
  const profileInfo = (data.health["profile"] ?? {}) as Record<string, unknown>;
  const sources = sourceRows(data);
  const observations = Number(profileInfo["sampleCount"] ?? 0);

  // The headline distribution: the biggest turn-scale slice this user has.
  const turnSlices = (data.sufficiency?.slices ?? []).filter((s) => s.scale === "turn");
  const hero = turnSlices.sort((a, b) => b.totalObservations - a.totalObservations)[0] ?? null;
  const heroProfile = hero
    ? data.profile?.scales[`${hero.provider}|turn`]?.groups["overall"]
    : undefined;

  const beat = (data.sufficiency?.slices ?? []).filter((s) => s.beatsColdStartAtN !== null).length;
  const total = data.sufficiency?.slices.length ?? 0;
  const readyTone: Tone =
    total === 0 ? "neutral" : beat === total ? "good" : beat > 0 ? "warning" : "critical";

  const checks: { what: string; tone: Tone; label: string; detail: string }[] = [];
  for (const source of sources) {
    const available = source["available"] === true;
    const calls = Number(source["usableCalls"] ?? 0);
    checks.push({
      what: String(source["label"]),
      tone: available && calls > 0 ? "good" : available ? "warning" : "critical",
      label: available && calls > 0 ? "Connected" : available ? "Empty" : "Not found",
      detail: available
        ? `${compact(calls)} replies learned from ${compact(Number(source["files"] ?? 0))} files`
        : String(source["path"] ?? ""),
    });
  }
  checks.push({
    what: "Personal model",
    tone: observations > 0 ? "good" : "critical",
    label: observations > 0 ? "Trained" : "Not trained",
    detail:
      observations > 0
        ? `${compact(observations)} examples, ${profileInfo["groups"]} rules`
        : "run a rebuild",
  });
  checks.push({
    what: "Better than generic",
    tone: readyTone,
    label: total === 0 ? "Not measured" : `${beat} of ${total}`,
    detail: "how many prediction types beat the built-in model",
  });

  const checkList = checks
    .map(
      (c) =>
        `<li><span class="what">${esc(c.what)}</span>${pill(c.tone, c.label)}<span class="detail">${esc(c.detail)}</span></li>`,
    )
    .join("");

  return section(
    "status",
    `<div class="card">
    <h3>What one task usually costs you</h3>
    <p class="why">${hero ? esc(sliceName(hero.provider, "turn")) : "No task-level history yet"}. Here is where 100 of your tasks land.</p>
    ${
      heroProfile
        ? quantileStrip({
            p50: heroProfile.p50,
            p90: heroProfile.p90,
            p99: heroProfile.p99,
            captionP50: "50 land under here",
            captionP90: "90 land under here",
            captionP99: "99 land under here",
          })
        : `<p class="empty">Not enough task-level history yet.</p>`
    }
    ${heroProfile ? `<p class="cap">Output tokens. A task is one thing you asked for, plus every reply it took to finish.</p>` : ""}
  </div>

  <div class="card">
    <h3>Four things have to be true</h3>
    <p class="why">All four green means it is using your own history, not the generic model it ships with.</p>
    <ul class="checks">${checkList}</ul>
  </div>`,
  );
}

// ---------------------------------------------------------------------------
// Data: what did we read?
// ---------------------------------------------------------------------------

const SKIP_LABEL: Record<string, string> = {
  duplicate_usage: "Repeated events",
  missing_usage: "No token counts",
  zero_output: "Empty replies",
  parse_error: "Broken lines",
  unknown_record_shape: "Unknown shape",
  unrecognised_event: "New event type",
  unsupported_schema_version: "Old file format",
  no_turn_context: "Task start unknown",
};

function dataSection(data: PageData): string {
  const sources = sourceRows(data);

  const cards = sources
    .map((source) => {
      const used = Number(source["usableCalls"] ?? 0);
      const skipped = (source["skipped"] ?? {}) as Record<string, number>;
      const segments = [
        { label: "Used", value: used, slot: 1 as const },
        ...Object.entries(skipped)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count], i) => ({
            label: SKIP_LABEL[reason] ?? reason,
            value: count,
            slot: (i === 0 ? 2 : 3) as 2 | 3,
          })),
      ];
      const rows = Object.entries(skipped)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => [
          esc(SKIP_LABEL[reason] ?? reason),
          compact(count),
          esc(reason),
        ]);
      return `<div class="card">
      <h3>${esc(source["label"])} ${pill(source["available"] ? "good" : "critical", source["available"] ? "Connected" : "Not found")}</h3>
      <p class="why">${compact(Number(source["files"] ?? 0))} files · ${bytes(Number(source["bytesOnDisk"] ?? 0))} · ${compact(Number(source["sessions"] ?? 0))} sessions</p>
      ${stackedBar({ segments, caption: "Rows in those files. Every row is either used or counted under a reason. None are dropped quietly." })}
      ${details("Why rows were skipped", table(["Reason", "Rows", "Code"], rows))}
    </div>`;
    })
    .join("");

  // Weekly history, stacked by source.
  const weeks = [...new Set(data.weekly.map((w) => w.week))].sort();
  const seriesFor = (
    provider: string,
    slot: 1 | 2,
  ): { label: string; slot: 1 | 2; values: number[] } => ({
    label: SOURCE_LABEL[provider] ?? provider,
    slot,
    values: weeks.map(
      (week) => data.weekly.find((w) => w.week === week && w.provider === provider)?.count ?? 0,
    ),
  });

  return section(
    "data",
    `${metricStrip(
      [
        { value: compact(sumOf(sources, "files")), label: "Files read" },
        { value: bytes(sumOf(sources, "bytesOnDisk")), label: "On disk" },
        { value: compact(sumOf(sources, "rowsRead")), label: "Lines parsed" },
        { value: compact(sumOf(sources, "usableCalls")), label: "Usable replies" },
      ],
      "tight",
    )}

  <div class="card">
    <h3>Your history over time</h3>
    <p class="why">How much it learned each week. Flat stretches are weeks you did not use the tool.</p>
    ${timeSeries({
      categories: weeks,
      series: [seriesFor("openai", 1), seriesFor("anthropic", 2)],
      yLabel: "replies learned",
      xLabel: "week",
    })}
  </div>

  <div class="grid2">${cards}</div>`,
  );
}

// ---------------------------------------------------------------------------
// Model: what does it predict?
// ---------------------------------------------------------------------------

function modelSection(data: PageData): string {
  const scales = data.profile ? Object.values(data.profile.scales) : [];

  const facets = scales
    .map((slice) => {
      const overall = slice.groups["overall"];
      if (!overall) return "";
      return `<div class="card">
      <h3>${esc(sliceName(slice.provider, slice.scale))}</h3>
      <p class="why">${compact(slice.sampleSize)} examples · ${
        slice.conditioned
          ? "a separate forecast for each model you use"
          : "the same forecast whichever model you use"
      }</p>
      ${quantileStrip({
        p50: overall.p50,
        p90: overall.p90,
        p99: overall.p99,
        captionP50: "half are smaller",
        captionP90: "9 in 10 are smaller",
        captionP99: "99 in 100 are smaller",
        compact: true,
      })}
      <p class="cap">Output tokens. Half land under P50, 9 in 10 under P90, 99 in 100 under P99.</p>
    </div>`;
    })
    .join("");

  const rungRows = scales.map((slice) => [
    esc(sliceName(slice.provider, slice.scale)),
    compact(slice.sampleSize),
    String(Object.keys(slice.groups).length),
    slice.conditioned ? "yes" : "no",
    esc(slice.models.slice(0, 3).join(", ") + (slice.models.length > 3 ? "…" : "")),
  ]);

  return section(
    "model",
    `<div class="card">
    <h3>What a typical request costs</h3>
    <p class="why">Half of your requests finish under these numbers.</p>
    ${barChart({
      rows: scales.map((slice) => ({
        label: sliceName(slice.provider, slice.scale),
        value: slice.groups["overall"]?.p50 ?? 0,
        display: compact(slice.groups["overall"]?.p50 ?? 0),
        note: "middle-case output tokens",
      })),
      axisLabel: "output tokens, middle case (P50)",
    })}
    <p class="cap">A <b>reply</b> is one answer. A <b>whole task</b> is everything one request took, follow-ups included. A task costs far more, so the two are never mixed.</p>
    ${details("All predictors", table(["Predictor", "Examples", "Rules", "Adjusts for model", "Models seen"], rungRows))}
  </div>
  <div class="grid2">${facets}</div>`,
  );
}

// ---------------------------------------------------------------------------
// Accuracy: is it right?
// ---------------------------------------------------------------------------

function accuracySection(data: PageData): string {
  const slices = data.evaluation?.slices ?? [];

  const calibrationRows = slices.flatMap((slice) => {
    const best = slice.candidates.find((c) => c.name === slice.best);
    if (!best) return [];
    return [
      { label: `${sliceName(slice.provider, slice.scale)}`, nominal: 0.9, actual: best.coverageP90 },
    ];
  });

  const allRows = slices.flatMap((slice) => {
    const best = slice.candidates.find((c) => c.name === slice.best);
    if (!best) return [];
    return [
      [
        esc(sliceName(slice.provider, slice.scale)),
        pct(best.coverageP50),
        pct(best.coverageP90),
        pct(best.coverageP99),
        compact(best.n),
      ],
    ];
  });

  // Shown as shipped, and signed. A personal slice that lost to the generic
  // model used to render as "0% better", which is the one number that cannot be
  // true of a model that is not being served at all.
  const gainRows = slices.map((slice) => {
    const percent = slice.gainOverColdStartAsShipped * 100;
    return {
      label: sliceName(slice.provider, slice.scale),
      value: Math.max(0, percent),
      display: slice.beatsColdStart
        ? `${Math.round(percent)}% better`
        : `not used — ${Math.round(Math.abs(percent))}% ${percent < 0 ? "worse" : "better, under the bar"}`,
      note: slice.beatsColdStartReason,
    };
  });

  return section(
    "accuracy",
    `<div class="card">
    <h3>Does it cover what it promises?</h3>
    <p class="why">A "9 in 10" forecast should be right 9 times out of 10. The tick is what it promised. The dot is what happened.</p>
    ${calibrationPlot(calibrationRows, "how often the 9 in 10 range was right")}
    ${details("All coverage numbers", table(["Predictor", "P50", "P90", "P99", "Tested on"], allRows))}
  </div>

  <div class="card">
    <h3>Better than a generic model?</h3>
    <p class="why">How much less wrong your own forecaster is than the generic one. Only tasks it had never seen were used.</p>
    ${barChart({ rows: gainRows, axisLabel: "% less error than the generic model" })}
    <p class="cap">Whole-task forecasts gain the most from your history. Single replies gain least, because the generic model was already close there.</p>
  </div>`,
  );
}

// ---------------------------------------------------------------------------
// Data needed: would more history help?
// ---------------------------------------------------------------------------

function maturitySection(data: PageData): string {
  const slices = data.sufficiency?.slices ?? [];
  const crossovers = slices
    .map((s) => s.beatsColdStartAtN)
    .filter((v): v is number => v !== null);
  const minCrossover = crossovers.length ? Math.min(...crossovers) : null;
  const maxedOut = slices.filter((s) => s.verdict === "saturated").length;

  // "Should I do something?" is the only question this section exists to
  // answer, so it is answered in the first three words, from the same numbers
  // the curves are drawn from.
  const improving = slices.filter((s) => s.verdict !== "saturated");
  const improvingNames = improving.map((s) => sliceName(s.provider, s.scale)).join(", ");
  const answer =
    slices.length === 0
      ? "Not yet measurable."
      : improving.length === 0
        ? "No, you are done collecting."
        : "No, just keep working.";
  const because =
    slices.length === 0
      ? "Use Codex or Claude Code a little more and the answer shows up here."
      : improving.length === 0
        ? `All ${slices.length} forecasts have all the history they can use. Saving more transcripts will not sharpen them.`
        : improving.length === 1
          ? `${maxedOut} of the ${slices.length} forecasts have all the history they can use. The last one, ${improvingNames}, still gets better on its own as you work. There is nothing to switch on or collect.`
          : `${maxedOut} of the ${slices.length} forecasts have all the history they can use. The other ${improving.length}, ${improvingNames}, still get better on their own as you work. There is nothing to switch on or collect.`;

  const facets = slices
    .map((slice) => {
      const verdict = VERDICT[slice.verdict] ?? { label: slice.verdict, tone: "neutral" as Tone };
      return learningCurve({
        title: sliceName(slice.provider, slice.scale),
        badge: verdict.label,
        badgeTone: verdict.tone,
        points: slice.curve.map((p) => ({ x: p.n, y: p.pinballMean })),
        reference: slice.coldStartPinball,
        referenceLabel: "generic model",
        crossoverX: slice.beatsColdStartAtN,
        subtitle:
          slice.beatsColdStartAtN !== null
            ? `Beat the generic model at ${compact(slice.beatsColdStartAtN)} examples. Flat after ${compact(slice.saturationN ?? 0)}.`
            : "Has not beaten the generic model yet.",
      });
    })
    .join("");

  const thresholdRows = slices.map((slice) => [
    esc(sliceName(slice.provider, slice.scale)),
    slice.beatsColdStartAtN === null ? "not yet" : compact(slice.beatsColdStartAtN),
    slice.saturationN === null ? "not yet" : compact(slice.saturationN),
    compact(slice.totalObservations),
    (VERDICT[slice.verdict] ?? { label: slice.verdict }).label,
  ]);

  return section(
    "maturity",
    `${metricStrip(
      [
        {
          value: minCrossover === null ? "n/a" : compact(minCrossover),
          label: "Fewest examples to beat generic",
          sub: "the quickest of the four",
          tone: "good",
        },
        {
          value: `${maxedOut}/${slices.length || "0"}`,
          label: "Already maxed out",
          sub: "more data won't help these",
        },
        {
          value: compact(slices.reduce((s, x) => s + x.totalObservations, 0)),
          label: "Examples you have",
        },
      ],
      "tight",
    )}

  <div class="card">
    <h3>How error falls as history grows</h3>
    <p class="why">The line is how far off the forecast was, on average, in output tokens. Lower is better. The flat rule is the generic model. The upright line is where yours overtook it. Once a curve levels off, more history stops helping.</p>
    <div class="facets">${facets || '<p class="empty">Not enough history to measure yet.</p>'}</div>
    ${details("Thresholds", table(["Predictor", "Beats generic at", "Flat after", "You have", "Verdict"], thresholdRows))}
  </div>

  <div class="card">
    <h3>Do you need to do anything?</h3>
    <p class="why"><b>${esc(answer)}</b> ${esc(because)}</p>
    <p class="cap">For the ones that have stopped improving, a bigger archive is not the answer. They would need to know more about each request: what kind of task it is, which project, which tools. That is a change to this app, not something you can feed it.</p>
    ${details("Measurement note", `<p class="cap">${esc(plain(data.sufficiency?.headline ?? "Not measured yet."))}</p>`)}
  </div>`,
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function dashboardPage(data: PageData): string {
  const profileInfo = (data.health["profile"] ?? {}) as Record<string, unknown>;
  const sources = sourceRows(data);
  const observations = Number(profileInfo["sampleCount"] ?? 0);
  const beat = (data.sufficiency?.slices ?? []).filter((s) => s.beatsColdStartAtN !== null).length;
  const total = data.sufficiency?.slices.length ?? 0;
  const readyTone: Tone =
    total === 0 ? "neutral" : beat === total ? "good" : beat > 0 ? "warning" : "critical";

  const metrics = metricStrip([
    { value: compact(observations), label: "Examples learned", sub: "from your own history" },
    {
      value: bytes(sumOf(sources, "bytesOnDisk")),
      label: "History read",
      sub: `${compact(sumOf(sources, "files"))} files`,
    },
    {
      value: compact(Number(data.health["defaultP50"] ?? 0)),
      label: "Typical task",
      sub: "output tokens, typical case",
    },
    {
      value: total === 0 ? "n/a" : `${beat}/${total}`,
      label: "Better than generic",
      sub: "of the four forecasts",
      tone: readyTone,
    },
  ]);

  return shell({
    token: data.token,
    lede: "Your personal forecaster",
    sub: "Built from your own Codex and Claude Code history. Everything stays on this Mac.",
    metrics,
    body: [
      statusSection(data),
      dataSection(data),
      modelSection(data),
      accuracySection(data),
      maturitySection(data),
    ].join("\n"),
    footer: footerLine(data),
  });
}

/** Route a slug to its renderer. There is one page, so the slug is the root. */
export function renderPage(_slug: PageSlug, data: PageData): string {
  return dashboardPage(data);
}

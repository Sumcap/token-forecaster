/**
 * Server-rendered SVG chart primitives.
 *
 * Everything here emits plain SVG with no script and no external resource, so
 * the page keeps its `default-src 'none'` policy. Colours are referenced as CSS
 * custom properties (`var(--series-1)`) defined once in the page shell, so a
 * single block swaps the whole page between light and dark.
 *
 * Palette provenance: the categorical slots are indigo / ember / teal, checked
 * all-pairs against this page's own surfaces in both modes: worst CVD ΔE 8.9
 * light / 12.6 dark, worst normal-vision ΔE 25.5 / 22.2, every slot at or above
 * 3:1 on its surface. Ordered quantiles use one hue (the indigo ramp, light to
 * dark), never three categorical colours. Direct labels and a table view ship
 * with every chart regardless, so colour never carries a value on its own.
 */

/**
 * Normalise text that came from outside the UI layer.
 *
 * The sufficiency headline is written by the data layer, which uses em dashes;
 * this dashboard's voice does not. Rewriting the punctuation on the way in
 * keeps one house style without reaching into the data layer.
 */
export function plain(value: string): string {
  return value.replace(/\s*\u2014\s*/g, ", ");
}

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Compact count: 1234 → 1.2k. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export const pct = (value: number): string =>
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : "n/a";

/** Status roles from the reserved status palette. Never used for series identity. */
export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const TONE_ICON: Record<Tone, string> = {
  good: "●",
  warning: "▲",
  serious: "▲",
  critical: "■",
  neutral: "○",
};

/** A status pill. Always icon + label, never colour alone. */
export function pill(tone: Tone, label: string): string {
  return `<span class="pill t-${tone}"><span class="ico" aria-hidden="true">${TONE_ICON[tone]}</span>${esc(label)}</span>`;
}

/** One figure in a {@link metricStrip}. */
export interface Metric {
  value: string;
  label: string;
  sub?: string;
  tone?: Tone;
}

/**
 * The headline numbers, set as type rather than boxed in cards.
 *
 * A number is a number; a border around it adds nothing and four of them in a
 * row read as a widget wall. Hairline dividers group them instead, so the
 * figures themselves carry the emphasis. `tight` is the in-section variant.
 */
export function metricStrip(
  items: readonly Metric[],
  variant: "hero" | "tight" = "hero",
): string {
  const cells = items
    .map(
      (item) => `<div${item.tone ? ` class="tone-${item.tone}"` : ""}>
      <dt>${esc(item.label)}</dt>
      <dd class="v">${esc(item.value)}</dd>
      ${item.sub ? `<dd class="s">${esc(item.sub)}</dd>` : ""}
    </div>`,
    )
    .join("");
  return `<dl class="metrics${variant === "tight" ? " tight" : ""}">${cells}</dl>`;
}

/** One row of a horizontal bar chart. */
export interface BarRow {
  label: string;
  value: number;
  /** Text shown at the bar end. Defaults to the compacted value. */
  display?: string;
  /** Categorical slot 1–3, or a status tone. */
  slot?: 1 | 2 | 3;
  tone?: Tone;
  note?: string;
}

/**
 * Horizontal bar chart.
 *
 * Horizontal because the categories are text labels that would otherwise be
 * rotated, and because comparison of magnitude is the whole job.
 */
export function barChart(options: {
  rows: readonly BarRow[];
  max?: number;
  height?: number;
  /** What the bar length measures. Rendered under the plot as an axis title. */
  axisLabel?: string;
}): string {
  const rows = options.rows;
  if (rows.length === 0) return `<p class="empty">Nothing to show yet.</p>`;
  const max = options.max ?? Math.max(...rows.map((r) => r.value), 1);
  const rowH = options.height ?? 34;
  const barH = 12;
  // Both gutters are sized from the actual strings: a bar-end label that runs
  // off the plot is the classic clipped-label failure, and these categories are
  // full sentences rather than short codes.
  const longestLabel = Math.max(...rows.map((r) => r.label.length));
  const longestValue = Math.max(...rows.map((r) => (r.display ?? compact(r.value)).length));
  const labelW = Math.min(240, Math.max(120, longestLabel * 6.6 + 14));
  const valueW = Math.max(52, longestValue * 6.9 + 12);
  // Intrinsic widths track the width the chart actually renders at, so the SVG
  // scales ~1:1 and its text stays the size the stylesheet asked for.
  const width = 960;
  const plotW = width - labelW - valueW;
  const axisH = options.axisLabel ? 24 : 0;
  const height = rows.length * rowH + 6 + axisH;

  const marks = rows
    .map((row, i) => {
      const y = i * rowH + 6;
      const w = Math.max(2, (row.value / max) * plotW);
      const fill = row.tone ? `var(--status-${row.tone})` : `var(--series-${row.slot ?? 1})`;
      return `<g class="mark">
      <title>${esc(row.label)}: ${esc(row.display ?? compact(row.value))}${row.note ? `, ${esc(row.note)}` : ""}</title>
      <text class="ax" x="${labelW - 10}" y="${y + barH}" text-anchor="end">${esc(row.label)}</text>
      <rect class="track" x="${labelW}" y="${y + 1}" width="${plotW}" height="${barH}" rx="4"></rect>
      <rect x="${labelW}" y="${y + 1}" width="${w}" height="${barH}" rx="4" fill="${fill}"></rect>
      <text class="val" x="${labelW + w + 8}" y="${y + barH}">${esc(row.display ?? compact(row.value))}</text>
    </g>`;
    })
    .join("");

  const axis = options.axisLabel
    ? `<text class="ax" x="${labelW + plotW / 2}" y="${height - 5}" text-anchor="middle">${esc(options.axisLabel)}</text>`
    : "";

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">${marks}${axis}</svg>`;
}

/** One segment of a part-to-whole bar. */
export interface Segment {
  label: string;
  value: number;
  slot?: 1 | 2 | 3;
  tone?: Tone;
}

/**
 * A single part-to-whole bar with a legend and a value table.
 *
 * Used instead of a pie: the segments here are wildly unequal, and a bar keeps
 * small slices readable. Segments are separated by a 2px surface gap rather
 * than a stroke.
 */
export function stackedBar(options: {
  segments: readonly Segment[];
  caption?: string;
}): string {
  const segments = options.segments.filter((s) => s.value > 0);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return `<p class="empty">Nothing read yet.</p>`;

  const width = 440;
  const height = 34;
  const gap = 2;
  let x = 0;
  const marks = segments
    .map((segment) => {
      const w = Math.max(3, (segment.value / total) * (width - gap * (segments.length - 1)));
      const fill = segment.tone ? `var(--status-${segment.tone})` : `var(--series-${segment.slot ?? 1})`;
      const rect = `<g class="mark"><title>${esc(segment.label)}: ${compact(segment.value)} (${pct(segment.value / total)})</title>
      <rect x="${x}" y="8" width="${w}" height="18" rx="4" fill="${fill}"></rect></g>`;
      x += w + gap;
      return rect;
    })
    .join("");

  const legend = segments
    .map(
      (segment) =>
        `<li><span class="sw" style="background:${segment.tone ? `var(--status-${segment.tone})` : `var(--series-${segment.slot ?? 1})`}"></span>
        <b>${esc(segment.label)}</b> <span class="n">${compact(segment.value)}</span> <span class="p">${pct(segment.value / total)}</span></li>`,
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">${marks}</svg>
  <ul class="legend">${legend}</ul>
  ${options.caption ? `<p class="cap">${esc(options.caption)}</p>` : ""}`;
}

/**
 * A quantile strip: where P50, P90 and P99 sit on one scale.
 *
 * This is the shape of "what a turn costs you": a distribution summary, not a
 * comparison, so it gets one hue with an ordinal ramp rather than three
 * categorical colours.
 */
export function quantileStrip(options: {
  p50: number;
  p90: number;
  p99: number;
  captionP50: string;
  captionP90: string;
  captionP99: string;
  /**
   * Side-by-side variant. The per-stop captions are dropped: at facet width the
   * three of them overlap, and an overlapping label is worse than none. The
   * card carries one sentence of prose instead.
   */
  compact?: boolean;
}): string {
  const width = options.compact ? 470 : 960;
  const height = options.compact ? 66 : 108;
  const left = 8;
  const right = width - 8;
  const max = Math.max(options.p99, 1);
  const x = (value: number): number => left + (value / max) * (right - left);
  const y = options.compact ? 40 : 46;

  const stops: { value: number; label: string; caption: string; step: string }[] = [
    { value: options.p50, label: "P50", caption: options.captionP50, step: "var(--seq-1)" },
    { value: options.p90, label: "P90", caption: options.captionP90, step: "var(--seq-2)" },
    { value: options.p99, label: "P99", caption: options.captionP99, step: "var(--seq-3)" },
  ];

  const bands = stops
    .map((stop, i) => {
      const from = i === 0 ? left : x(stops[i - 1]!.value);
      const to = x(stop.value);
      return `<g class="mark"><title>${esc(stop.label)} ${compact(stop.value)}: ${esc(stop.caption)}</title>
      <rect x="${from + (i === 0 ? 0 : 2)}" y="${y}" width="${Math.max(3, to - from - (i === 0 ? 0 : 2))}" height="16" rx="4" fill="${stop.step}"></rect></g>`;
    })
    .join("");

  const labels = stops
    .map((stop) => {
      const cx = x(stop.value);
      const anchor = cx > width - 90 ? "end" : cx < 60 ? "start" : "middle";
      return `<text class="qv" x="${cx}" y="${y - 12}" text-anchor="${anchor}">${compact(stop.value)}</text>
      <text class="qk" x="${cx}" y="${y - 26}" text-anchor="${anchor}">${esc(stop.label)}</text>
      <line class="tick" x1="${cx}" y1="${y - 6}" x2="${cx}" y2="${y + 20}"></line>
      ${options.compact ? "" : `<text class="qc" x="${cx}" y="${y + 36}" text-anchor="${anchor}">${esc(stop.caption)}</text>`}`;
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">${bands}${labels}</svg>`;
}

/**
 * Calibration dot plot: measured coverage against the quantile it promises.
 *
 * A P90 that covers 90% of held-out turns is honest; further left means the
 * forecast is too tight. The target is a tick, the measurement is a dot, and
 * the gap between them is the whole story.
 */
export function calibrationPlot(
  rows: readonly { label: string; nominal: number; actual: number }[],
  axisLabel = "share of held-out tasks the forecast actually covered",
): string {
  if (rows.length === 0) return `<p class="empty">Not measured yet.</p>`;
  const width = 960;
  const rowH = 30;
  const labelW = Math.min(240, Math.max(120, Math.max(...rows.map((r) => r.label.length)) * 6.6 + 14));
  const plotL = labelW;
  const plotR = width - 62;
  const height = rows.length * rowH + 52;
  // Coverage lives in the top of the range; a 0-100% axis would spend most of
  // its width on empty plot. The axis starts a clear margin below the lowest
  // measurement instead, and drops all the way to zero if one is that low.
  // Legitimate here because the marks are positions, not lengths from a base.
  const lowest = Math.min(...rows.map((r) => Math.min(r.actual, r.nominal)));
  const floor = Math.min(0.75, Math.max(0, Math.floor((lowest - 0.1) * 20) / 20));
  const x = (value: number): number =>
    plotL + ((value - floor) / (1 - floor)) * (plotR - plotL);

  const ticks = [floor, floor + (1 - floor) / 2, 1];
  const grid = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${x(t)}" y1="14" x2="${x(t)}" y2="${rows.length * rowH + 12}"></line>
       <text class="ax" x="${x(t)}" y="${rows.length * rowH + 26}" text-anchor="middle">${Math.round(t * 100)}%</text>`,
    )
    .join("");

  const marks = rows
    .map((row, i) => {
      const y = i * rowH + 28;
      const good = Math.abs(row.actual - row.nominal) <= 0.05;
      const colour = good ? "var(--status-good)" : "var(--status-warning)";
      return `<g class="mark">
      <title>${esc(row.label)}: promises ${pct(row.nominal)}, actually covers ${pct(row.actual)}</title>
      <text class="ax" x="${labelW - 10}" y="${y + 4}" text-anchor="end">${esc(row.label)}</text>
      <line class="conn" x1="${x(Math.min(row.actual, row.nominal))}" y1="${y}" x2="${x(Math.max(row.actual, row.nominal))}" y2="${y}"></line>
      <line class="target" x1="${x(row.nominal)}" y1="${y - 8}" x2="${x(row.nominal)}" y2="${y + 8}"></line>
      <circle cx="${x(row.actual)}" cy="${y}" r="5.5" fill="${colour}" class="dot"></circle>
      <text class="val" x="${plotR + 8}" y="${y + 4}">${pct(row.actual)}</text>
    </g>`;
    })
    .join("");

  const axis = `<text class="ax" x="${(plotL + plotR) / 2}" y="${height - 5}" text-anchor="middle">${esc(axisLabel)}</text>`;

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">${grid}${marks}${axis}</svg>
  <ul class="legend">
    <li><span class="sw tgt"></span><b>Target</b> <span class="p">what the forecast promises</span></li>
    <li><span class="sw" style="background:var(--status-good)"></span><b>Measured</b> <span class="p">what actually happened</span></li>
  </ul>`;
}

/**
 * The next "round" number at or above `value`: 1, 2, 2.5 or 5 times a power of
 * ten. Axis ticks land on numbers a reader recognises rather than on whatever
 * the data range happened to be.
 */
function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** A point on a learning curve. */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * A small-multiple line chart: error against amount of history.
 *
 * One series per facet, so no legend box is needed; the facet title names it.
 * The cold-start reference is a labelled horizontal rule, and the crossover
 * point where the personal model overtakes it is the one directly-labelled mark.
 */
export function learningCurve(options: {
  title: string;
  badge: string;
  badgeTone: Tone;
  points: readonly CurvePoint[];
  reference: number;
  referenceLabel: string;
  crossoverX: number | null;
  subtitle: string;
}): string {
  const width = 470;
  const height = 240;
  const padL = 70;
  const padR = 18;
  const padT = 18;
  const padB = 50;
  const points = options.points;

  if (points.length === 0) {
    return `<figure class="facet">
      <figcaption><b>${esc(options.title)}</b> ${pill(options.badgeTone, options.badge)}</figcaption>
      <p class="empty">Not enough history to measure.</p>
      <p class="cap">${esc(options.subtitle)}</p>
    </figure>`;
  }

  const xs = points.map((p) => p.x);
  const ys = [...points.map((p) => p.y), options.reference];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  // Round the y domain out to a nice step so the ticks read 400 / 500 / 600
  // rather than 447 / 514 / 581.
  const rawMin = Math.min(...ys);
  const rawMax = Math.max(...ys);
  const span = Math.max(rawMax - rawMin, rawMax * 0.08, 1);
  const step = niceStep(span / 2);
  const yMin = Math.max(0, Math.floor((rawMin - span * 0.12) / step) * step);
  const yMax = Math.ceil((rawMax + span * 0.12) / step) * step;

  // Log x: the curve is sampled by doubling, so a linear axis would crush every
  // early point against the origin, exactly where the interesting part is.
  const lx = (v: number): number =>
    padL + ((Math.log(Math.max(1, v)) - Math.log(Math.max(1, xMin))) /
      Math.max(0.0001, Math.log(Math.max(1, xMax)) - Math.log(Math.max(1, xMin)))) *
      (width - padL - padR);
  const ly = (v: number): number =>
    padT + (1 - (v - yMin) / Math.max(0.0001, yMax - yMin)) * (height - padT - padB);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${lx(p.x).toFixed(1)},${ly(p.y).toFixed(1)}`).join(" ");
  const dots = points
    .map(
      (p) =>
        `<g class="mark"><title>trained on ${compact(p.x)} examples, average error ${compact(p.y)} tokens</title>
       <circle cx="${lx(p.x).toFixed(1)}" cy="${ly(p.y).toFixed(1)}" r="4" class="pt"></circle></g>`,
    )
    .join("");

  const refY = ly(options.reference);
  const crossover =
    options.crossoverX !== null
      ? `<line class="cross" x1="${lx(options.crossoverX)}" y1="${padT}" x2="${lx(options.crossoverX)}" y2="${height - padB}"></line>
         <text class="crosslbl" x="${lx(options.crossoverX) + 4}" y="${padT + 10}">${compact(options.crossoverX)}</text>`
      : "";

  // The y unit is mean pinball loss, which is carried in the same unit as the
  // thing being forecast (output tokens), so the axis can say so and show real
  // numbers rather than a bare "worse"/"better" direction.
  const yValues: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) yValues.push(v);
  const yTicks = yValues
    .map((v) => `<line class="grid" x1="${padL}" y1="${ly(v)}" x2="${width - padR}" y2="${ly(v)}"></line>`)
    .join("");
  const yLabels = yValues
    .map((v) => `<text class="ax" x="${padL - 8}" y="${ly(v) + 4}" text-anchor="end">${compact(v)}</text>`)
    .join("");
  const midY = padT + (height - padT - padB) / 2;
  const yTitle = `<text class="ax" transform="rotate(-90 14 ${midY.toFixed(1)})" x="14" y="${midY.toFixed(1)}" text-anchor="middle">average error (tokens)</text>`;

  return `<figure class="facet">
    <figcaption><b>${esc(options.title)}</b> ${pill(options.badgeTone, options.badge)}</figcaption>
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">
      ${yTicks}${yLabels}${yTitle}
      <line class="ref" x1="${padL}" y1="${refY}" x2="${width - padR}" y2="${refY}"></line>
      <text class="reflbl" x="${width - padR}" y="${refY - 5}" text-anchor="end">${esc(options.referenceLabel)}</text>
      ${crossover}
      <path class="line" d="${path}"></path>
      ${dots}
      <text class="ax" x="${padL}" y="${height - 26}">${compact(xMin)}</text>
      <text class="ax" x="${width - padR}" y="${height - 26}" text-anchor="end">${compact(xMax)}</text>
      <text class="ax" x="${padL + (width - padL - padR) / 2}" y="${height - 6}" text-anchor="middle">examples used to train (log scale)</text>
    </svg>
    <p class="cap">${esc(options.subtitle)}</p>
  </figure>`;
}

/** A plain table: the relief for every chart, and the accessible value path. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const head = headers
    .map((h, i) => `<th${i > 0 ? ' class="num"' : ""}>${esc(h)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td${i > 0 ? ' class="num"' : ""}>${cell}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A collapsible wrapper, so a table can be present without dominating. */
export function details(summary: string, content: string): string {
  if (!content) return "";
  return `<details><summary>${esc(summary)}</summary>${content}</details>`;
}

/** A named series for {@link timeSeries}. */
export interface SeriesSpec {
  label: string;
  slot: 1 | 2 | 3;
  /** Values aligned to the shared category axis; missing buckets are 0. */
  values: readonly number[];
}

/**
 * Stacked area over time.
 *
 * Stacked rather than overlaid because the question is "how much history do we
 * have, and when": a total with its composition, not a comparison of two
 * independent lines. A legend is always present, and the table view carries
 * every value.
 */
export function timeSeries(options: {
  categories: readonly string[];
  series: readonly SeriesSpec[];
  /** What the height of the stack measures. */
  yLabel?: string;
  /** What one step along the x axis is. */
  xLabel?: string;
}): string {
  const { categories, series } = options;
  if (categories.length === 0 || series.length === 0) {
    return `<p class="empty">No history indexed yet.</p>`;
  }
  const width = 960;
  const height = 276;
  const padL = 68;
  const padR = 14;
  const padT = 14;
  const padB = 48;

  const totals = categories.map((_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const yMax = Math.max(...totals, 1);
  const x = (i: number): number =>
    padL + (categories.length === 1 ? 0 : (i / (categories.length - 1)) * (width - padL - padR));
  const y = (v: number): number => padT + (1 - v / yMax) * (height - padT - padB);

  // Build stacked bands bottom-up so each series sits on the one below it.
  const baseline = new Array(categories.length).fill(0) as number[];
  const bands = series
    .map((spec) => {
      const top = baseline.map((b, i) => b + (spec.values[i] ?? 0));
      const up = top.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const down = baseline
        .map((v, i) => `L${x(baseline.length - 1 - i).toFixed(1)},${y(baseline[baseline.length - 1 - i]!).toFixed(1)}`)
        .join(" ");
      const path = `${up} ${down} Z`;
      for (let i = 0; i < baseline.length; i += 1) baseline[i] = top[i]!;
      return `<path d="${path}" fill="var(--series-${spec.slot})" opacity="0.85"></path>`;
    })
    .join("");

  const grid = [0, 0.5, 1]
    .map((t) => {
      const v = yMax * t;
      return `<line class="grid" x1="${padL}" y1="${y(v)}" x2="${width - padR}" y2="${y(v)}"></line>
      <text class="ax" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${compact(v)}</text>`;
    })
    .join("");

  const firstLabel = categories[0] ?? "";
  const lastLabel = categories[categories.length - 1] ?? "";
  const legend = series
    .map(
      (spec) =>
        `<li><span class="sw" style="background:var(--series-${spec.slot})"></span><b>${esc(spec.label)}</b>
       <span class="n">${compact(spec.values.reduce((a, b) => a + b, 0))}</span></li>`,
    )
    .join("");

  const midY = padT + (height - padT - padB) / 2;
  const yTitle = options.yLabel
    ? `<text class="ax" transform="rotate(-90 14 ${midY.toFixed(1)})" x="14" y="${midY.toFixed(1)}" text-anchor="middle">${esc(options.yLabel)}</text>`
    : "";
  const xTitle = options.xLabel
    ? `<text class="ax" x="${padL + (width - padL - padR) / 2}" y="${height - 6}" text-anchor="middle">${esc(options.xLabel)}</text>`
    : "";

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">
    ${grid}${bands}${yTitle}
    <text class="ax" x="${padL}" y="${height - 26}">${esc(firstLabel)}</text>
    <text class="ax" x="${width - padR}" y="${height - 26}" text-anchor="end">${esc(lastLabel)}</text>
    ${xTitle}
  </svg>
  <ul class="legend">${legend}</ul>`;
}

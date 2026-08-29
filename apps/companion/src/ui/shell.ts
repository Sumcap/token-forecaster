import { esc } from "./charts.js";

/**
 * The application shell: design tokens, the app bar, the page frame.
 *
 * The dashboard is ONE scrolling page. Everything it knows is derived from the
 * same rebuild, so splitting it across routes made the reader navigate to
 * assemble a single answer. A slim section rail in the app bar jumps to each
 * part; the browser's own find still reaches every number.
 *
 * Colour tokens come from a palette validated with the data-viz validator in
 * both modes on this page's own surfaces (all-pairs: CVD ΔE 8.9 light / 12.6
 * dark, normal-vision 25.5 / 22.2, every slot ≥ 3:1 on its surface). Light
 * values are declared on bare `:root`; dark redefines only the tokens, under
 * both the OS media query and an explicit `data-theme`, so neither can strand
 * the other.
 */

/** The one page. Kept as a list so routing stays data-driven. */
export const PAGES = [{ slug: "", title: "Dashboard" }] as const;

export type PageSlug = (typeof PAGES)[number]["slug"];

/** The sections of that page, in order. `id` is the anchor the rail jumps to. */
export const SECTIONS = [
  { id: "status", title: "Status", question: "Is it working?" },
  { id: "data", title: "Data", question: "What did we read?" },
  { id: "model", title: "Model", question: "What does it predict?" },
  { id: "accuracy", title: "Accuracy", question: "Is it right?" },
  { id: "maturity", title: "Data needed", question: "Would more history help?" },
] as const;

const STYLE = `
:root {
  color-scheme: light;
  --plane:        #f1efe9;
  --surface:      #fbfaf7;
  --surface-2:    #ebe8e0;
  --bar:          rgba(251,250,247,0.82);
  --ink:          #14130f;
  --ink-2:        #4c4a44;
  --muted:        #8b877d;
  --grid:         #e3e0d7;
  --axis:         #c8c4b8;
  --border:       rgba(20,19,15,0.11);
  --rule:         rgba(20,19,15,0.16);
  --series-1:     #5b4bd6;
  --series-2:     #e0652f;
  --series-3:     #128a76;
  --seq-1:        #a9a2ee;
  --seq-2:        #7466e0;
  --seq-3:        #4636b0;
  --accent:       #5b4bd6;
  --accent-soft:  rgba(91,75,214,0.10);
  --status-good:     #0ca30c;
  --status-warning:  #fab219;
  --status-serious:  #ec835a;
  --status-critical: #d03b3b;
  --status-neutral:  #8b877d;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --plane:     #0e0f11;
    --surface:   #1b1c1f;
    --surface-2: #24262a;
    --bar:       rgba(27,28,31,0.82);
    --ink:       #f5f4f1;
    --ink-2:     #c0bfba;
    --muted:     #8b8a85;
    --grid:      #2b2d31;
    --axis:      #3a3c41;
    --border:    rgba(255,255,255,0.10);
    --rule:      rgba(255,255,255,0.16);
    --series-1:  #8079e6;
    --series-2:  #e0652f;
    --series-3:  #1aa38b;
    --seq-1:     #c4bef4;
    --seq-2:     #8079e6;
    --seq-3:     #5344c0;
    --accent:      #8079e6;
    --accent-soft: rgba(128,121,230,0.14);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane:#0e0f11; --surface:#1b1c1f; --surface-2:#24262a; --bar:rgba(27,28,31,0.82);
  --ink:#f5f4f1; --ink-2:#c0bfba; --muted:#8b8a85;
  --grid:#2b2d31; --axis:#3a3c41;
  --border:rgba(255,255,255,0.10); --rule:rgba(255,255,255,0.16);
  --series-1:#8079e6; --series-2:#e0652f; --series-3:#1aa38b;
  --seq-1:#c4bef4; --seq-2:#8079e6; --seq-3:#5344c0;
  --accent:#8079e6; --accent-soft:rgba(128,121,230,0.14);
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ---- app bar: one row, brand + section rail ---- */
header.app {
  position: sticky; top: 0; z-index: 5;
  background: var(--bar);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid var(--border);
}
.bar {
  display: flex; align-items: center; gap: 6px 20px; flex-wrap: wrap;
  max-width: 1060px; margin: 0 auto; padding: 0 22px; min-height: 46px;
}
a.brand {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  color: var(--ink); text-decoration: none;
  font-size: 13.5px; font-weight: 650; letter-spacing: -.01em;
}
a.brand .logo { width: 16px; height: 16px; display: block; }
nav.rail { display: flex; gap: 1px; overflow-x: auto; scrollbar-width: none; }
nav.rail::-webkit-scrollbar { display: none; }
nav.rail a {
  display: block; padding: 4px 10px; border-radius: 7px; text-decoration: none;
  color: var(--ink-2); font-size: 13px; font-weight: 500; white-space: nowrap;
}
nav.rail a:hover { color: var(--accent); background: var(--accent-soft); }

/* ---- page ---- */
main { max-width: 1060px; margin: 0 auto; padding: 30px 22px 72px; }
.hero { margin: 0 0 8px; }
.lede { font-size: 25px; font-weight: 660; letter-spacing: -.022em; margin: 0 0 3px; }
.sub { color: var(--muted); margin: 0; font-size: 13.5px; max-width: 62ch; }

/* ---- metric strip: the numbers, unboxed ---- */
.metrics {
  display: flex; flex-wrap: wrap; margin: 20px 0 0; padding: 0;
  row-gap: 18px;
}
.metrics.tight { margin: 2px 0 20px; }
.metrics > div {
  padding: 1px 24px; border-left: 1px solid var(--border);
}
.metrics > div:first-child { padding-left: 0; border-left: 0; }
.metrics dt {
  font-size: 10.5px; font-weight: 640; letter-spacing: .07em;
  text-transform: uppercase; color: var(--muted); margin: 0 0 3px;
}
.metrics dd { margin: 0; }
.metrics .v { font-size: 27px; font-weight: 620; letter-spacing: -.028em; line-height: 1.12; }
.metrics.tight .v { font-size: 22px; }
.metrics .s { font-size: 12px; color: var(--muted); margin-top: 2px; }
.metrics .tone-good .v { color: var(--status-good); }
.metrics .tone-warning .v { color: var(--status-warning); }
.metrics .tone-critical .v { color: var(--status-critical); }

/* ---- sections ---- */
section.sec { margin-top: 42px; scroll-margin-top: 62px; }
.sec-h {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding-bottom: 9px; margin-bottom: 18px; border-bottom: 1px solid var(--rule);
}
.sec-h h2 { font-size: 15.5px; font-weight: 660; margin: 0; letter-spacing: -.012em; }
.sec-h .q { margin: 0; color: var(--muted); font-size: 13px; }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px 18px; margin-bottom: 14px;
}
.card > h3 { font-size: 14px; font-weight: 640; margin: 0 0 2px; letter-spacing: -.01em; }
.card > .why { color: var(--muted); font-size: 12.5px; margin: 0 0 14px; max-width: 76ch; }
/* Two columns exactly, never three: an odd count then orphans at most one card
   on a half-width row rather than stranding it on a row of its own. */
.grid2 { display: grid; grid-template-columns: 1fr; gap: 14px; }
@media (min-width: 700px) { .grid2 { grid-template-columns: repeat(2, 1fr); } }
.grid2 .card { margin-bottom: 0; }

/* ---- charts ---- */
svg.chart { width: 100%; height: auto; display: block; overflow: visible; }
svg.chart text { font: 12px system-ui, -apple-system, sans-serif; }
.ax { fill: var(--muted); font-size: 11.5px !important; font-variant-numeric: tabular-nums; }
.val { fill: var(--ink-2); font-size: 12px !important; font-weight: 560; font-variant-numeric: tabular-nums; }
.track { fill: var(--surface-2); }
.grid { stroke: var(--grid); stroke-width: 1; }
.tick { stroke: var(--axis); stroke-width: 1; }
.conn { stroke: var(--axis); stroke-width: 2; }
.target { stroke: var(--ink-2); stroke-width: 2; }
.dot { stroke: var(--surface); stroke-width: 2; }
.line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.pt { fill: var(--series-1); stroke: var(--surface); stroke-width: 2; }
.ref { stroke: var(--series-2); stroke-width: 2; }
.reflbl { fill: var(--series-2); font-size: 10.5px !important; font-weight: 600; }
.cross { stroke: var(--status-good); stroke-width: 2; }
.crosslbl { fill: var(--status-good); font-size: 10.5px !important; font-weight: 650; }
.qv { fill: var(--ink); font-size: 15px !important; font-weight: 640; }
.qk { fill: var(--muted); font-size: 10.5px !important; font-weight: 600; letter-spacing: .06em; }
.qc { fill: var(--ink-2); font-size: 11.5px !important; }
g.mark { cursor: default; }
g.mark:hover rect[fill], g.mark:hover circle { opacity: .78; }

.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 12px 0 0; margin: 0; font-size: 12.5px; }
.legend li { display: flex; align-items: center; gap: 7px; color: var(--ink-2); }
.legend .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.legend .sw.tgt { width: 2px; height: 13px; border-radius: 0; background: var(--ink-2); }
.legend .n { font-variant-numeric: tabular-nums; font-weight: 560; }
.legend .p { color: var(--muted); }
.cap { color: var(--muted); font-size: 12.5px; margin: 12px 0 0; }
.empty { color: var(--muted); font-size: 13px; margin: 6px 0; }

/* ---- facets: a fixed two-column grid, so four never orphan one ---- */
.facets { display: grid; grid-template-columns: 1fr; gap: 22px 26px; }
@media (min-width: 700px) { .facets { grid-template-columns: repeat(2, 1fr); } }
.facet { margin: 0; display: flex; flex-direction: column; }
.facet figcaption { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 8px; }
/* Subtitles run one or two lines; reserving both keeps the row baselines even. */
.facet .cap { min-height: 2.7em; margin-top: 10px; }

/* ---- pills & rows ---- */
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 600; padding: 2px 8px 2px 6px;
  border-radius: 99px; border: 1px solid currentColor; white-space: nowrap;
}
.pill .ico { font-size: 8px; line-height: 1; }
.t-good { color: var(--status-good); }
.t-warning { color: var(--status-warning); }
.t-serious { color: var(--status-serious); }
.t-critical { color: var(--status-critical); }
.t-neutral { color: var(--muted); }

.checks { list-style: none; margin: 0; padding: 0; }
/* Three fixed columns. Laid out as a flex row the pills push each row's detail
   to a different x, because "Connected" and "4 of 4" are not the same width. */
.checks li {
  display: grid; grid-template-columns: 200px 122px 1fr;
  align-items: center; gap: 14px;
  padding: 11px 0; border-bottom: 1px solid var(--border);
}
.checks li:last-child { border-bottom: 0; }
.checks .what { font-weight: 560; }
.checks .pill { justify-self: start; }
.checks .detail { color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
  .checks li { grid-template-columns: 1fr auto; row-gap: 5px; }
  .checks .detail { grid-column: 1 / -1; }
}

/* ---- tables ---- */
details { margin-top: 14px; }
details summary {
  cursor: pointer; font-size: 12.5px; color: var(--muted);
  padding: 5px 0; list-style: none; user-select: none;
}
details summary::-webkit-details-marker { display: none; }
details summary::before { content: "▸ "; }
details[open] summary::before { content: "▾ "; }
details summary:hover { color: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-top: 6px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }

footer.app { color: var(--muted); font-size: 12px; padding: 20px 0 0; border-top: 1px solid var(--border); margin-top: 44px; }
@media (max-width: 620px) {
  .bar { padding: 7px 14px; }
  main { padding: 20px 14px 52px; }
  /* Dividers only read as dividers on one row; once the strip wraps they
     become stray rules, so the figures separate by space instead. */
  .metrics { gap: 18px 26px; }
  .metrics > div { padding: 0; border-left: 0; }
  /* A chart squeezed to phone width has unreadable axis text. Let the card
     scroll it instead, so the page body never scrolls sideways. */
  .card { overflow-x: auto; }
  svg.chart { min-width: 560px; }
}
`;

const LOGO = `<svg class="logo" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
<rect x="0.5" y="9" width="4" height="6" rx="1.2" fill="var(--seq-1)"></rect>
<rect x="6" y="5.5" width="4" height="9.5" rx="1.2" fill="var(--seq-2)"></rect>
<rect x="11.5" y="1.5" width="4" height="13.5" rx="1.2" fill="var(--seq-3)"></rect>
</svg>`;

/** Wrap the page content in the shell. `token` keeps the home link authenticated. */
export function shell(options: {
  token: string;
  lede: string;
  sub: string;
  metrics: string;
  body: string;
  footer: string;
}): string {
  const home = `/dashboard?token=${encodeURIComponent(options.token)}`;
  const rail = SECTIONS.map(
    (section) => `<a href="#${section.id}">${esc(section.title)}</a>`,
  ).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Forecaster</title>
<style>${STYLE}</style></head>
<body>
<header class="app">
  <div class="bar">
    <a class="brand" href="${home}">${LOGO}Token Forecaster</a>
    <nav class="rail" aria-label="Sections">${rail}</nav>
  </div>
</header>
<main>
  <div class="hero">
    <h1 class="lede">${esc(options.lede)}</h1>
    <p class="sub">${esc(options.sub)}</p>
    ${options.metrics}
  </div>
  ${options.body}
  <footer class="app">${options.footer}</footer>
</main>
</body></html>`;
}

/** A section with its heading rule and anchor. */
export function section(id: string, body: string): string {
  const meta = SECTIONS.find((s) => s.id === id);
  return `<section class="sec" id="${esc(id)}">
    <div class="sec-h"><h2>${esc(meta?.title ?? id)}</h2><p class="q">${esc(meta?.question ?? "")}</p></div>
    ${body}
  </section>`;
}

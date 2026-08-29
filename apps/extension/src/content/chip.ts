/**
 * The chip itself: one Shadow DOM overlay appended to `document.body`.
 *
 * It is never inserted into the app's React tree. A fixed-position sibling of
 * the app cannot be unmounted by a re-render and cannot disturb the page
 * layout; the cost is that it has to follow the composer's rectangle by hand.
 *
 * This file renders a decided view model. Every number, string, and percentage
 * comes from `lib/engine.ts`; nothing is computed here.
 */
import type {
  ChipViewModel,
  ContextMeter,
  ForecastBand,
  LedgerView,
  LiveView,
} from "../lib/engine.js";
import { STRINGS } from "../lib/format.js";
import { detectDarkPage } from "../lib/theme.js";

const HOST_ID = "token-forecaster-chip-host";
const PANEL_ID = "tf-panel";
/** The panel never comes closer than this to the top of the viewport. */
const TOP_MARGIN_PX = 16;
const MAX_PANEL_HEIGHT_PX = 300;
/** Gap kept between the pill and the composer's edge, and beside a decoration. */
const CLEARANCE_PX = 10;
/** Bigger than this in either direction is page furniture, not a decoration. */
const DECORATION_MAX_PX = 160;
/** Elements measured in one scan, at most. A cap, never a normal outcome. */
const SCAN_BUDGET = 600;
/** Rounds of dodging. Two decorations side by side is already unlikely. */
const DODGE_ROUNDS = 3;
/** The pill never ends up closer than this to the left of the viewport. */
const LEFT_MARGIN_PX = 8;

const STYLE = `
:host { all: initial; }
.wrap {
  --fg: #2c2b28;
  --muted: #6b6a66;
  --faint: #7c7a73;
  --surface: rgba(255, 255, 255, 0.94);
  --panel: rgba(255, 255, 255, 0.98);
  --edge: rgba(0, 0, 0, 0.12);
  --edge-soft: rgba(0, 0, 0, 0.08);
  --track: rgba(0, 0, 0, 0.07);
  --data: #2a78d6;
  --meter-neutral: #7c7a73;
  --lvl-informational: #9a6700;
  --lvl-warning: #bc4c00;
  --lvl-critical: #cf222e;
  --lvl-overflow: #82071e;
  --lvl-normal: var(--meter-neutral);
  --verified: #1a7f37;
  --accent-bg: #2c2b28;
  --accent-fg: #ffffff;
  --focus: #2a78d6;
  position: fixed;
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 12px;
  line-height: 16px;
  color: var(--fg);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.wrap.dark {
  --fg: #ececec;
  --muted: #a3a29c;
  --faint: #8f8e88;
  --surface: rgba(38, 38, 36, 0.94);
  --panel: rgba(30, 30, 28, 0.98);
  --edge: rgba(255, 255, 255, 0.16);
  --edge-soft: rgba(255, 255, 255, 0.09);
  --track: rgba(255, 255, 255, 0.1);
  --data: #3987e5;
  --meter-neutral: #8b8a83;
  --lvl-informational: #d4a72c;
  --lvl-warning: #f0883e;
  --lvl-critical: #e5534b;
  --lvl-overflow: #ff7b72;
  --verified: #3fb950;
  --accent-bg: #ececec;
  --accent-fg: #1e1e1c;
  --focus: #3987e5;
}

/* ---- pill ---- */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* Hugs its content. The wrap is right-anchored, so the pill grows leftwards
     and the edge nearest the composer never moves; a min-width would only buy
     jitter-free text at the price of dead space inside the pill. */
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--edge);
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  cursor: pointer;
  white-space: nowrap;
  font: inherit;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(6px);
}
.pill:hover { border-color: var(--muted); }
.pill:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.pill.empty { opacity: 0.62; }
.pill.level-warning { border-color: var(--lvl-warning); }
.pill.level-critical { border-color: var(--lvl-critical); }
.pill.level-overflow { border-color: var(--lvl-overflow); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.dot.verified { background: var(--verified); }
.dot.pulsing { animation: tf-pulse 1.2s ease-in-out infinite; }

/* ---- pill meter: the panel's context bar, shrunk ---- */
.pill-meter {
  flex: none;
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--track);
  display: flex;
  gap: 1px;
  overflow: hidden;
}
.pill-meter[hidden] { display: none; }
.pill-meter .fill { flex: none; border-radius: 2px 0 0 2px; background: var(--fill); }
/* Same rule as the panel: a lower bound must not end in a confident edge. */
.pill-meter .fill.bounded {
  background: linear-gradient(90deg, var(--fill) 0%, var(--fill) calc(100% - 5px), transparent 100%);
}
.pill-meter .reserved { flex: none; opacity: 0.3; background: var(--fill); }
.pill-meter.over { box-shadow: inset 0 0 0 1px var(--lvl-overflow); }
.pill-pct {
  flex: none;
  font-size: 10px;
  line-height: 16px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.pill-pct[hidden] { display: none; }

/* ---- panel ---- */
.panel {
  width: 340px;
  max-width: 92vw;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--edge);
  background: var(--panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.panel[hidden] { display: none; }
.section + .section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--edge-soft); }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.kicker {
  font-size: 10px;
  line-height: 14px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.head-value { font-size: 11px; line-height: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }
.head-value .dot { display: inline-block; margin-right: 4px; vertical-align: middle; }
.headline {
  margin-top: 4px;
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.headline .badge { font-size: 11px; font-weight: 400; color: var(--muted); }
.note { font-size: 11px; line-height: 14px; color: var(--muted); }
.faint { font-size: 10px; line-height: 13px; color: var(--faint); }

/* ---- band ---- */
.band { margin-top: 6px; }
.band-track {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 4px;
  background: var(--track);
  overflow: hidden;
}
.band-seg { background: var(--data); flex: none; }
.band-ticks { position: relative; height: 14px; margin-top: 3px; }
.band-ticks span {
  position: absolute;
  font-size: 10px;
  line-height: 14px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.band-ticks span.center { transform: translateX(-50%); }
.band-ticks span.end { right: 0; }

/* ---- context meter ---- */
.meter-track {
  height: 4px;
  border-radius: 2px;
  background: var(--track);
  display: flex;
  gap: 2px;
  margin-top: 4px;
  overflow: hidden;
}
.meter-fill { flex: none; border-radius: 2px 0 0 2px; background: var(--fill); }
/* A lower bound must not end in a confident edge, so the fill fades out. */
.meter-fill.bounded {
  background: linear-gradient(90deg, var(--fill) 0%, var(--fill) calc(100% - 12px), transparent 100%);
}
.meter-reserved { flex: none; opacity: 0.3; background: var(--fill); }
.meter-track.over { box-shadow: inset 0 0 0 1px var(--lvl-overflow); }
.warn {
  margin-top: 6px;
  padding-left: 6px;
  /* Follows the context level, so the words and the meter never disagree. */
  border-left: 3px solid var(--warn-color, var(--lvl-warning));
  font-size: 11px;
  line-height: 14px;
  color: var(--warn-color, var(--lvl-warning));
}

/* ---- meta ---- */
.cost { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.cost-label { font-size: 11px; color: var(--muted); }
.cost-value { font-size: 12px; font-variant-numeric: tabular-nums; }
.cost-value .unit { font-size: 11px; color: var(--muted); margin-left: 4px; }
.meta { margin-top: 4px; font-size: 11px; line-height: 15px; color: var(--muted); }
.caveat { margin-top: 8px; }
.actions { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.actions-label { font-size: 11px; color: var(--muted); }
button.seg, button.link {
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--edge);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button.seg[aria-pressed="true"] { background: var(--accent-bg); color: var(--accent-fg); border-color: var(--accent-bg); }
button.link { border-color: transparent; text-decoration: underline; margin-left: auto; }
button.seg:focus-visible, button.link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* ---- tones: one scale shared by the pill, the live band, and the ledger ---- */
.tone-good { --tone: var(--verified); }
.tone-ok { --tone: var(--data); }
.tone-warn { --tone: var(--lvl-warning); }
.tone-bad { --tone: var(--lvl-critical); }
.tone-off { --tone: var(--faint); }

/* ---- live: the turn being written right now ---- */
.pill.live { border-color: var(--tone); }
.pill-live {
  flex: none;
  position: relative;
  width: 44px;
  height: 4px;
  border-radius: 2px;
  background: var(--track);
  overflow: hidden;
}
.pill-live[hidden] { display: none; }
.pill-live .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--tone); }
.pill-live .mark { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--fg); opacity: 0.45; }

.band-marker {
  position: absolute;
  top: -2px;
  height: 12px;
  width: 2px;
  border-radius: 1px;
  background: var(--tone, var(--fg));
  box-shadow: 0 0 0 1px var(--panel);
  transform: translateX(-1px);
}
.live-verdict { color: var(--tone); font-weight: 600; }

/* ---- ledger: the whole conversation's score ---- */
.ledger-bar {
  position: relative;
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  margin-top: 6px;
  overflow: hidden;
}
.ledger-fill { height: 100%; border-radius: 3px; background: var(--tone); }
.ledger-mark { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--fg); opacity: 0.45; }
.dots { display: flex; gap: 3px; margin-top: 6px; flex-wrap: wrap; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); flex: none; }

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@keyframes tf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
  .dot.pulsing { animation: none; box-shadow: inset 0 0 0 2px var(--faint); background: transparent; }
  .band-seg, .meter-fill, .meter-reserved, .pill-meter .fill, .pill-meter .reserved { transition: none; }
}
@media (prefers-reduced-motion: no-preference) {
  .band-seg, .meter-fill, .meter-reserved, .pill-meter .fill, .pill-meter .reserved { transition: width 120ms ease; }
  .pill-live .fill, .ledger-fill { transition: width 160ms ease; }
  .band-marker { transition: left 160ms ease; }
  /* The chip walks to the writing edge and back rather than teleporting: an
     overlay that jumps is read as a new element, not a moved one. */
  .wrap { transition: bottom 180ms ease, right 180ms ease; }
}
`;

export interface ChipCallbacks {
  onThinkingChange(next: "on" | "off"): void;
  onExpandedChange(expanded: boolean): void;
  onOpenOptions(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Chip {
  private readonly host: HTMLDivElement;
  private readonly wrap: HTMLDivElement;
  private readonly pill: HTMLButtonElement;
  private readonly dot: HTMLSpanElement;
  private readonly pillText: HTMLSpanElement;
  private readonly pillMeter: HTMLSpanElement;
  private readonly pillFill: HTMLSpanElement;
  private readonly pillReserved: HTMLSpanElement;
  private readonly pillPct: HTMLSpanElement;
  private readonly pillLive: HTMLSpanElement;
  private readonly pillLiveFill: HTMLSpanElement;
  private readonly pillLiveP50: HTMLSpanElement;
  private readonly pillLiveP90: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private anchor: HTMLElement | null = null;
  /** The message being written, while one is. The chip walks to it. */
  private liveAnchor: HTMLElement | null = null;
  private expanded: boolean;
  private visible = true;
  private frame = 0;
  private lastLevel: ChipViewModel["pill"]["level"] = "normal";
  private lastVerified = false;
  private lastTone: LiveView["tone"] | null = null;
  /** Geometry the last scan was measured against, so typing does not rescan. */
  private dodgeKey = "";
  private obstacles: DOMRect[] = [];

  constructor(
    private readonly callbacks: ChipCallbacks,
    options: { expanded?: boolean } = {},
  ) {
    this.expanded = options.expanded ?? false;
    document.getElementById(HOST_ID)?.remove();

    this.host = element("div");
    this.host.id = HOST_ID;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = STYLE;
    shadow.append(style);

    this.wrap = element("div", "wrap");
    this.panel = element("div", "panel");
    this.panel.id = PANEL_ID;
    this.panel.setAttribute("role", "region");
    this.panel.setAttribute("aria-label", "Token forecast details");
    this.pill = element("button", "pill");
    this.pill.type = "button";
    this.pill.setAttribute("aria-controls", PANEL_ID);
    this.dot = element("span", "dot");
    this.pillText = element("span");
    this.pillMeter = element("span", "pill-meter");
    // Decoration only: the button carries one aria-label that already states
    // the context figure, and a meter role nested in a button is not reliably
    // announced anyway.
    this.pillMeter.setAttribute("aria-hidden", "true");
    this.pillFill = element("span", "fill");
    this.pillReserved = element("span", "reserved");
    this.pillMeter.append(this.pillFill, this.pillReserved);
    this.pillPct = element("span", "pill-pct");
    this.pillPct.setAttribute("aria-hidden", "true");
    this.pillLive = element("span", "pill-live");
    this.pillLive.setAttribute("aria-hidden", "true");
    this.pillLiveFill = element("span", "fill");
    this.pillLiveP50 = element("span", "mark");
    this.pillLiveP90 = element("span", "mark");
    this.pillLive.append(this.pillLiveFill, this.pillLiveP50, this.pillLiveP90);
    this.pill.append(this.dot, this.pillText, this.pillMeter, this.pillPct, this.pillLive);
    this.pill.addEventListener("click", () => this.toggle());
    // Clicking the chip must not pull the caret out of the composer.
    this.wrap.addEventListener("mousedown", (event) => event.preventDefault());
    this.wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.expanded) {
        event.stopPropagation();
        this.setExpanded(false);
        this.pill.focus();
      }
    });
    this.live = element("div", "sr");
    this.live.setAttribute("aria-live", "polite");
    this.wrap.append(this.panel, this.pill, this.live);
    shadow.append(this.wrap);
    document.body.append(this.host);

    this.panel.hidden = !this.expanded;
    this.pill.setAttribute("aria-expanded", String(this.expanded));
    // Hidden until a composer exists: an unpositioned overlay in the corner of
    // an unrelated page is worse than no chip at all.
    this.applyVisibility();
    document.addEventListener("pointerdown", this.onOutsidePointer, true);
    window.addEventListener("scroll", this.scheduleReposition, true);
    window.addEventListener("resize", this.scheduleReposition);
  }

  private readonly onOutsidePointer = (event: Event): void => {
    if (!this.expanded) return;
    const path = event.composedPath();
    if (path.includes(this.host)) return;
    this.setExpanded(false);
  };

  private readonly scheduleReposition = (): void => {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.reposition();
    });
  };

  /** Follow a new composer node. Passing null hides the chip. */
  attachTo(anchor: HTMLElement | null): void {
    this.anchor = anchor;
    // A new composer is a new layout: whatever was beside the old one is not
    // evidence about this one.
    this.dodgeKey = "";
    this.applyVisibility();
    this.reposition();
  }

  /**
   * Follow the reply being written, or stop following it.
   *
   * The composer anchor is kept either way: it is what the chip walks back to
   * when the turn ends, and what stops the chip from wandering over the
   * composer while the reply is still short.
   */
  setLiveAnchor(anchor: HTMLElement | null): void {
    if (this.liveAnchor === anchor) return;
    this.liveAnchor = anchor;
    this.reposition();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = this.visible && this.anchor !== null;
    this.host.style.display = show ? "block" : "none";
  }

  private toggle(): void {
    this.setExpanded(!this.expanded);
    this.callbacks.onExpandedChange(this.expanded);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.panel.hidden = !expanded;
    this.pill.setAttribute("aria-expanded", String(expanded));
    this.reposition();
  }

  /**
   * Pin the chip to the composer's top-right corner and cap the panel so it
   * can never run off the top of the viewport. Short viewport means a shorter
   * panel that scrolls inside, never a panel that escapes.
   */
  reposition(): void {
    if (this.anchor === null || !this.anchor.isConnected) return;
    const rect = this.anchor.getBoundingClientRect();
    const park = Math.max(8, window.innerHeight - rect.top + 8);
    const live = this.livePlacement(park);
    const bottom = live === null ? park : live.bottom;
    this.wrap.style.bottom = `${bottom}px`;
    this.wrap.style.right = `${
      live === null
        ? Math.max(8, window.innerWidth - rect.right + CLEARANCE_PX + this.dodge(rect))
        : live.right
    }px`;
    const room = Math.max(120, window.innerHeight - bottom - TOP_MARGIN_PX - 34);
    this.panel.style.maxHeight = `${Math.min(MAX_PANEL_HEIGHT_PX, room)}px`;
  }

  /**
   * Where the chip stands while a reply is being written.
   *
   * Beside the message, in the right-hand gutter, level with the last line on
   * screen: the composer is empty for the whole turn, so pinning to it parks
   * the one live number on the page next to the one thing nobody is looking
   * at. Two rules keep the move safe. It never crosses the composer, because
   * the parked position is the floor; and with no gutter wide enough to stand
   * in, it does not move at all, because overlapping the reply it is
   * describing would be worse than being in the wrong corner.
   */
  private livePlacement(park: number): { bottom: number; right: number } | null {
    if (this.liveAnchor === null || !this.liveAnchor.isConnected) return null;
    const pill = this.pill.getBoundingClientRect();
    if (pill.width === 0 || pill.height === 0) return null;
    const target = this.liveAnchor.getBoundingClientRect();
    if (target.width === 0 && target.height === 0) return null;
    const right = window.innerWidth - target.right - CLEARANCE_PX - pill.width;
    if (right < LEFT_MARGIN_PX) return null;
    const ceiling = Math.max(park, window.innerHeight - TOP_MARGIN_PX - pill.height);
    const bottom = Math.min(Math.max(window.innerHeight - target.bottom, park), ceiling);
    return { bottom, right };
  }

  /**
   * How far left the pill has to move so it covers nothing the page painted.
   *
   * The chip is a fixed overlay at the top of the stacking order, so whatever
   * it lands on is simply gone, and claude.ai/code paints a mascot beside the
   * composer's top-right corner. This measures what is really in the pill's row
   * rather than reserving a fixed strip that would be dead space on every other
   * layout. `elementsFromPoint` would be shorter, but a decorative sprite with
   * `pointer-events: none` is invisible to a hit test, and a decoration is
   * exactly the kind of thing that carries it.
   *
   * The geometry is derived from the anchor and the pill's own size, never from
   * the `right` this returns: a measurement of the moved pill would find the
   * decoration clear, move back, and oscillate.
   */
  private dodge(anchor: DOMRect): number {
    const pill = this.pill.getBoundingClientRect();
    if (pill.width === 0 || pill.height === 0) return 0;
    const bottom = anchor.top - 8;
    const top = bottom - pill.height;
    // The scan is cached against the row, not against the pill's width: the
    // width changes on almost every keystroke, and what the page painted beside
    // the composer does not.
    const key = [anchor.right, anchor.width, top, bottom, window.innerWidth]
      .map((value) => Math.round(value))
      .join(":");
    if (key !== this.dodgeKey) {
      this.dodgeKey = key;
      this.obstacles = this.decorationsInRow(top, bottom);
    }
    const obstacles = this.obstacles;

    let right = anchor.right - CLEARANCE_PX;
    for (let round = 0; round < DODGE_ROUNDS; round += 1) {
      const left = right - pill.width;
      // Only a decoration that starts inside the pill's span can be dodged by
      // moving left; one that starts further left would still be underneath.
      const blocking = obstacles.filter((rect) => rect.left >= left && rect.left < right);
      if (blocking.length === 0) break;
      right = Math.min(...blocking.map((rect) => rect.left)) - CLEARANCE_PX;
    }
    // Overlapping a decoration beats sliding the pill off the screen.
    if (right - pill.width < LEFT_MARGIN_PX) return 0;
    return Math.max(0, anchor.right - CLEARANCE_PX - right);
  }

  /**
   * Small painted things that share the pill's row.
   *
   * The walk descends only through boxes big enough to be containers, so most
   * of the page is pruned at the first level, and it stops at a budget rather
   * than trusting the page to be shallow.
   */
  private decorationsInRow(top: number, bottom: number): DOMRect[] {
    const found: DOMRect[] = [];
    const queue: Element[] = [document.body];
    let budget = SCAN_BUDGET;
    while (queue.length > 0 && budget > 0) {
      const node = queue.shift()!;
      for (const child of Array.from(node.children)) {
        if (budget-- <= 0) break;
        if (child === this.host || child === this.anchor) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Nothing below or above the row can be covered by the pill.
        if (rect.bottom <= top || rect.top >= bottom) continue;
        if (rect.width > DECORATION_MAX_PX || rect.height > DECORATION_MAX_PX) {
          queue.push(child);
          continue;
        }
        // The composer's own controls are page furniture the chip sits beside,
        // not decoration it has to dodge; they never reach into its corner.
        if (this.anchor !== null && child.contains(this.anchor)) continue;
        found.push(rect);
      }
    }
    return found;
  }

  render(model: ChipViewModel): void {
    const live = model.live;
    this.wrap.className = `wrap${detectDarkPage() ? " dark" : ""}`;
    this.pillText.textContent = model.pill.text;
    this.pill.className = `pill${model.state === "empty" ? " empty" : ""} level-${
      model.pill.level
    }${live === null ? "" : ` live tone-${live.tone}`}`;
    this.pill.setAttribute("aria-label", model.pill.ariaLabel);
    this.pill.title = live === null ? model.caveat : live.caveat;
    this.dot.className = `dot${model.pill.verified ? " verified" : ""}${
      model.pill.pulsing ? " pulsing" : ""
    }`;
    // One bar in the pill at a time. While a reply writes, what it is writing
    // outranks how full the window is; the panel still carries both.
    this.renderPillMeter(live === null ? model.meter : null);
    this.renderPillLive(live);

    this.panel.replaceChildren();
    if (live !== null) this.panel.append(this.liveSection(live));
    if (model.band !== null) {
      this.panel.append(this.forecastSection(model));
      const context = this.contextSection(model);
      if (context !== null) this.panel.append(context);
    } else if (live === null) {
      this.panel.append(element("div", "note", model.emptyHint ?? STRINGS.emptyHint));
    }
    if (model.ledger !== null) this.panel.append(this.ledgerSection(model.ledger));
    if (model.band !== null || live !== null) this.panel.append(this.metaSection(model));
    this.announce(model);
    this.reposition();
  }

  /**
   * Tier 0, and only while it exists: what the reply has written so far
   * against the forecast that was frozen when it was sent.
   */
  private liveSection(live: LiveView): HTMLDivElement {
    const section = element("div", `section tone-${live.tone}`);
    const head = element("div", "head");
    head.append(element("span", "kicker", STRINGS.liveKicker));
    head.append(element("span", "head-value live-verdict", live.verdict));
    section.append(head);
    section.append(element("div", "headline", live.headline));
    section.append(this.bandChart(live.band, live.markerPercent));
    section.append(element("div", "note", live.detail));
    section.append(element("div", "faint", live.scaleNote));
    section.append(element("div", "faint", live.caveat));
    return section;
  }

  /** The conversation's running score, in the same shape as the live bar. */
  private ledgerSection(ledger: LedgerView): HTMLDivElement {
    const section = element("div", `section tone-${ledger.tone}`);
    const head = element("div", "head");
    head.append(element("span", "kicker", STRINGS.ledgerKicker));
    section.append(head);
    section.append(element("div", "note", ledger.headline));
    const bar = element("div", "ledger-bar");
    const fill = element("div", "ledger-fill");
    fill.style.width = `${ledger.fillPercent.toFixed(2)}%`;
    const p50 = element("div", "ledger-mark");
    p50.style.left = `${ledger.markP50Percent.toFixed(2)}%`;
    const p90 = element("div", "ledger-mark");
    p90.style.left = `${ledger.markP90Percent.toFixed(2)}%`;
    bar.append(fill, p50, p90);
    section.append(bar);
    const dots = element("div", "dots");
    dots.setAttribute("aria-hidden", "true");
    for (const dot of ledger.dots) {
      const node = element("i", `tone-${dot.tone}`);
      node.title = dot.title;
      dots.append(node);
    }
    section.append(element("div", "faint", ledger.foot), dots);
    section.append(element("div", "faint", ledger.note));
    return section;
  }

  /** The live bar inside the pill: the panel's band, shrunk to 44px. */
  private renderPillLive(live: LiveView | null): void {
    this.pillLive.hidden = live === null;
    if (live === null) return;
    this.pillLiveFill.style.width = `${live.markerPercent.toFixed(2)}%`;
    this.pillLiveP50.style.left = `${live.p50Percent.toFixed(2)}%`;
    this.pillLiveP90.style.left = `${live.p90Percent.toFixed(2)}%`;
  }

  /** Tier 1: the forecast, the only loud thing in the panel. */
  private forecastSection(model: ChipViewModel): HTMLDivElement {
    const section = element("div", "section");
    const head = element("div", "head");
    head.append(element("span", "kicker", STRINGS.forecastKicker));
    const count = element("span", "head-value");
    const dot = element("span", `dot${model.pill.verified ? " verified" : ""}`);
    count.append(dot, document.createTextNode(model.countLabel));
    count.title = model.countTitle;
    head.append(count);
    section.append(head);

    if (model.headline !== null) {
      const headline = element("div", "headline", model.headline);
      if (model.tuned) {
        headline.append(element("span", "badge", ` · ${STRINGS.tunedBadge}`));
      }
      section.append(headline);
    }
    if (model.band !== null) section.append(this.bandChart(model.band));
    if (model.pooledNote !== null) section.append(element("div", "faint", model.pooledNote));
    if (model.turnLine !== null) {
      const turn = element("div", "note", model.turnLine);
      // The long badge already sits on the headline; a second copy is noise.
      if (model.turnTuned) turn.append(element("span", "badge", ` · ${STRINGS.tunedBadgeShort}`));
      turn.style.marginTop = "6px";
      section.append(turn);
    }
    return section;
  }

  /**
   * The band. Opacity encodes probability mass, so the fade itself says "we
   * know less out here"; there is no needle, because there is no point
   * estimate to point at.
   */
  private bandChart(band: ForecastBand, markerPercent?: number): HTMLDivElement {
    const figure = element("div", "band");
    figure.setAttribute("role", "img");
    figure.setAttribute("aria-label", band.ariaLabel);
    figure.title = band.title;
    figure.style.position = "relative";
    const track = element("div", "band-track");
    for (const segment of band.segments) {
      const bar = element("div", "band-seg");
      bar.style.width = `calc(${segment.widthPercent.toFixed(2)}% - 2px)`;
      bar.style.opacity = String(segment.opacity);
      track.append(bar);
    }
    const ticks = element("div", "band-ticks");
    ticks.setAttribute("aria-hidden", "true");
    for (const tick of band.ticks) {
      const label = element("span", tick.anchor, tick.label);
      if (tick.anchor === "center") label.style.left = `${tick.percent.toFixed(2)}%`;
      ticks.append(label);
    }
    figure.append(track, ticks);
    if (markerPercent !== undefined) {
      const marker = element("div", "band-marker");
      marker.style.left = `${markerPercent.toFixed(2)}%`;
      figure.append(marker);
    }
    return figure;
  }

  /** Tier 2: how much of the window is already spoken for. */
  private contextSection(model: ChipViewModel): HTMLDivElement | null {
    const meter = model.meter;
    if (meter === null && model.warnings.length === 0) return null;
    const section = element("div", "section");
    if (meter !== null && meter.level !== "normal" && meter.level !== "informational") {
      section.style.setProperty("--warn-color", `var(--lvl-${meter.level})`);
    }
    if (meter !== null) {
      const head = element("div", "head");
      head.append(element("span", "kicker", STRINGS.contextKicker));
      head.append(element("span", "head-value", meter.caption));
      section.append(head, this.meterTrack(meter), element("div", "faint", meter.note));
    }
    for (const warning of model.warnings) {
      section.append(element("div", "warn", `⚠ ${warning}`));
    }
    return section;
  }

  /**
   * The panel's context meter, shrunk into the pill. It reads the same
   * `model.meter` the panel renders, so the collapsed and expanded views can
   * never disagree, and it updates on every recompute rather than only while
   * the panel is open.
   */
  private renderPillMeter(meter: ContextMeter | null): void {
    const show = meter !== null;
    this.pillMeter.hidden = !show;
    this.pillPct.hidden = !show;
    if (meter === null) return;
    this.pillMeter.className = `pill-meter${meter.over ? " over" : ""}`;
    this.pillMeter.style.setProperty("--fill", `var(--lvl-${meter.level})`);
    this.pillFill.className = `fill${meter.lowerBound ? " bounded" : ""}`;
    // No minimum width here, unlike the panel: a 36px track cannot hold a
    // legible sliver without overstating it by an order of magnitude, and the
    // percentage beside it already says "some, but under a percent".
    this.pillFill.style.width = `${meter.measuredPercent.toFixed(2)}%`;
    this.pillReserved.style.width = `${meter.reservedPercent.toFixed(2)}%`;
    // Whole percent: the pill has no room for a second digit, and the panel is
    // one click away for anyone who wants the real numbers.
    const used = Math.min(100, meter.measuredPercent + meter.reservedPercent);
    this.pillPct.textContent =
      used < 0.5 ? "<1%" : `${meter.lowerBound ? "≥" : ""}${Math.round(used)}%`;
  }

  /**
   * The measured fill fades out at its right edge on purpose: the number is a
   * lower bound, so it must not end in a confident edge.
   */
  private meterTrack(meter: ContextMeter): HTMLDivElement {
    const track = element("div", `meter-track${meter.over ? " over" : ""}`);
    track.setAttribute("role", "meter");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(meter.ariaValueMax));
    track.setAttribute("aria-valuenow", String(meter.ariaValueNow));
    track.setAttribute("aria-valuetext", meter.ariaValueText);
    track.style.setProperty("--fill", `var(--lvl-${meter.level})`);
    const fill = element("div", `meter-fill${meter.lowerBound ? " bounded" : ""}`);
    fill.style.width = `${Math.max(1, meter.measuredPercent).toFixed(2)}%`;
    const reserved = element("div", "meter-reserved");
    reserved.style.width = `${meter.reservedPercent.toFixed(2)}%`;
    track.append(fill, reserved);
    return track;
  }

  /** Tier 3: cost, provenance, caveat, controls. Deliberately quiet. */
  private metaSection(model: ChipViewModel): HTMLDivElement {
    const section = element("div", "section");
    if (model.cost !== null) {
      const row = element("div", "cost");
      row.append(element("span", "cost-label", STRINGS.costLabel));
      const value = element("span", "cost-value", model.cost.value);
      value.append(element("span", "unit", `· ${model.cost.note}`));
      value.title = model.cost.title;
      row.append(value);
      section.append(row);
    }
    const meta = element("div", "meta");
    model.meta.forEach((segment, index) => {
      if (index > 0) meta.append(document.createTextNode(" · "));
      const span = element("span", undefined, segment.text);
      if (segment.title !== undefined) span.title = segment.title;
      meta.append(span);
    });
    section.append(meta, element("div", "faint caveat", model.caveat));
    section.append(this.actions(model));
    return section;
  }

  private actions(model: ChipViewModel): HTMLDivElement {
    const actions = element("div", "actions");
    if (model.thinkingControl !== null) {
      actions.append(element("span", "actions-label", STRINGS.thinkingControlLabel));
      const group = element("span");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Extended thinking override");
      for (const value of ["on", "off"] as const) {
        const button = element("button", "seg", value);
        button.type = "button";
        button.setAttribute("aria-pressed", String(model.thinkingControl === value));
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onThinkingChange(value);
        });
        group.append(button);
      }
      actions.append(group);
    }
    const settings = element("button", "link", STRINGS.optionsLink);
    settings.type = "button";
    settings.addEventListener("click", (event) => {
      event.stopPropagation();
      this.callbacks.onOpenOptions();
    });
    actions.append(settings);
    return actions;
  }

  /**
   * Only discrete transitions are announced. A number that changes on every
   * keystroke is ambient state, not an event: a live region would queue a
   * stream of stale ranges over the user's own typing echo.
   */
  private announce(model: ChipViewModel): void {
    const turn = model.live;
    if (turn !== null) {
      // The band a running turn sits in is an event, not ambient state: it
      // changes a handful of times per reply and each change is the answer to
      // "is this going the way it was predicted?".
      if (turn.tone !== this.lastTone) {
        this.lastTone = turn.tone;
        if (turn.tone === "warn" || turn.tone === "bad") {
          this.live.textContent = `${turn.headline}, ${turn.verdict}.`;
        }
      }
      return;
    }
    this.lastTone = null;
    if (model.state !== "ready") return;
    if (model.pill.verified && !this.lastVerified) {
      this.live.textContent = `Draft count verified: ${model.countLabel}`;
    } else if (model.pill.level !== this.lastLevel && model.pill.level !== "normal") {
      this.live.textContent = `Context ${model.pill.level}: the reply may not fit the remaining context.`;
    }
    this.lastVerified = model.pill.verified;
    this.lastLevel = model.pill.level;
  }

  destroy(): void {
    document.removeEventListener("pointerdown", this.onOutsidePointer, true);
    window.removeEventListener("scroll", this.scheduleReposition, true);
    window.removeEventListener("resize", this.scheduleReposition);
    this.host.remove();
  }
}

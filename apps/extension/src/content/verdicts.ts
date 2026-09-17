/**
 * The verdict badges: one line per finished turn, pinned to the reply it
 * scored, answering "did this come out the way it was predicted?".
 *
 * Overlay, never an insertion. claude.ai owns its React tree and re-renders it
 * freely, so a node placed inside a message would be wiped, would fight the
 * app's layout, or both. Instead this is a second Shadow DOM layer of fixed
 * badges that follow their message's rectangle, exactly as the chip follows
 * the composer's. The cost is that the badges have to be re-placed on scroll;
 * the benefit is that nothing this extension does can disturb the page.
 *
 * Only turns this extension actually forecast get a badge. History that was on
 * screen before the extension loaded is not scored and is left alone, because
 * a verdict without a frozen prediction behind it would be invented.
 */
import { STRINGS } from "../lib/format.js";
import { verdictView, type TurnRecord } from "../lib/turn.js";

const HOST_ID = "token-forecaster-verdicts-host";
/** Below this much of the message on screen, the badge has nothing to label. */
const MIN_VISIBLE_PX = 24;
const GAP_PX = 4;

const STYLE = `
:host { all: initial; }
.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147482000;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.badge {
  position: fixed;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 60vw;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--edge);
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  --edge: rgba(0, 0, 0, 0.12);
  --surface: rgba(255, 255, 255, 0.92);
  --muted: #6b6a66;
  --tone: #6b6a66;
}
.layer.dark .badge {
  --edge: rgba(255, 255, 255, 0.16);
  --surface: rgba(38, 38, 36, 0.92);
  --muted: #a3a29c;
  --tone: #a3a29c;
}
.badge[hidden] { display: none; }
.badge:hover { border-color: var(--tone); }
.badge:focus-visible { outline: 2px solid var(--tone); outline-offset: 2px; }
.badge .icon { color: var(--tone); font-weight: 600; }
.badge.tone-good { --tone: #1a7f37; }
.badge.tone-ok { --tone: #6b6a66; }
.badge.tone-warn { --tone: #bc4c00; }
.badge.tone-bad { --tone: #cf222e; }
.badge.tone-off { opacity: 0.65; }
.layer.dark .badge.tone-good { --tone: #3fb950; }
.layer.dark .badge.tone-ok { --tone: #a3a29c; }
.layer.dark .badge.tone-warn { --tone: #f0883e; }
.layer.dark .badge.tone-bad { --tone: #e5534b; }
`;

export interface VerdictItem {
  record: TurnRecord;
  element: Element;
}

export interface PlacementLimits {
  /** Nothing is drawn below this y: the composer lives down there. */
  bottomLimit: number;
}

export class VerdictLayer {
  private readonly host: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly badges = new Map<number, HTMLButtonElement>();
  private items: VerdictItem[] = [];
  private limits: PlacementLimits = { bottomLimit: 0 };
  private visible = true;
  private frame = 0;

  constructor(private readonly onOpen: () => void) {
    document.getElementById(HOST_ID)?.remove();
    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    shadow.append(style, this.layer);
    document.body.append(this.host);
    window.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.style.display = visible ? "block" : "none";
  }

  setDark(dark: boolean): void {
    this.layer.className = `layer${dark ? " dark" : ""}`;
  }

  /** Replace the set of scored turns on screen. Idempotent per record id. */
  render(items: VerdictItem[], limits: PlacementLimits): void {
    this.items = items;
    this.limits = limits;
    const live = new Set(items.map((item) => item.record.id));
    for (const [id, badge] of this.badges) {
      if (live.has(id)) continue;
      badge.remove();
      this.badges.delete(id);
    }
    for (const item of items) {
      const view = verdictView(item.record);
      let badge = this.badges.get(item.record.id);
      if (badge === undefined) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.addEventListener("click", (event) => {
          event.stopPropagation();
          this.onOpen();
        });
        this.badges.set(item.record.id, badge);
        this.layer.append(badge);
      }
      badge.className = `badge tone-${view.tone}`;
      badge.title = `${view.title}\n\n${STRINGS.verdictOpen}`;
      badge.setAttribute("aria-label", `${view.ariaLabel} ${STRINGS.verdictOpen}`);
      badge.replaceChildren();
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = view.icon;
      const text = document.createElement("span");
      text.textContent = view.text;
      badge.append(icon, text);
    }
    this.place();
  }

  private readonly schedule = (): void => {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  };

  /**
   * Park each badge under the right edge of its message, clamped so it never
   * lands on the composer and never floats past the message it belongs to.
   */
  private place(): void {
    if (!this.visible) return;
    const limit = this.limits.bottomLimit > 0 ? this.limits.bottomLimit : window.innerHeight - 8;
    for (const item of this.items) {
      const badge = this.badges.get(item.record.id);
      if (badge === undefined) continue;
      if (!item.element.isConnected) {
        badge.hidden = true;
        continue;
      }
      const rect = item.element.getBoundingClientRect();
      const height = badge.offsetHeight || 19;
      const offScreen = rect.bottom < MIN_VISIBLE_PX || rect.top > limit - MIN_VISIBLE_PX;
      badge.hidden = offScreen;
      if (offScreen) continue;
      const top = Math.min(Math.max(rect.bottom + GAP_PX, MIN_VISIBLE_PX), limit - height);
      badge.style.top = `${Math.round(top)}px`;
      badge.style.right = `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`;
    }
  }

  destroy(): void {
    window.removeEventListener("scroll", this.schedule, true);
    window.removeEventListener("resize", this.schedule);
    this.host.remove();
  }
}

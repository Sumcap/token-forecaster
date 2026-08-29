import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chip } from "../src/content/chip.js";
import type { ChipViewModel, LedgerView, LiveView } from "../src/lib/engine.js";
import { STRINGS } from "../src/lib/format.js";

function model(overrides: Partial<ChipViewModel> = {}): ChipViewModel {
  return {
    state: "ready",
    pill: {
      text: "128 in · ~348–1.4k out",
      ariaLabel: "Token forecast. Draft 128 tokens, estimate. Reply forecast 348 to 1,400 tokens.",
      verified: false,
      pulsing: false,
      level: "normal",
    },
    countLabel: "128 in · estimate",
    countTitle: "Local estimate (character heuristic)",
    headline: "~348–1,400 tokens out",
    tuned: true,
    band: {
      segments: [
        { widthPercent: 28.8, opacity: 0.9 },
        { widthPercent: 28.9, opacity: 0.45 },
        { widthPercent: 42.3, opacity: 0.2 },
      ],
      ticks: [
        { percent: 28.8, label: "348", anchor: "center" },
        { percent: 57.7, label: "1.4k", anchor: "center" },
        { percent: 100, label: "4.2k", anchor: "end" },
      ],
      domain: 4_200,
      domainKind: "p99",
      ariaLabel: "Reply length forecast: p50 348 · p90 1,400 · p99 4,200 output tokens.",
      title: "p50 348 · p90 1,400 · p99 4,200 output tokens",
    },
    turnLine: "If this becomes a tool or research loop: ~4.3k–30k total",
    turnTuned: false,
    pooledNote: null,
    meter: {
      measuredPercent: 6.2,
      reservedPercent: 0.7,
      level: "normal",
      caption: "≥ 12,400 / 200k",
      note: STRINGS.contextLowerBound,
      lowerBound: true,
      over: false,
      ariaValueNow: 12_400,
      ariaValueMax: 200_000,
      ariaValueText: "at least 12,400 of 200,000 tokens, lower bound",
    },
    warnings: [],
    cost: { value: "$0.011–$0.043", note: STRINGS.costNoteShort, title: STRINGS.costNote },
    meta: [{ text: '<img src=x onerror="boom">' }, { text: STRINGS.thinkingAssumed("on") }],
    thinkingControl: "on",
    caveat: STRINGS.caveatCode,
    emptyHint: null,
    live: null,
    ledger: null,
    snapshot: null,
    ...overrides,
  };
}

let chip: Chip | null = null;
const callbacks = {
  onThinkingChange: vi.fn(),
  onExpandedChange: vi.fn(),
  onOpenOptions: vi.fn(),
};

function shadow(): ShadowRoot {
  const host = document.getElementById("token-forecaster-chip-host");
  if (host?.shadowRoot == null) throw new Error("the chip host has no shadow root");
  return host.shadowRoot;
}

const panelText = (): string => shadow().querySelector(".panel")?.textContent ?? "";

beforeEach(() => {
  document.body.innerHTML = `<div class="ProseMirror" contenteditable="true"></div>`;
  vi.clearAllMocks();
  chip = new Chip(callbacks);
  chip.attachTo(document.querySelector<HTMLElement>(".ProseMirror"));
});

afterEach(() => {
  chip?.destroy();
  chip = null;
  vi.unstubAllGlobals();
});

describe("Chip", () => {
  it("renders into a shadow root so the host page's styles cannot reach it", () => {
    chip!.render(model());
    expect(shadow().querySelector(".pill")?.textContent).toContain("128 in");
  });

  it("stays hidden until a composer is attached", () => {
    chip!.destroy();
    chip = new Chip(callbacks);
    const host = document.getElementById("token-forecaster-chip-host") as HTMLElement;
    expect(host.style.display).toBe("none");
    chip.attachTo(document.querySelector<HTMLElement>(".ProseMirror"));
    expect(host.style.display).toBe("block");
  });

  it("keeps the panel closed until the pill is clicked", () => {
    chip!.render(model());
    const panel = shadow().querySelector<HTMLElement>(".panel")!;
    expect(panel.hidden).toBe(true);
    expect(shadow().querySelector(".pill")!.getAttribute("aria-expanded")).toBe("false");
    shadow().querySelector<HTMLButtonElement>(".pill")!.click();
    expect(panel.hidden).toBe(false);
    expect(callbacks.onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("draws one segment per quantile band, widest last", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const segments = [...shadow().querySelectorAll<HTMLElement>(".band-seg")];
    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.style.opacity)).toEqual(["0.9", "0.45", "0.2"]);
    expect(segments[0]!.style.width).toContain("28.80%");
  });

  it("labels the band for a screen reader and for a pointer", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const band = shadow().querySelector(".band")!;
    expect(band.getAttribute("role")).toBe("img");
    expect(band.getAttribute("aria-label")).toContain("p99 4,200");
    expect(band.querySelector(".band-ticks")!.getAttribute("aria-hidden")).toBe("true");
    expect(band.querySelectorAll(".band-ticks span")).toHaveLength(3);
  });

  it("fades the context fill because the number is a lower bound", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const fill = shadow().querySelector<HTMLElement>(".meter-fill")!;
    expect(fill.classList.contains("bounded")).toBe(true);
    const track = shadow().querySelector(".meter-track")!;
    expect(track.getAttribute("role")).toBe("meter");
    expect(track.getAttribute("aria-valuetext")).toContain("lower bound");
  });

  it("does not fade the fill when the figure is not a lower bound", () => {
    chip!.setExpanded(true);
    chip!.render(
      model({
        meter: { ...model().meter!, lowerBound: false, note: STRINGS.contextDraftOnly },
      }),
    );
    expect(
      shadow().querySelector<HTMLElement>(".meter-fill")!.classList.contains("bounded"),
    ).toBe(false);
  });

  it("shows a warning with an icon and a word, never color alone", () => {
    chip!.setExpanded(true);
    chip!.render(model({ warnings: ["Reply at p90 may not fit"] }));
    expect(shadow().querySelector(".warn")?.textContent).toBe("⚠ Reply at p90 may not fit");
  });

  it("keeps the caveat and the cost note visible", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    expect(panelText()).toContain(STRINGS.caveatCode);
    expect(panelText()).toContain(STRINGS.costNoteShort);
  });

  it("treats page text as text, never as markup", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const panel = shadow().querySelector(".panel")!;
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.textContent).toContain("<img src=x onerror=");
  });

  it("draws the panel's context meter in the collapsed pill", () => {
    chip!.render(model());
    const meter = shadow().querySelector<HTMLElement>(".pill-meter")!;
    expect(meter.hidden).toBe(false);
    expect(meter.querySelector<HTMLElement>(".fill")!.style.width).toBe("6.20%");
    expect(meter.querySelector<HTMLElement>(".reserved")!.style.width).toBe("0.70%");
    // Lower bound, so the fill fades out and the readout says so.
    expect(meter.querySelector(".fill")!.className).toContain("bounded");
    expect(shadow().querySelector(".pill-pct")!.textContent).toBe("≥7%");

    // A 1M window makes a real conversation a fraction of a percent, and "0%"
    // would read as "nothing measured".
    chip!.render(model({ meter: { ...model().meter!, measuredPercent: 0.12, reservedPercent: 0.13 } }));
    expect(shadow().querySelector(".pill-pct")!.textContent).toBe("<1%");

    chip!.render(
      model({
        meter: {
          ...model().meter!,
          measuredPercent: 96,
          reservedPercent: 8,
          level: "overflow",
          lowerBound: false,
          over: true,
        },
      }),
    );
    const hot = shadow().querySelector<HTMLElement>(".pill-meter")!;
    expect(hot.className).toContain("over");
    expect(hot.style.getPropertyValue("--fill")).toBe("var(--lvl-overflow)");
    expect(shadow().querySelector(".pill-pct")!.textContent).toBe("100%");
  });

  it("hides the pill meter when there is no context to show", () => {
    chip!.render(model({ state: "empty", meter: null }));
    expect(shadow().querySelector<HTMLElement>(".pill-meter")!.hidden).toBe(true);
    expect(shadow().querySelector<HTMLElement>(".pill-pct")!.hidden).toBe(true);
  });

  it("offers the thinking override and shows which way it is set", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const buttons = [...shadow().querySelectorAll<HTMLButtonElement>(".seg")];
    expect(buttons.map((button) => button.textContent)).toEqual(["on", "off"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
    ]);
    buttons[1]!.click();
    expect(callbacks.onThinkingChange).toHaveBeenCalledWith("off");

    chip!.render(model({ thinkingControl: "off" }));
    expect(
      [...shadow().querySelectorAll(".seg")].map((button) => button.getAttribute("aria-pressed")),
    ).toEqual(["false", "true"]);

    chip!.render(model({ thinkingControl: null }));
    expect(shadow().querySelectorAll(".seg")).toHaveLength(0);
  });

  it("steps left of a decoration the page paints beside the composer", () => {
    const box = (left: number, top: number, width: number, height: number): DOMRect =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
      }) as DOMRect;

    document.body.innerHTML = `
      <div class="ProseMirror" contenteditable="true"></div>
      <div id="mascot"></div>
    `;
    const composer = document.querySelector<HTMLElement>(".ProseMirror")!;
    const mascot = document.querySelector<HTMLElement>("#mascot")!;
    composer.getBoundingClientRect = () => box(100, 700, 800, 80);
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);

    chip!.destroy();
    chip = new Chip(callbacks);
    shadow().querySelector<HTMLElement>(".pill")!.getBoundingClientRect = () => box(0, 0, 200, 24);
    const wrap = (): HTMLElement => shadow().querySelector<HTMLElement>(".wrap")!;

    // Nothing beside the composer: the pill sits one clearance in from its edge.
    mascot.getBoundingClientRect = () => box(0, 0, 0, 0);
    chip.attachTo(composer);
    expect(wrap().style.right).toBe("110px");

    // A 60px sprite overlapping the pill's row, at the composer's right corner.
    mascot.getBoundingClientRect = () => box(860, 660, 60, 40);
    chip.attachTo(composer);
    expect(wrap().style.right).toBe("150px");

    // Page furniture in the same row is not a decoration to dodge.
    mascot.getBoundingClientRect = () => box(860, 660, 60, 400);
    chip.attachTo(composer);
    expect(wrap().style.right).toBe("110px");

    // A decoration left of the pill cannot be dodged by moving left, so it is
    // not treated as one.
    mascot.getBoundingClientRect = () => box(120, 660, 60, 40);
    chip.attachTo(composer);
    expect(wrap().style.right).toBe("110px");

    // Dodging a decoration that would push a wide pill off screen is worse
    // than overlapping it, so the chip stays put.
    shadow().querySelector<HTMLElement>(".pill")!.getBoundingClientRect = () => box(0, 0, 800, 24);
    mascot.getBoundingClientRect = () => box(150, 660, 60, 40);
    chip.attachTo(composer);
    expect(wrap().style.right).toBe("110px");
  });

  it("caps the panel height so it can never run off the top of the viewport", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    const panel = shadow().querySelector<HTMLElement>(".panel")!;
    expect(panel.style.maxHeight).toMatch(/^\d+px$/);
    expect(Number.parseInt(panel.style.maxHeight, 10)).toBeLessThanOrEqual(300);
  });

  it("closes on Escape and on a click elsewhere in the page", () => {
    chip!.setExpanded(true);
    shadow()
      .querySelector(".wrap")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chip!.isExpanded()).toBe(false);

    chip!.setExpanded(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(chip!.isExpanded()).toBe(false);
  });

  it("announces only discrete transitions, not every keystroke", () => {
    chip!.render(model());
    const live = shadow().querySelector(".sr")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");

    chip!.render(model({ pill: { ...model().pill, verified: true } }));
    expect(live.textContent).toContain("verified");
  });

  it("shows the empty hint and nothing else for a blank draft", () => {
    chip!.setExpanded(true);
    chip!.render(
      model({ state: "empty", pill: { ...model().pill, text: STRINGS.emptyPill }, band: null, emptyHint: STRINGS.emptyHint }),
    );
    expect(panelText()).toBe(STRINGS.emptyHint);
    expect(shadow().querySelectorAll(".band-seg")).toHaveLength(0);
  });

  it("removes itself from the page on destroy", () => {
    chip!.destroy();
    chip = null;
    expect(document.getElementById("token-forecaster-chip-host")).toBeNull();
  });
});

function liveView(overrides: Partial<LiveView> = {}): LiveView {
  return {
    band: model().band!,
    markerPercent: 40,
    p50Percent: 28.8,
    p90Percent: 57.7,
    over: false,
    tone: "ok",
    pillText: "≈1.2k out · longer than typical, still normal",
    headline: "≈1.2k written of about 348 expected",
    verdict: "longer than typical, still normal",
    detail: "9 in 10 comparable turns finish under 1.4k",
    scaleNote: STRINGS.liveScaleTurn,
    ariaLabel: "Reply in progress. About 1,200 tokens written.",
    caveat: `${STRINGS.liveFrozen} ${STRINGS.liveEstimate}`,
    ...overrides,
  };
}

function ledgerView(overrides: Partial<LedgerView> = {}): LedgerView {
  return {
    headline: "12k written · 8k expected (150% of expected)",
    foot: "3 turns scored · 2/3 landed inside the usual range",
    note: STRINGS.ledgerNote,
    tone: "ok",
    fillPercent: 60,
    markP50Percent: 40,
    markP90Percent: 90,
    dots: [
      { tone: "good", title: "1,000 written · shorter than typical" },
      { tone: "warn", title: "9,000 written · unusually long" },
    ],
    ...overrides,
  };
}

/** happy-dom reports every rectangle as zero, so geometry has to be staged. */
function stubRect(element: Element, rect: Partial<DOMRect>): void {
  const full = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    ...rect,
  };
  element.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect;
}

/** The pill the engine hands over while a turn writes. */
function livePillModel(overrides: Partial<ChipViewModel> = {}): ChipViewModel {
  const live = liveView();
  return model({
    state: "live",
    pill: {
      text: live.pillText,
      ariaLabel: live.ariaLabel,
      verified: false,
      pulsing: true,
      level: "normal",
    },
    live,
    ...overrides,
  });
}

describe("Chip, while a reply is being written", () => {
  it("replaces the draft range with what the reply has written", () => {
    chip!.render(livePillModel());
    const pill = shadow().querySelector<HTMLElement>(".pill")!;
    expect(pill.textContent).toContain("≈1.2k out");
    expect(pill.className).toContain("live");
    expect(pill.className).toContain("tone-ok");
    // The dot pulses because the turn really is in flight.
    expect(shadow().querySelector(".pill .dot")!.className).toContain("pulsing");
  });

  it("shows the live bar in the pill and hides the context bar behind it", () => {
    chip!.render(model({ live: liveView() }));
    const live = shadow().querySelector<HTMLElement>(".pill-live")!;
    expect(live.hidden).toBe(false);
    expect(live.querySelector<HTMLElement>(".fill")!.style.width).toBe("40.00%");
    expect(shadow().querySelector<HTMLElement>(".pill-meter")!.hidden).toBe(true);
  });

  it("marks the written estimate on the very band the panel already teaches", () => {
    chip!.setExpanded(true);
    chip!.render(model({ live: liveView() }));
    const marker = shadow().querySelector<HTMLElement>(".band-marker")!;
    expect(marker.style.left).toBe("40.00%");
    const panel = panelText();
    expect(panel).toContain(STRINGS.liveKicker);
    expect(panel).toContain("≈1.2k written of about 348 expected");
    expect(panel).toContain(STRINGS.liveScaleTurn);
    // The two contracts have to be on screen, not only in the code.
    expect(panel).toContain(STRINGS.liveFrozen);
    expect(panel).toContain(STRINGS.liveEstimate);
  });

  it("keeps the draft forecast one scroll below the live section", () => {
    chip!.setExpanded(true);
    chip!.render(model({ live: liveView() }));
    const kickers = [...shadow().querySelectorAll(".kicker")].map((node) => node.textContent);
    expect(kickers[0]).toBe(STRINGS.liveKicker);
    expect(kickers).toContain(STRINGS.forecastKicker);
  });

  it("still renders with an empty composer, which is the normal case", () => {
    chip!.setExpanded(true);
    chip!.render(
      model({
        state: "live",
        band: null,
        headline: null,
        meter: null,
        cost: null,
        meta: [],
        emptyHint: null,
        live: liveView(),
      }),
    );
    expect(panelText()).toContain(STRINGS.liveKicker);
    expect(panelText()).not.toContain(STRINGS.emptyHint);
    // The options link survives, so there is always a way out of the chip.
    expect(shadow().querySelector(".actions button.link")).not.toBeNull();
  });

  it("announces a turn that runs long, and stays quiet while it does not", () => {
    const region = (): string => shadow().querySelector(".sr")?.textContent ?? "";
    chip!.render(model({ live: liveView() }));
    expect(region()).toBe("");
    chip!.render(model({ live: liveView({ tone: "bad", verdict: "far longer than predicted" }) }));
    expect(region()).toContain("far longer than predicted");
  });

  it("walks to the reply being written, and never crosses the composer", () => {
    const composer = document.querySelector<HTMLElement>(".ProseMirror")!;
    stubRect(composer, { top: 600, bottom: 700, left: 200, right: 800, width: 600, height: 100 });
    const message = document.createElement("div");
    document.body.append(message);
    stubRect(message, { top: 100, bottom: 300, left: 200, right: 800, width: 600, height: 200 });
    chip!.render(model({ live: liveView() }));
    stubRect(shadow().querySelector(".pill")!, { width: 120, height: 24 });

    chip!.setLiveAnchor(message);
    const wrap = shadow().querySelector<HTMLElement>(".wrap")!;
    // Level with the last line written, in the gutter beside the message.
    expect(wrap.style.bottom).toBe("468px");
    expect(wrap.style.right).toBe("94px");

    // Once the reply reaches the composer, the chip parks above it again.
    stubRect(message, { top: 100, bottom: 700, left: 200, right: 800, width: 600, height: 600 });
    chip!.reposition();
    expect(wrap.style.bottom).toBe("176px");
  });

  it("stays put when there is no gutter to stand in", () => {
    const composer = document.querySelector<HTMLElement>(".ProseMirror")!;
    stubRect(composer, { top: 600, bottom: 700, left: 0, right: 1_020, width: 1_020, height: 100 });
    const message = document.createElement("div");
    document.body.append(message);
    stubRect(message, { top: 100, bottom: 300, left: 0, right: 1_020, width: 1_020, height: 200 });
    chip!.render(model({ live: liveView() }));
    stubRect(shadow().querySelector(".pill")!, { width: 120, height: 24 });
    chip!.setLiveAnchor(message);
    expect(shadow().querySelector<HTMLElement>(".wrap")!.style.bottom).toBe("176px");
  });
});

describe("Chip, the conversation's running score", () => {
  it("draws the ledger with a bar, a foot count, and one dot per turn", () => {
    chip!.setExpanded(true);
    chip!.render(model({ ledger: ledgerView() }));
    expect(panelText()).toContain(STRINGS.ledgerKicker);
    expect(panelText()).toContain("150% of expected");
    expect(panelText()).toContain("2/3 landed inside the usual range");
    expect(shadow().querySelectorAll(".dots i")).toHaveLength(2);
    expect(shadow().querySelector<HTMLElement>(".ledger-fill")!.style.width).toBe("60.00%");
    expect(shadow().querySelectorAll<HTMLElement>(".ledger-mark")[1]!.style.left).toBe("90.00%");
  });

  it("says nothing at all until a turn has been scored", () => {
    chip!.setExpanded(true);
    chip!.render(model());
    expect(panelText()).not.toContain(STRINGS.ledgerKicker);
  });
});

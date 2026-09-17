import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictLayer, type VerdictItem } from "../src/content/verdicts.js";
import { bandOf, scoringScale, type ForecastSnapshot, type TurnRecord } from "../src/lib/turn.js";

const SNAPSHOT: ForecastSnapshot = {
  call: { p50: 300, p90: 1_200, p99: 4_000 },
  turn: { p50: 4_000, p90: 30_000, p99: 90_000 },
  callTuned: false,
  turnTuned: false,
  modelId: "claude-opus-5",
  modelName: "Claude Opus 5",
  maxOutputTokens: 64_000,
  thinkingEnabled: true,
  pooled: false,
  sampleSize: 1_200,
  profileScope: "claude-code",
  surface: "code",
};

function record(id: number, outTokens: number): TurnRecord {
  const scale = scoringScale(SNAPSHOT);
  return {
    id,
    snapshot: SNAPSHOT,
    scale,
    outTokens,
    band: bandOf(outTokens, scale.quantiles),
    abandoned: false,
    startedAt: 0,
    settledAt: 1,
  };
}

/** happy-dom reports every rectangle as zero, so geometry has to be staged. */
function message(rect: Partial<DOMRect>): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);
  const full = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
  node.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect;
  return node;
}

function badges(): HTMLElement[] {
  const host = document.getElementById("token-forecaster-verdicts-host");
  return [...(host?.shadowRoot?.querySelectorAll<HTMLElement>(".badge") ?? [])];
}

let layer: VerdictLayer | null = null;
const onOpen = vi.fn();

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  layer = new VerdictLayer(onOpen);
});

afterEach(() => {
  layer?.destroy();
  layer = null;
});

describe("VerdictLayer", () => {
  it("pins one badge under the reply it scored", () => {
    const item: VerdictItem = {
      record: record(1, 2_000),
      element: message({ top: 100, bottom: 300, right: 800, width: 600, height: 200 }),
    };
    layer!.render([item], { bottomLimit: 600 });
    const [badge] = badges();
    expect(badge!.textContent).toContain("2k written");
    expect(badge!.textContent).toContain("shorter than typical");
    expect(badge!.className).toContain("tone-good");
    expect(badge!.style.top).toBe("304px");
    expect(badge!.style.right).toBe("224px");
    expect(badge!.hidden).toBe(false);
  });

  it("never writes into the page it is describing", () => {
    const element = message({ top: 100, bottom: 300, right: 800 });
    layer!.render([{ record: record(1, 2_000), element }], { bottomLimit: 600 });
    expect(element.childNodes).toHaveLength(0);
    // Everything the layer draws lives in its own shadow root.
    expect(document.body.querySelector(".badge")).toBeNull();
  });

  it("carries the prediction in the tooltip, so the verdict can be checked", () => {
    const element = message({ top: 100, bottom: 300, right: 800 });
    layer!.render([{ record: record(1, 40_000), element }], { bottomLimit: 600 });
    const [badge] = badges();
    expect(badge!.className).toContain("tone-warn");
    expect(badge!.title).toContain("30,000");
    expect(badge!.title).toContain("whole turn");
  });

  it("keeps out of the composer's way", () => {
    const element = message({ top: 400, bottom: 590, right: 800 });
    layer!.render([{ record: record(1, 2_000), element }], { bottomLimit: 600 });
    // 590 + 4 would land on the composer, so the badge stops short of the limit.
    expect(badges()[0]!.style.top).toBe("581px");
  });

  it("hides a badge whose reply has scrolled out of view", () => {
    const above = message({ top: -400, bottom: 10, right: 800 });
    const below = message({ top: 650, bottom: 900, right: 800 });
    layer!.render(
      [
        { record: record(1, 2_000), element: above },
        { record: record(2, 2_000), element: below },
      ],
      { bottomLimit: 600 },
    );
    expect(badges().map((badge) => badge.hidden)).toEqual([true, true]);
  });

  it("drops a badge whose message left the page", () => {
    const element = message({ top: 100, bottom: 300, right: 800 });
    layer!.render([{ record: record(1, 2_000), element }], { bottomLimit: 600 });
    expect(badges()).toHaveLength(1);
    layer!.render([], { bottomLimit: 600 });
    expect(badges()).toHaveLength(0);
  });

  it("opens the panel when a badge is clicked", () => {
    const element = message({ top: 100, bottom: 300, right: 800 });
    layer!.render([{ record: record(1, 2_000), element }], { bottomLimit: 600 });
    badges()[0]!.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("can be turned off without being torn down", () => {
    const element = message({ top: 100, bottom: 300, right: 800 });
    layer!.render([{ record: record(1, 2_000), element }], { bottomLimit: 600 });
    layer!.setVisible(false);
    const host = document.getElementById("token-forecaster-verdicts-host") as HTMLElement;
    expect(host.style.display).toBe("none");
  });
});

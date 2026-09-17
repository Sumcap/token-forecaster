/**
 * Render the chip in a headless DOM and write a flat HTML file, so the design
 * can be looked at with any renderer (no scripting required).
 *
 * Development tool only. Nothing in the extension imports it.
 */
import { Chip } from "../content/chip.js";
import { buildViewModel, type EngineInput } from "../lib/engine.js";
import type { ResolvedModel } from "../lib/model-map.js";
import type { ResolvedThinking } from "../lib/thinking.js";
import { bandOf, scoringScale, type ForecastSnapshot, type TurnRecord } from "../lib/turn.js";

const MODEL: ResolvedModel = { id: "claude-opus-5", resolution: "page", pageLabel: "Opus 5" };
const THINKING: ResolvedThinking = { enabled: true, source: "page", pageLabel: "High" };

/** A forecast frozen at send, which is what a running turn is scored against. */
const FROZEN: ForecastSnapshot = {
  call: { p50: 348, p90: 1_400, p99: 4_200 },
  turn: { p50: 4_300, p90: 30_000, p99: 90_000 },
  callTuned: true,
  turnTuned: true,
  modelId: "claude-opus-5",
  modelName: "Claude Opus 5",
  maxOutputTokens: 64_000,
  thinkingEnabled: true,
  pooled: false,
  sampleSize: 1_200,
  profileScope: "claude-code",
  surface: "code",
};

function scored(id: number, outTokens: number): TurnRecord {
  const scale = scoringScale(FROZEN);
  return {
    id,
    snapshot: FROZEN,
    scale,
    outTokens,
    band: bandOf(outTokens, scale.quantiles),
    abandoned: false,
    startedAt: 0,
    settledAt: 1,
  };
}

export const CASES: Array<{ title: string; input: Partial<EngineInput> }> = [
  {
    title: "A reply being written, on track",
    input: { draft: "", live: { snapshot: FROZEN, outTokens: 2_100 } },
  },
  {
    title: "A reply past the predicted range, two turns already scored",
    input: {
      draft: "",
      live: { snapshot: FROZEN, outTokens: 41_000 },
      ledger: [scored(1, 2_100), scored(2, 12_000)],
    },
  },
  {
    title: "Between turns, with the conversation's score so far",
    input: {
      draft: "and now the next question",
      inputTokens: 9,
      ledger: [scored(1, 2_100), scored(2, 12_000), scored(3, 41_000)],
    },
  },
  { title: "Short draft", input: { draft: "hello does this work?", inputTokens: 6 } },
  {
    title: "Long draft naming a path, conversation measured",
    input: {
      draft:
        "Read packages/predictor/src/historical.ts and write a design document that compares every backoff rung, with a table of the sample sizes.",
      inputTokens: 128,
      transcriptTokens: 12_400,
    },
  },
  {
    title: "Verified count, thinking assumed",
    input: {
      draft: "summarise the last three messages",
      inputTokens: 41,
      inputQuality: "anthropic_verified",
      verifyState: "done",
      thinking: { enabled: true, source: "assumed", pageLabel: null },
    },
  },
  { title: "Context nearly full", input: { draft: "keep going", inputTokens: 12, transcriptTokens: 960_000 } },
  { title: "Chat surface (out of domain)", input: { draft: "what is a token?", inputTokens: 9, surface: "chat" } },
];

export function baseInput(): EngineInput {
  return {
    draft: "",
    inputTokens: 0,
    inputQuality: "character_heuristic",
    verifyState: "off",
    verifyError: null,
    model: MODEL,
    thinking: THINKING,
    surface: "code",
    sessionPosition: 3,
    hasImage: false,
    transcriptTokens: null,
  };
}

/** Render one case and return the chip's shadow markup. */
export function renderCase(input: Partial<EngineInput>): string {
  const composer = document.createElement("div");
  composer.className = "composer";
  document.body.append(composer);
  const chip = new Chip(
    {
      onThinkingChange: () => undefined,
      onExpandedChange: () => undefined,
      onOpenOptions: () => undefined,
    },
    { expanded: true },
  );
  chip.attachTo(composer);
  chip.render(buildViewModel({ ...baseInput(), ...input }));
  const host = document.getElementById("token-forecaster-chip-host");
  const markup = host?.shadowRoot?.innerHTML ?? "";
  chip.destroy();
  composer.remove();
  return markup;
}

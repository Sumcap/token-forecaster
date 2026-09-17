/**
 * A standalone preview of the chip, for looking at the design without loading
 * the extension. Open `dist/preview.html` in a browser.
 *
 * It renders the real `Chip` against real engine output, so what you see is
 * what claude.ai gets.
 */
import { buildViewModel, type EngineInput } from "../lib/engine.js";
import type { ForecastSnapshot, TurnRecord } from "../lib/turn.js";
import { bandOf, scoringScale } from "../lib/turn.js";
import type { ResolvedModel } from "../lib/model-map.js";
import type { ResolvedThinking } from "../lib/thinking.js";
import { Chip } from "../content/chip.js";

const MODEL: ResolvedModel = {
  id: "claude-opus-5",
  resolution: "page",
  pageLabel: "Opus 5",
};

const THINKING: ResolvedThinking = { enabled: true, source: "page", pageLabel: "High" };

/** A forecast frozen at send, as the running turn is scored against. */
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

const LEDGER = [scored(1, 2_100), scored(2, 12_000), scored(3, 41_000)];

const CASES: Array<{ title: string; input: Partial<EngineInput> }> = [
  {
    title: "A reply being written, on track",
    input: { draft: "", live: { snapshot: FROZEN, outTokens: 2_100 } },
  },
  {
    title: "A reply running past the predicted range",
    input: {
      draft: "",
      live: { snapshot: FROZEN, outTokens: 41_000 },
      ledger: LEDGER.slice(0, 2),
    },
  },
  {
    title: "Between turns, with the conversation scored so far",
    input: { draft: "and now the next question", inputTokens: 9, ledger: LEDGER },
  },
  { title: "Short draft, nothing measured yet", input: { draft: "hello does this work?", inputTokens: 6 } },
  {
    title: "Long draft that names a path, conversation measured",
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
  {
    title: "Context nearly full",
    input: {
      draft: "keep going",
      inputTokens: 12,
      transcriptTokens: 960_000,
    },
  },
  { title: "Empty composer", input: { draft: "", inputTokens: 0 } },
];

function baseInput(): EngineInput {
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

const root = document.getElementById("cases");
for (const testCase of CASES) {
  const frame = document.createElement("section");
  frame.className = "case";
  const heading = document.createElement("h2");
  heading.textContent = testCase.title;
  const stage = document.createElement("div");
  stage.className = "stage";
  const composer = document.createElement("div");
  composer.className = "composer";
  composer.textContent = testCase.input.draft ?? "";
  stage.append(composer);
  frame.append(heading, stage);
  root?.append(frame);

  const chip = new Chip(
    {
      onThinkingChange: () => undefined,
      onExpandedChange: () => undefined,
      onOpenOptions: () => undefined,
    },
    { expanded: true },
  );
  // The preview stacks several chips, so each one lives inside its own stage
  // rather than floating over the whole document.
  const host = document.getElementById("token-forecaster-chip-host");
  if (host !== null) {
    host.id = "";
    host.style.position = "absolute";
    stage.append(host);
  }
  chip.attachTo(composer);
  chip.render(buildViewModel({ ...baseInput(), ...testCase.input }));
}

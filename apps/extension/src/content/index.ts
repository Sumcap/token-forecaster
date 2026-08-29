/**
 * Content-script entry point: bind the composer, run the engine, draw the chip.
 *
 * The forecast runs entirely in this script, including the bundled profile, so
 * typing never wakes the service worker and the extension works with no
 * network at all. The worker owns the optional Anthropic count and the
 * separately consented telemetry queue; neither is needed for a forecast.
 */
import {
  CountReconciler,
  debounced,
  estimateTokensFromText,
  type DisplayedCount,
} from "@token-forecaster/token-counter";
import { buildViewModel, type EngineInput, type VerifyState } from "../lib/engine.js";
import {
  COUNT_TOKENS,
  OPEN_OPTIONS,
  QUEUE_TELEMETRY,
  type CountTokensRequest,
  type CountTokensResponse,
  type QueueTelemetryRequest,
} from "../lib/messages.js";
import { resolveModel } from "../lib/model-map.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  subscribeSettings,
  type TfSettings,
} from "../lib/settings.js";
import { surfaceFromPath, type Surface } from "../lib/surface.js";
import { detectDarkPage } from "../lib/theme.js";
import { resolveThinking } from "../lib/thinking.js";
import type { ForecastSnapshot } from "../lib/turn.js";
import { diagnosticEvent, researchEventFromTurn } from "../lib/telemetry-events.js";
import { watchComposer } from "./anchor.js";
import { Chip } from "./chip.js";
import { TurnTracker } from "./turn-tracker.js";
import { VerdictLayer } from "./verdicts.js";
import {
  countAssistantMessages,
  findEffortLabel,
  findThinkingEvidence,
  findModelLabel,
  hasImageAttachment,
  readTranscript,
  textFromEditable,
} from "./extract.js";

const LOCAL_DEBOUNCE_MS = 120;
const VERIFY_DEBOUNCE_MS = 750;
const PAGE_READ_THROTTLE_MS = 1_000;
/** How often the page is asked whether a reply is being written. */
const TICK_IDLE_MS = 1_000;
/** While one is, fast enough to look live without redrawing every frame. */
const TICK_ACTIVE_MS = 300;
/** Every control that sends the composer, so a click is armed like Enter. */
const SEND_BUTTON =
  '[data-testid="send-button"], button[aria-label*="send message" i], button[aria-label*="send" i]';

let settings: TfSettings = { ...DEFAULT_SETTINGS };
let composer: HTMLElement | null = null;
let draft = "";
let modelLabel: string | null = null;
let effortLabel: string | null = null;
/** Thinking blocks in the newest reply: true, false, or null for "no reply". */
let thinkingInLastReply: boolean | null = null;
let surface: Surface = surfaceFromPath(location.pathname);
let hasImage = false;
let sessionPosition = 0;
let transcriptTokens: number | null = null;
let verifyState: VerifyState = "off";
let verifyError: string | null = null;
let lastPageRead = 0;
/**
 * The forecast for the last non-empty draft, which is the one that gets frozen
 * when the draft is sent. Kept here rather than in the tracker because it is a
 * property of the composer, not of a turn.
 */
let lastSnapshot: ForecastSnapshot | null = null;
let tickTimer = 0;
const extensionVersion = chrome.runtime.getManifest?.().version ?? "development";
let telemetrySessionId = crypto.randomUUID();
let telemetryConversation = location.pathname;
let readyReported = false;
let forecastReported = false;

const reconciler = new CountReconciler();
let displayed: DisplayedCount = reconciler.current;
let requestId = 0;

const tracker = new TurnTracker(() => render(), {
  lastSnapshot: () => lastSnapshot,
  onSettled: (record) => {
    if (settings.diagnosticsConsent === "granted") {
      queueTelemetry(
        diagnosticEvent({
          extensionVersion,
          name: "turn_scored",
          surface,
          outcome: record.abandoned ? "degraded" : "success",
          code: record.abandoned ? "abandoned" : "ok",
        }),
      );
    }
    if (settings.researchConsent === "granted") {
      const event = researchEventFromTurn({ extensionVersion, sessionId: telemetrySessionId, record });
      if (event !== null) queueTelemetry(event);
    }
  },
});

function queueTelemetry(event: QueueTelemetryRequest["event"]): void {
  const request: QueueTelemetryRequest = { type: QUEUE_TELEMETRY, event };
  void chrome.runtime.sendMessage(request).catch(() => undefined);
}

function setConversation(key: string): void {
  if (telemetryConversation !== key) {
    telemetryConversation = key;
    telemetrySessionId = crypto.randomUUID();
    forecastReported = false;
  }
  tracker.setConversation(key);
}

function maybeReportReady(): void {
  if (
    readyReported ||
    composer === null ||
    !settings.chipEnabled ||
    !surfaceAllowed() ||
    settings.diagnosticsConsent !== "granted"
  ) return;
  readyReported = true;
  queueTelemetry(
    diagnosticEvent({
      extensionVersion,
      name: "extension_ready",
      surface,
      outcome: "success",
      code: "ok",
    }),
  );
}

const verdicts = new VerdictLayer(() => {
  chip.setExpanded(true);
  render();
});

const chip = new Chip({
  onThinkingChange(next: "on" | "off") {
    void saveSettings({ thinking: next });
  },
  onExpandedChange(expanded: boolean) {
    if (expanded) readPage(true);
    render();
  },
  onOpenOptions() {
    void chrome.runtime.sendMessage({ type: OPEN_OPTIONS }).catch(() => undefined);
  },
});

/** True once Chrome has torn this content script's extension context down. */
function contextGone(): boolean {
  return chrome.runtime.id === undefined;
}

/** The chip belongs on the surface the profile describes, and nowhere else. */
function surfaceAllowed(): boolean {
  return surface === "code" || settings.showInChat;
}

/**
 * Re-read the route and apply visibility. Cheap enough to run on every
 * recompute, which is what makes an SPA navigation take effect immediately
 * rather than at the next throttled page read.
 */
function refreshSurface(): void {
  surface = surfaceFromPath(location.pathname);
  chip.setVisible(settings.chipEnabled && surfaceAllowed());
}

function render(): void {
  const model = resolveModel(settings.modelOverride, modelLabel);
  const input: EngineInput = {
    draft,
    inputTokens: displayed.tokens,
    inputQuality: displayed.quality,
    verifyState,
    verifyError,
    model,
    thinking: resolveThinking(settings.thinking, {
      pageLabel: effortLabel,
      transcript: thinkingInLastReply,
    }),
    surface,
    sessionPosition,
    hasImage,
    transcriptTokens,
    live: tracking() ? tracker.live() : null,
    ledger: tracking() ? tracker.ledger() : [],
  };
  const view = buildViewModel(input);
  // Only a real draft produces a snapshot, so this holds the last thing that
  // could have been sent right up to the moment it is.
  if (view.snapshot !== null) lastSnapshot = view.snapshot;
  if (
    view.snapshot !== null &&
    !forecastReported &&
    settings.chipEnabled &&
    surfaceAllowed() &&
    settings.diagnosticsConsent === "granted"
  ) {
    forecastReported = true;
    const code = view.snapshot.pooled
      ? "pooled_forecast"
      : model.resolution === "assumed"
        ? "model_assumed"
        : input.thinking.source === "assumed"
          ? "thinking_assumed"
          : "ok";
    queueTelemetry(
      diagnosticEvent({
        extensionVersion,
        name: "forecast_rendered",
        surface,
        outcome: code === "ok" ? "success" : "degraded",
        code,
      }),
    );
  }
  chip.render(view);
  chip.setLiveAnchor(tracking() ? (tracker.liveElement() as HTMLElement | null) : null);
  renderVerdicts();
}

/** The whole live half of the feature, on this surface, with the chip on. */
function tracking(): boolean {
  return settings.chipEnabled && settings.liveTrackingEnabled && surfaceAllowed();
}

/**
 * The scores pinned to finished replies. They are placed against the
 * composer's top edge, so the layer never has to guess where the page furniture
 * starts.
 */
function renderVerdicts(): void {
  const show = tracking() && settings.verdictsEnabled;
  verdicts.setVisible(show);
  if (!show) return;
  verdicts.setDark(detectDarkPage());
  const bottomLimit =
    composer === null
      ? window.innerHeight - 8
      : composer.getBoundingClientRect().top - 6;
  verdicts.render(tracker.settled(), { bottomLimit });
}

/**
 * The draft is on its way. Freeze the forecast before the reply exists: a
 * prediction made after the fact is not a prediction.
 */
function armTurn(): void {
  if (!tracking() || draft.trim().length === 0) return;
  setConversation(location.pathname);
  tracker.arm(lastSnapshot);
  scheduleTick();
}

/**
 * One observation per beat: fast while a reply writes, once a second when
 * nothing is happening. An interval rather than a MutationObserver on the
 * transcript, because a streaming reply mutates continuously and the chip only
 * needs to redraw a few times a second.
 */
function tickTurn(): void {
  if (!tracking()) return;
  setConversation(location.pathname);
  tracker.tick();
  // The message grows without firing scroll or resize, so the walk to the
  // writing edge has to be driven from here.
  if (tracker.isBusy()) {
    chip.reposition();
    renderVerdicts();
  }
}

function scheduleTick(): void {
  clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    tickTurn();
    scheduleTick();
  }, tracker.isBusy() ? TICK_ACTIVE_MS : TICK_IDLE_MS) as unknown as number;
}

/**
 * Read the page state around the composer. The transcript scan is the only
 * expensive part; it is throttled rather than gated on the panel, because the
 * pill now draws the context meter and a bar that only becomes true once the
 * panel is opened is worse than no bar at all.
 */
function readPage(force = false): void {
  const now = Date.now();
  if (!force && now - lastPageRead < PAGE_READ_THROTTLE_MS) return;
  lastPageRead = now;
  modelLabel = findModelLabel();
  effortLabel = findEffortLabel();
  thinkingInLastReply = findThinkingEvidence();
  hasImage = hasImageAttachment();
  sessionPosition = countAssistantMessages();
  if (settings.transcriptGaugeEnabled) {
    const reading = readTranscript();
    transcriptTokens = reading.messages === 0 ? null : reading.tokens;
  } else {
    transcriptTokens = null;
  }
}

const verify = debounced(() => {
  if (contextGone() || !settings.verifyEnabled || draft.trim().length === 0) {
    verifyState = "off";
    render();
    return;
  }
  const ticket = reconciler.startVerification();
  const model = resolveModel(settings.modelOverride, modelLabel);
  verifyState = "verifying";
  render();
  const message: CountTokensRequest = {
    type: COUNT_TOKENS,
    requestId: ++requestId,
    model: model.id,
    text: draft,
  };
  chrome.runtime
    .sendMessage<CountTokensRequest, CountTokensResponse>(message)
    .then((response) => {
      if (response.ok) {
        const next = reconciler.resolveVerification(ticket, response.tokens);
        if (next === null) return;
        displayed = { ...next };
        verifyError = null;
        verifyState = "done";
        render();
        return;
      }
      if (reconciler.failVerification(ticket)) {
        verifyError = response.error;
        verifyState = "off";
        render();
      }
    })
    .catch((error: unknown) => {
      if (!reconciler.failVerification(ticket)) return;
      verifyError = error instanceof Error ? error.message : String(error);
      verifyState = "off";
      render();
    });
}, VERIFY_DEBOUNCE_MS);

const recompute = debounced(() => {
  if (composer === null) return;
  refreshSurface();
  draft = textFromEditable(composer);
  displayed = { ...reconciler.noteInputChanged(estimateTokensFromText(draft)) };
  readPage();
  if (settings.verifyEnabled && draft.trim().length > 0) {
    verifyState = "waiting";
    verifyError = null;
    verify.call();
  } else {
    verify.cancel();
    verifyState = "off";
  }
  render();
}, LOCAL_DEBOUNCE_MS);

// One document-level listener instead of one per composer: ProseMirror
// replaces nodes inside the editor freely, and an `input` event from any of
// them bubbles to here.
document.addEventListener(
  "input",
  (event) => {
    const target = event.target;
    if (composer === null || !(target instanceof Node)) return;
    if (target !== composer && !composer.contains(target)) return;
    recompute.call();
  },
  true,
);

// Sending clears the composer without an `input` event in some builds.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const target = event.target;
    if (composer !== null && target instanceof Node && composer.contains(target)) armTurn();
    setTimeout(() => recompute.call(), 50);
  },
  true,
);

// The send button is the other way out of the composer. `pointerdown` rather
// than `click`, so the forecast is frozen before claude.ai has begun the turn.
document.addEventListener(
  "pointerdown",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(SEND_BUTTON) === null) return;
    armTurn();
  },
  true,
);

const watcher = watchComposer((next) => {
  composer = next;
  chip.attachTo(next);
  refreshSurface();
  if (next === null) return;
  maybeReportReady();
  readPage(true);
  recompute.call();
});

subscribeSettings((next) => {
  settings = next;
  refreshSurface();
  scheduleTick();
  if (!settings.verifyEnabled) {
    verify.cancel();
    verifyState = "off";
    verifyError = null;
  }
  readPage(true);
  maybeReportReady();
  render();
});

void loadSettings().then((loaded) => {
  settings = loaded;
  refreshSurface();
  chip.setExpanded(settings.startExpanded);
  readPage(true);
  setConversation(location.pathname);
  maybeReportReady();
  recompute.call();
  render();
  scheduleTick();
});

window.addEventListener("pagehide", () => {
  watcher.stop();
  verify.cancel();
  recompute.cancel();
  clearTimeout(tickTimer);
  verdicts.destroy();
  chip.destroy();
});

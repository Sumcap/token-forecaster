/**
 * Watching one turn from send to settled.
 *
 * The page never tells us how many tokens a reply cost, so this measures the
 * only thing it can: the text of every assistant message that appeared AFTER
 * the send. Messages present at send are held in a WeakSet, which makes the
 * measurement immune to claude.ai unmounting old messages as the transcript
 * grows; a running total over the whole transcript would shrink when that
 * happens and read as the reply getting shorter.
 *
 * The state machine has three phases and one rule: nothing is scored unless a
 * forecast was frozen before the reply existed.
 *
 *   idle  --arm(snapshot)-->  armed  --text appears-->  running  --quiet-->  idle
 *
 * `armed` exists because the reply does not start instantly: without it, the
 * gap between pressing Enter and the first token would settle the turn as
 * "wrote nothing".
 */
import { estimateTokensFromText } from "@token-forecaster/token-counter";
import { bandOf, scoringScale, type ForecastSnapshot, type TurnRecord } from "../lib/turn.js";
import { findAssistantMessages, isGenerating, tokensOfMessages } from "./extract.js";

/** No growth and no stop button for this long means the turn is over. */
const QUIET_MS = 1_200;
/** A send that produces no reply at all in this long was not a send. */
const ARM_TIMEOUT_MS = 20_000;
/** Kept per conversation. Older turns are only ever aggregate anyway. */
const MAX_RECORDS = 50;

export interface TrackerOptions {
  root?: Document;
  /**
   * The forecast to fall back on when a reply appears without a send this
   * script saw: the last non-empty draft's snapshot. Never used to replace a
   * frozen one.
   */
  lastSnapshot?: () => ForecastSnapshot | null;
  quietMs?: number;
  armTimeoutMs?: number;
  now?: () => number;
  /** Called once, after a pre-call forecast has a settled local outcome. */
  onSettled?: (record: TurnRecord) => void;
}

export interface SettledTurn {
  record: TurnRecord;
  /** The newest message the turn wrote, which is where its verdict is pinned. */
  element: Element;
}

export class TurnTracker {
  private readonly root: Document;
  private readonly quietMs: number;
  private readonly armTimeoutMs: number;
  private readonly now: () => number;
  private readonly lastSnapshot: () => ForecastSnapshot | null;
  private readonly onSettled: (record: TurnRecord) => void;

  private phase: "idle" | "armed" | "running" = "idle";
  private snapshot: ForecastSnapshot | null = null;
  private baseline = new WeakSet<Element>();
  private outTokens = 0;
  private startedAt = 0;
  private lastGrowthAt = 0;
  private tail: Element | null = null;
  private records: TurnRecord[] = [];
  private elements = new Map<number, Element>();
  private nextId = 1;
  private conversation: string | null = null;

  constructor(
    private readonly onChange: () => void,
    options: TrackerOptions = {},
  ) {
    this.root = options.root ?? document;
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.armTimeoutMs = options.armTimeoutMs ?? ARM_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.lastSnapshot = options.lastSnapshot ?? (() => null);
    this.onSettled = options.onSettled ?? (() => undefined);
  }

  /**
   * The draft was sent. Freeze the forecast and remember what was on screen
   * before the reply, so everything that appears next is attributable to it.
   */
  arm(snapshot: ForecastSnapshot | null): void {
    if (snapshot === null || this.phase === "running") return;
    this.snapshot = snapshot;
    this.baseline = new WeakSet(findAssistantMessages(this.root));
    this.outTokens = 0;
    this.tail = null;
    this.startedAt = this.now();
    this.lastGrowthAt = this.startedAt;
    this.phase = "armed";
    this.onChange();
  }

  /** True while a turn is armed or writing. */
  isBusy(): boolean {
    return this.phase !== "idle";
  }

  /** What the chip draws while the reply writes, or null between turns. */
  live(): { snapshot: ForecastSnapshot; outTokens: number } | null {
    if (this.phase !== "running" || this.snapshot === null) return null;
    return { snapshot: this.snapshot, outTokens: this.outTokens };
  }

  /** The message the turn is writing into, which is what the chip follows. */
  liveElement(): Element | null {
    return this.phase === "running" ? this.tail : null;
  }

  ledger(): readonly TurnRecord[] {
    return this.records;
  }

  /** Settled turns that still have their message on the page, oldest first. */
  settled(): SettledTurn[] {
    const out: SettledTurn[] = [];
    for (const record of this.records) {
      const element = this.elements.get(record.id);
      if (element === undefined || !element.isConnected) continue;
      out.push({ record, element });
    }
    return out;
  }

  /**
   * A route change is a different conversation, and a score from the previous
   * one would be read as belonging to this one.
   */
  setConversation(key: string): void {
    if (this.conversation === key) return;
    this.conversation = key;
    this.records = [];
    this.elements.clear();
    this.phase = "idle";
    this.snapshot = null;
    this.outTokens = 0;
    this.onChange();
  }

  /**
   * One observation of the page. Cheap while idle (three selector lookups),
   * and only walks message text once a turn is actually in flight.
   */
  tick(): void {
    const generating = isGenerating(this.root);
    if (this.phase === "idle") {
      // The send was missed: a click path this build does not know, or a retry
      // button. The newest message is the one being written, so everything
      // before it is the baseline.
      if (!generating) return;
      const recovered = this.lastSnapshot();
      if (recovered === null) return;
      this.snapshot = recovered;
      this.armFromObservation();
      return;
    }

    const fresh = findAssistantMessages(this.root).filter((node) => !this.baseline.has(node));
    // Monotonic: virtualization and collapsing a thinking block both shrink the
    // rendered text, and neither means the reply unwrote itself.
    const measured = Math.max(this.outTokens, tokensOfMessages(fresh));
    const grew = measured > this.outTokens;
    if (grew) {
      this.outTokens = measured;
      this.lastGrowthAt = this.now();
      this.tail = fresh.at(-1) ?? this.tail;
    }

    if (this.phase === "armed") {
      if (generating || fresh.length > 0) {
        this.phase = "running";
        this.onChange();
        return;
      }
      if (this.now() - this.startedAt > this.armTimeoutMs) {
        this.phase = "idle";
        this.snapshot = null;
        this.onChange();
      }
      return;
    }

    if (generating) {
      if (grew) this.onChange();
      return;
    }
    if (this.now() - this.lastGrowthAt < this.quietMs) {
      if (grew) this.onChange();
      return;
    }
    this.settle();
  }

  /** Score the turn and hand it to the ledger. */
  private settle(): void {
    const snapshot = this.snapshot;
    this.phase = "idle";
    this.snapshot = null;
    if (snapshot === null) {
      this.onChange();
      return;
    }
    const scale = scoringScale(snapshot);
    const abandoned = this.outTokens <= 0;
    const record: TurnRecord = {
      id: this.nextId++,
      snapshot,
      scale,
      outTokens: this.outTokens,
      band: abandoned ? null : bandOf(this.outTokens, scale.quantiles),
      abandoned,
      startedAt: this.startedAt,
      settledAt: this.now(),
    };
    this.records.push(record);
    this.onSettled(record);
    if (this.tail !== null) this.elements.set(record.id, this.tail);
    while (this.records.length > MAX_RECORDS) {
      const dropped = this.records.shift();
      if (dropped !== undefined) this.elements.delete(dropped.id);
    }
    this.outTokens = 0;
    this.tail = null;
    this.onChange();
  }

  /**
   * Arm from a reply that is already on screen. Only reached when the send
   * itself was missed, so the baseline is a guess: everything except the
   * newest message. A wrong guess here costs one turn's score, never a wrong
   * number on a scored one, because the alternative is measuring the reply as
   * empty.
   */
  private armFromObservation(): void {
    const messages = findAssistantMessages(this.root);
    const streaming = messages.at(-1) ?? null;
    this.baseline = new WeakSet(streaming === null ? messages : messages.slice(0, -1));
    this.outTokens = streaming === null ? 0 : estimateTokensFromText(streaming.textContent ?? "");
    this.tail = streaming;
    this.startedAt = this.now();
    this.lastGrowthAt = this.startedAt;
    this.phase = "running";
    this.onChange();
  }
}

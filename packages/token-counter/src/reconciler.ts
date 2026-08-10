import type { CountQuality } from "@token-forecaster/core";

/**
 * Race-safe reconciliation between fast local estimates and slow
 * Anthropic-verified counts.
 *
 * Invariants:
 *  1. A local estimate always reflects the latest input.
 *  2. A verified count is only displayed if it was requested for the
 *     latest input AND no newer verification has been issued since.
 *  3. An older verification response can never replace a newer count,
 *     regardless of network arrival order.
 *
 * The reconciler is pure state-machine logic: no timers, no fetch. The
 * caller owns debouncing and transport, and feeds events in.
 */

export interface DisplayedCount {
  tokens: number;
  quality: CountQuality;
  /** True while a newer input exists than the displayed verified count. */
  pendingVerification: boolean;
}

export interface VerificationTicket {
  readonly ticketId: number;
  readonly inputVersion: number;
}

export class CountReconciler {
  private inputVersion = 0;
  private nextTicketId = 1;
  private latestTicketId = 0;
  private displayed: DisplayedCount = {
    tokens: 0,
    quality: "character_heuristic",
    pendingVerification: false,
  };

  /**
   * The input changed: display the fresh local estimate and invalidate any
   * verified count and any in-flight verification.
   */
  noteInputChanged(
    localTokens: number,
    quality: Exclude<CountQuality, "anthropic_verified"> = "character_heuristic",
  ): DisplayedCount {
    this.inputVersion += 1;
    this.displayed = {
      tokens: localTokens,
      quality,
      pendingVerification: true,
    };
    return this.displayed;
  }

  /** A verification request is being sent for the current input. */
  startVerification(): VerificationTicket {
    const ticket: VerificationTicket = {
      ticketId: this.nextTicketId++,
      inputVersion: this.inputVersion,
    };
    this.latestTicketId = ticket.ticketId;
    return ticket;
  }

  /**
   * A verification response arrived. Returns the new displayed count, or
   * null if the response was stale and discarded.
   */
  resolveVerification(
    ticket: VerificationTicket,
    verifiedTokens: number,
  ): DisplayedCount | null {
    const isForCurrentInput = ticket.inputVersion === this.inputVersion;
    const isLatestRequest = ticket.ticketId === this.latestTicketId;
    if (!isForCurrentInput || !isLatestRequest) {
      return null;
    }
    this.displayed = {
      tokens: verifiedTokens,
      quality: "anthropic_verified",
      pendingVerification: false,
    };
    return this.displayed;
  }

  /**
   * A verification request failed. Keeps the current display; marks nothing
   * verified. Returns whether the failure concerned the latest request.
   */
  failVerification(ticket: VerificationTicket): boolean {
    return (
      ticket.ticketId === this.latestTicketId &&
      ticket.inputVersion === this.inputVersion
    );
  }

  get current(): DisplayedCount {
    return this.displayed;
  }
}

// Minimal ambient timer declarations so this package needs neither DOM nor
// Node type libraries (it runs in both environments).
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/**
 * Debounce with cancellation. Returns a function that schedules `fn` after
 * `delayMs`, resetting the timer on each call; `cancel` drops any pending
 * invocation.
 */
export function debounced<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): { call: (...args: Args) => void; cancel: () => void } {
  let timer: unknown;
  return {
    call(...args: Args) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn(...args);
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

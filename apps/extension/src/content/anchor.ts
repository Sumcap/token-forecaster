/**
 * Keeping hold of the composer in a React SPA.
 *
 * claude.ai swaps the composer node on re-render and changes routes without a
 * page load, so the composer is re-resolved from a debounced MutationObserver
 * rather than looked up once. A slow interval backs it up for the case where a
 * mutation lands outside the observed subtree.
 */
import { debounced } from "@token-forecaster/token-counter";
import { findComposer } from "./extract.js";

export interface AnchorWatcher {
  current(): HTMLElement | null;
  /** Force a re-resolve now, e.g. right after a settings change. */
  refresh(): void;
  stop(): void;
}

export interface WatchOptions {
  root?: Document;
  debounceMs?: number;
  pollMs?: number;
}

export function watchComposer(
  onChange: (composer: HTMLElement | null) => void,
  options: WatchOptions = {},
): AnchorWatcher {
  const root = options.root ?? document;
  const debounceMs = options.debounceMs ?? 250;
  const pollMs = options.pollMs ?? 2_000;
  let current: HTMLElement | null = null;

  const resolve = (): void => {
    const found = findComposer(root);
    const stale = current !== null && !current.isConnected;
    if (found === current && !stale) return;
    current = found;
    onChange(current);
  };

  const scheduled = debounced(resolve, debounceMs);
  const observer = new MutationObserver(() => scheduled.call());
  observer.observe(root.body, { childList: true, subtree: true });
  const timer = setInterval(resolve, pollMs);
  resolve();

  return {
    current: () => current,
    refresh: resolve,
    stop: () => {
      observer.disconnect();
      scheduled.cancel();
      clearInterval(timer);
    },
  };
}

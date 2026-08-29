/**
 * The one usage-meter curve, shared by the status line and the menu bar.
 *
 * Both surfaces must agree: the bar in the terminal and the bar in the menu bar
 * are the same measurement, so the fill is computed once here and rendered
 * twice. Imports nothing — the status line pulls this in and must stay free of
 * anything that costs milliseconds to load.
 */

/**
 * Fraction of the bar to fill, 0..1.
 *
 * Half width at P50 and full width at P90, so "past halfway" reads as "this
 * turn is already bigger than your median" without the user doing arithmetic.
 * Returns 0 when there is no usable forecast to measure against.
 */
export function meterFill(used: number, p50: number, p90: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(p50) || p50 <= 0) return 0;
  const ratio =
    used <= p50
      ? (used / p50) * 0.5
      : 0.5 + Math.min(0.5, ((used - p50) / Math.max(1, p90 - p50)) * 0.5);
  return Math.max(0, Math.min(1, ratio));
}

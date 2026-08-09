/**
 * Benjamini–Hochberg false-discovery-rate control.
 *
 * §10.6, control 2, and the sentence that makes it non-negotiable:
 *
 *   "**False-discovery-rate control.** Benjamini–Hochberg across the full
 *    nightly detector battery, not per-detector. The comparison count is
 *    known — it is the size of the battery — so this is straightforward and
 *    there is no excuse for omitting it."
 *
 * ## Why "across the battery" is the load-bearing part
 *
 * Applying BH separately to each detector family is the mistake that looks like
 * doing it. Nine families each controlling their own FDR at 0.05 is nine
 * independent 5% budgets, which over a nightly cadence is a spurious finding
 * every few days — precisely the outcome §10.6 says would "quietly make the
 * insight surface untrustworthy". The correction has to see every comparison
 * the night made, which is why {@link benjaminiHochberg} takes a flat array and
 * the battery is the only thing that calls it.
 *
 * ## Ties
 *
 * Equal p-values must share a decision. Without that, two identical findings
 * can end up on opposite sides of the line purely because of array order — the
 * kind of defect that is invisible in a test with distinct values and obvious
 * the first time a real battery produces two detectors reporting p = 1.
 */

export type FdrResult = {
  /** Aligned with the input array. */
  readonly rejected: readonly boolean[];
  /** The largest p-value declared significant, or `null` if none were. */
  readonly threshold: number | null;
  readonly alpha: number;
  readonly comparisons: number;
};

/** The FDR the nightly battery runs at. */
export const DEFAULT_ALPHA = 0.05;

/**
 * Benjamini–Hochberg step-up over `pValues`.
 *
 * Finds the largest *k* for which the *k*-th smallest p-value is at or below
 * `k·α/m`, then rejects everything at or below that value. Non-finite entries
 * are treated as p = 1 rather than dropped, because dropping them would shrink
 * *m* and quietly loosen the correction for everything else.
 */
export function benjaminiHochberg(pValues: readonly number[], alpha: number = DEFAULT_ALPHA): FdrResult {
  const m = pValues.length;
  if (m === 0) return { rejected: [], threshold: null, alpha, comparisons: 0 };

  const cleaned = pValues.map((value) => (Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1));
  const sorted = [...cleaned].sort((a, b) => a - b);

  let cutoff: number | null = null;
  for (let index = m - 1; index >= 0; index -= 1) {
    const value = sorted[index];
    if (value === undefined) continue;
    if (value <= ((index + 1) * alpha) / m) {
      cutoff = value;
      break;
    }
  }

  /*
   * Rejection by value, not by position. Ties share a decision — see the header.
   */
  return {
    rejected: cleaned.map((value) => cutoff !== null && value <= cutoff),
    threshold: cutoff,
    alpha,
    comparisons: m,
  };
}

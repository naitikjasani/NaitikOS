/**
 * Exact binomial tail probabilities.
 *
 * ## Why this exists
 *
 * §10.6's adherence detector is specified as detecting "deviation from an
 * established routine or medication schedule". A deviation is a comparison, and
 * a comparison without a test is a threshold someone picked — "flag it if it
 * drops below 80%" fires every time a fortnight contains a holiday and stays
 * silent through a slow three-month slide.
 *
 * Adherence is a count of successes out of a known number of scheduled doses.
 * That is a binomial, exactly, and the question "how surprising is 9 of 14 for
 * someone whose established rate is 0.95" has an exact answer that needs no
 * approximation, no normal-approximation caveat, and no minimum-expected-count
 * rule of thumb.
 *
 * ## Log space, because the naive version silently returns zero
 *
 * The obvious implementation multiplies `(1-p)^n` and walks a recurrence. At
 * p = 0.97 and n = 180 — a person on two daily medications over three months —
 * `(1-p)^n` is about 10⁻²⁷⁰, and a few more doses puts it under
 * `Number.MIN_VALUE`. It underflows to zero, the recurrence stays at zero, and
 * the function returns a p-value of 0 for every input. Every finding would then
 * clear every threshold, which is the worst possible failure: silent, and
 * biased entirely towards firing.
 *
 * So the probability mass function is computed in log space through a Lanczos
 * log-gamma, and the tail is summed with the log-sum-exp trick.
 */

/* -------------------------------------------------------------------------
 * log Γ
 * ---------------------------------------------------------------------- */

/** Lanczos coefficients, g = 7, n = 9. Accurate to ~15 significant figures. */
const LANCZOS: readonly number[] = Object.freeze([
  0.999_999_999_999_809_93, 676.520_368_121_885_1, -1259.139_216_722_402_8, 771.323_428_777_653_13,
  -176.615_029_162_140_6, 12.507_343_278_686_905, -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
  1.505_632_735_149_311_6e-7,
]);

/**
 * Natural log of the gamma function, for `x > 0`.
 *
 * Only ever called with positive integers here (`n + 1`, `k + 1`), but written
 * for the general positive reals because a factorial-only version would tempt a
 * future caller into a lookup table with an off-by-one in it.
 */
export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Number.NaN;

  // Reflection is unnecessary for x > 0.5, which is every call site here.
  const z = x - 1;
  let series = LANCZOS[0] ?? 0;
  for (let index = 1; index < LANCZOS.length; index += 1) {
    series += (LANCZOS[index] ?? 0) / (z + index);
  }
  const t = z + LANCZOS.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** log C(n, k). */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/* -------------------------------------------------------------------------
 * The tail
 * ---------------------------------------------------------------------- */

/** log of the binomial pmf at `k`, for `n` trials at rate `p`. */
function logPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : Number.NEGATIVE_INFINITY;
  if (p >= 1) return k === n ? 0 : Number.NEGATIVE_INFINITY;
  return logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

/**
 * `P(X ≤ k)` for `X ~ Binomial(n, p)`.
 *
 * The lower tail specifically, because the pre-registered hypothesis is
 * one-directional: adherence has *dropped*. Testing both directions would
 * double the comparison count for a finding — "you took your medication more
 * reliably than usual" — that nobody needs surfaced, and §10.6's whole argument
 * is that every extra comparison is paid for by everyone.
 *
 * Returns 1 for a degenerate window (`n ≤ 0`), which is the honest answer to
 * "how surprising is this" when there is nothing to be surprised by.
 */
export function binomialTailBelow(k: number, n: number, p: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0) return 1;
  if (k >= n) return 1;
  if (k < 0) return 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) return 1;

  const terms: number[] = [];
  for (let index = 0; index <= k; index += 1) terms.push(logPmf(index, n, p));

  const total = Math.exp(logSumExp(terms));
  return Math.min(1, Math.max(0, total));
}

function logSumExp(values: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value > max) max = value;
  if (!Number.isFinite(max)) return Number.NEGATIVE_INFINITY;

  let sum = 0;
  for (const value of values) sum += Math.exp(value - max);
  return max + Math.log(sum);
}

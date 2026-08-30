/**
 * Correlation, with a t-test and a lag search — §10.6's headline detector.
 *
 * ## Spearman, not Pearson, and this is the load-bearing choice
 *
 * Every metric this system correlates is either a 1–5 tap scale (mood, energy,
 * anxiety, skin state) or a bounded physiological quantity with a long tail
 * (training volume, sleep hours). Pearson's r on a five-point scale assumes an
 * interval scale that a tap does not have: the distance between "2" and "3" is
 * not the distance between "4" and "5" in any sense the operator intended when
 * they tapped it.
 *
 * Spearman's rho is Pearson's r on the *ranks*, which is exactly the assumption
 * this data supports — that a higher tap means more, and nothing about how much
 * more. It is also robust to the single outlier day that an n=1 series is full
 * of, and one catastrophic Tuesday should not create a correlation.
 *
 * The cost is that rho detects monotone association rather than linear
 * association, which for these metrics is the thing worth detecting anyway.
 *
 * ## The p-value is approximate, and says so
 *
 * The t approximation to Spearman's rho is standard and good for n ≥ 20; the
 * detector's minimum-N gate is 30 (§10.6 control 1), so every p-value this
 * function returns in practice is inside the range where the approximation
 * holds. Below that the gate refuses to produce a finding at all, which is a
 * better answer than a precise p-value on eight points.
 *
 * ## Ties are averaged, and the correction is applied
 *
 * A 1–5 scale over ninety days is *mostly* ties. Assigning ranks by position
 * would make rho a function of the sort order, which is the kind of bug that
 * produces a stable, plausible, entirely fictional correlation. Averaged ranks
 * plus the tie-corrected formula is the only version that is right here.
 */

import { shiftDayKey } from '../temporal/instant';
import { logGamma } from './binomial';

export type PairedSample = { readonly x: number; readonly y: number };

export type Correlation = {
  /** Spearman's rho, −1 to 1. */
  readonly rho: number;
  readonly n: number;
  /** Two-sided, from the t approximation. `null` when n is too small to test. */
  readonly pValue: number | null;
};

/** Below this, the t approximation is not worth reporting. */
export const MIN_CORRELATION_N = 30;

/**
 * Spearman's rho over paired samples.
 *
 * Returns `null` for fewer than three pairs or for a constant series — a
 * constant has no ranks to correlate, and returning 0 would say "no
 * association" when the honest answer is "not a question that has an answer".
 */
export function spearman(samples: readonly PairedSample[]): Correlation | null {
  const usable = samples.filter((pair) => Number.isFinite(pair.x) && Number.isFinite(pair.y));
  const n = usable.length;
  if (n < 3) return null;

  const rankX = averagedRanks(usable.map((pair) => pair.x));
  const rankY = averagedRanks(usable.map((pair) => pair.y));
  if (rankX === null || rankY === null) return null;

  /* Pearson on the ranks. The tie-corrected form, not the 1 − 6Σd²/(n³−n)
   * shortcut, which is only valid without ties — and this data is mostly ties. */
  const rho = pearson(rankX, rankY);
  if (rho === null) return null;

  return { rho, n, pValue: n >= 3 ? twoSidedT(rho, n) : null };
}

/**
 * The best lag, searched over a window.
 *
 * §10.2 wants `PRECEDES` edges to carry "a lag distribution", and §4.9's skin
 * example is the motivating case: "skin flares typically lag a trigger by 48–72
 * hours". A zero-lag-only correlation would miss every relationship of that
 * shape, which is most of the interesting ones.
 *
 * **The lag search is a multiple comparison and is priced as one.** Searching
 * eight lags and reporting the best is eight tests, and reporting its raw
 * p-value would be exactly the dishonesty §10.6 is written against. The p-value
 * returned here is Šidák-adjusted for the number of lags searched, which is
 * conservative and correct; Benjamini–Hochberg across the battery then runs on
 * top of it.
 */
export type LaggedCorrelation = Correlation & {
  /** Days `x` leads `y` by. 0 means same-day. */
  readonly lagDays: number;
  /** How many lags were searched, so the adjustment is auditable. */
  readonly lagsSearched: number;
};

export type DailyPair = { readonly dayKey: string; readonly value: number };

/**
 * Search lags 0..`maxLagDays` and return the strongest association.
 *
 * "Strongest" is by |rho|, not by p-value. A p-value at fixed n is a monotone
 * function of |rho| anyway, and choosing by effect size makes the intent
 * explicit: the question is how *related* two things are, not how surprised the
 * arithmetic is.
 */
export function bestLaggedCorrelation(
  x: readonly DailyPair[],
  y: readonly DailyPair[],
  maxLagDays: number,
): LaggedCorrelation | null {
  const lags = Math.max(0, Math.floor(maxLagDays));
  const lagsSearched = lags + 1;

  let best: LaggedCorrelation | null = null;

  for (let lag = 0; lag <= lags; lag += 1) {
    const paired = pairOnDayKey(x, y, lag);
    const correlation = spearman(paired);
    if (correlation === null) continue;

    if (best === null || Math.abs(correlation.rho) > Math.abs(best.rho)) {
      best = { ...correlation, lagDays: lag, lagsSearched };
    }
  }

  if (best === null) return null;

  /* Šidák over the lags searched: 1 − (1 − p)^k. Conservative, exact under
   * independence, and independence is not quite true across adjacent lags — so
   * this over-corrects slightly, which is the direction to err in. */
  const adjusted =
    best.pValue === null ? null : Math.min(1, 1 - Math.pow(1 - best.pValue, lagsSearched));

  return { ...best, pValue: adjusted };
}

/**
 * Pair two daily series, offsetting `y` forward by `lagDays`.
 *
 * Joined on the day key, so a day missing from either series drops out of the
 * pair rather than being interpolated. §8.9(3)'s "gaps are gaps" is a charting
 * rule; here it is a correctness one — an interpolated day would be a
 * fabricated observation entering a statistical test.
 */
export function pairOnDayKey(
  x: readonly DailyPair[],
  y: readonly DailyPair[],
  lagDays: number,
): readonly PairedSample[] {
  const byDay = new Map(y.map((point) => [point.dayKey, point.value]));
  const paired: PairedSample[] = [];

  for (const point of x) {
    /* `temporal/`'s own shift, not a local one. §11.3 puts calendar arithmetic
     * behind one door, and a second implementation here would be a second place
     * for a leap-year bug to live. */
    const target = shiftDayKey(point.dayKey, lagDays);
    if (target === null) continue;
    const value = byDay.get(target);
    if (value === undefined) continue;
    paired.push({ x: point.value, y: value });
  }

  return paired;
}

/* -------------------------------------------------------------------------
 * Arithmetic
 * ---------------------------------------------------------------------- */

/** Ranks with ties averaged. `null` for a constant series, which has no ranks. */
function averagedRanks(values: readonly number[]): readonly number[] | null {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);

  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1]?.value === indexed[position]?.value) end += 1;

    /* 1-based ranks, averaged across the tied block. */
    const average = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) {
      const entry = indexed[index];
      if (entry !== undefined) ranks[entry.index] = average;
    }
    position = end + 1;
  }

  const first = ranks[0];
  if (first !== undefined && ranks.every((rank) => rank === first)) return null;
  return ranks;
}

function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;

  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < n; index += 1) {
    sumX += x[index] ?? 0;
    sumY += y[index] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = (x[index] ?? 0) - meanX;
    const dy = (y[index] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX <= 0 || varianceY <= 0) return null;
  const r = covariance / Math.sqrt(varianceX * varianceY);
  return Math.max(-1, Math.min(1, r));
}

/**
 * Two-sided p for `t = rho · sqrt((n − 2) / (1 − rho²))` on `n − 2` df.
 *
 * Via the regularised incomplete beta, which is the standard route and the one
 * that stays accurate in the far tail where a naive series does not.
 */
function twoSidedT(rho: number, n: number): number {
  const df = n - 2;
  if (df <= 0) return 1;
  if (Math.abs(rho) >= 1) return 0;

  const t = rho * Math.sqrt(df / (1 - rho * rho));
  return regularisedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * `I_x(a, b)`, by the continued fraction.
 *
 * Numerical Recipes' `betacf`, with the symmetry reflection that keeps the
 * fraction in its convergent regime. Written out rather than pulled from a
 * dependency because §5.14 treats a transitive dependency as a supply-chain
 * surface, and this is forty lines of arithmetic with a closed-form test.
 */
function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;

  const front =
    Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));

  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(x, a, b)) / a
    : 1 - (Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + b * Math.log1p(-x) + a * Math.log(x)) * betacf(1 - x, b, a)) / b;
}

const FPMIN = 1e-300;

function betacf(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;

    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;

    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < 3e-16) break;
  }

  return h;
}

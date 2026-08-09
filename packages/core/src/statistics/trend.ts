/**
 * Ordinary least squares over a daily series, and the band §8.9(4) requires.
 *
 *   "Confidence must be visible where it exists. Trend lines carry a band. A
 *    projection is rendered dashed with an interval."
 *
 * ## The honesty problem this file has to solve
 *
 * A straight line through ninety bodyweight readings looks authoritative. It is
 * the single most over-trusted object a health application can draw, and P5
 * ("no unfounded claims") makes the caveats part of the deliverable rather than
 * something for a footnote nobody writes.
 *
 * Three of them are structural, so they are stated here and re-stated in
 * {@link TREND_CAVEAT}, which the chart renders beneath the line:
 *
 * 1. **Daily bodyweight is autocorrelated.** Today's reading is not independent
 *    of yesterday's — water, food volume and glycogen persist for days. OLS
 *    assumes independent residuals, so the interval below is *narrower than the
 *    truth*. It is a visual aid, not an inference.
 * 2. **A line is a model, not a measurement.** Extrapolating one is how "you
 *    will weigh 90 kg by Christmas" gets said out loud. {@link projectForward}
 *    exists, caps hard at {@link MAX_PROJECTION_DAYS}, and marks every point it
 *    produces so the renderer can dash it.
 * 3. **`r` is not evidence.** §10.6 is explicit about the multiple-comparisons
 *    problem, so `rSquared` travels with `n` and `spanDays` and nothing here
 *    ever emits a p-value. A correlation this file computes is a description of
 *    the points supplied, and callers must not present it as a finding.
 *
 * ## No `Decimal`
 *
 * See `statistics/types.ts`. These outputs are drawn, never stored.
 */

import { dayKeyIndex, shiftDayKey } from '../temporal/instant';
import { indexByDay } from './moving-average';
import type { DailyBand, DailyValue } from './types';

/**
 * The sentence that renders under every trend line.
 *
 * Exported rather than written into the chart component because the *reason* is
 * a domain fact, not a piece of copy — and because a caveat living in `core` is
 * one a redesign cannot quietly drop.
 */
export const TREND_CAVEAT =
  'A fitted line over readings that are not independent day to day. The band is indicative, not a confidence interval you should act on.';

/** Fewer points than this and there is no line, only two points and a hope. */
export const MIN_TREND_POINTS = 4;

/**
 * How far a projection may run.
 *
 * Fourteen days, and the number is a judgement rather than a derivation: it is
 * roughly the horizon over which a bulk's slope stays plausible, and short
 * enough that being wrong is visible before it is acted on for a month.
 */
export const MAX_PROJECTION_DAYS = 14;

/**
 * A fitted line, in units per day.
 *
 * `slope` is the number the operator cares about — kilograms per day, which the
 * UI multiplies by seven and presents per week, because nobody thinks in
 * kilograms per day.
 */
export type LinearFit = {
  /** Units per day. */
  readonly slope: number;
  /** Value at `originDayKey`. */
  readonly intercept: number;
  readonly originDayKey: string;
  /** Pearson's r. Descriptive. Never presented as evidence — see the header. */
  readonly r: number;
  readonly rSquared: number;
  /** Residual standard error, in the series' units. */
  readonly standardError: number;
  /** Contributing days. */
  readonly n: number;
  /** Calendar days from the first contributing day to the last. */
  readonly spanDays: number;
};

/**
 * Fit a line through a daily series.
 *
 * @returns `null` when there are fewer than {@link MIN_TREND_POINTS} distinct
 *   days, or when every reading falls on the same day — a vertical series has no
 *   slope, and returning `0` for it would draw a flat line through a single
 *   morning as though it were a trend.
 */
export function linearTrend(samples: readonly DailyValue[]): LinearFit | null {
  const daily = indexByDay(samples);
  if (daily.length < MIN_TREND_POINTS) return null;

  const first = daily[0];
  const last = daily.at(-1);
  // Both are present given the length check; the guard is for the type system.
  if (first === undefined || last === undefined) return null;

  const points = daily.map((sample) => ({ x: sample.index - first.index, y: sample.value }));
  const n = points.length;

  const meanX = points.reduce((total, p) => total + p.x, 0) / n;
  const meanY = points.reduce((total, p) => total + p.y, 0) / n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // Every reading on one day. No slope exists; see the doc comment.
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  /*
   * A perfectly flat series has `syy === 0`, and r is then 0/0.
   *
   * Reported as r = 1: the line explains the data exactly, because the data is
   * a horizontal line. Reporting 0 — the arithmetic accident — would say "no
   * relationship" about a series the model fits perfectly.
   */
  const r = syy === 0 ? 1 : sxy / Math.sqrt(sxx * syy);

  // Residual variance uses n − 2 degrees of freedom: two were spent on the
  // slope and the intercept. With n = 3 that is 1, which is why MIN_TREND_POINTS
  // is 4 rather than 3.
  const residualSumSquares = Math.max(0, syy - slope * sxy);
  const standardError = Math.sqrt(residualSumSquares / (n - 2));

  return {
    slope,
    intercept,
    originDayKey: first.dayKey,
    r,
    rSquared: r * r,
    standardError,
    n,
    spanDays: last.index - first.index,
  };
}

/**
 * The multiplier on the standard error.
 *
 * 1.96 is the normal approximation to a 95% interval. Deliberately *not*
 * Student's t: a t-table would imply this is a rigorous interval, and the
 * autocorrelation caveat above means it is not. An approximate multiplier with
 * an honest label beats an exact multiplier with a dishonest one.
 */
const BAND_MULTIPLIER = 1.96;

/**
 * The fitted line with a band, one point per contributing day.
 *
 * The band widens away from the centre of the data, which is the property that
 * makes it worth drawing at all: it shows the line being least sure exactly
 * where people read it hardest — at the right-hand edge.
 */
export function trendBand(samples: readonly DailyValue[], fit: LinearFit): readonly DailyBand[] {
  const daily = indexByDay(samples);
  // The origin comes from the caller rather than from `daily`, so unlike every
  // other key in this module it can genuinely be malformed.
  const origin = dayKeyIndex(fit.originDayKey);
  if (origin === null) return [];

  const xs = daily.map((sample) => ({ dayKey: sample.dayKey, x: sample.index - origin }));

  const meanX = xs.reduce((total, point) => total + point.x, 0) / xs.length;
  const sxx = xs.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  // Every reading on one day, or none at all: no spread to widen the band over.
  if (!Number.isFinite(sxx) || sxx === 0) return [];

  return xs.map(({ dayKey, x }) => {
    const value = fit.intercept + fit.slope * x;
    // Standard error of the fitted mean at x. Smallest at x̄, widening outward.
    const se = fit.standardError * Math.sqrt(1 / fit.n + (x - meanX) ** 2 / sxx);
    const half = BAND_MULTIPLIER * se;
    return { dayKey, value, lower: value - half, upper: value + half };
  });
}

export type ProjectedPoint = DailyBand & {
  /** Always true. The renderer dashes these (§8.9(4)). */
  readonly isProjection: true;
};

/**
 * Extrapolate the line forward, with a widening band.
 *
 * Capped at {@link MAX_PROJECTION_DAYS} and every point flagged, because §8.9(4)
 * requires a projection to *look* like a projection. The band grows with
 * distance from the data, so a fortnight out it is visibly wide — which is the
 * only honest way to draw a forecast from three weeks of weighing yourself.
 */
export function projectForward(
  samples: readonly DailyValue[],
  fit: LinearFit,
  days: number,
): readonly ProjectedPoint[] {
  const horizon = Math.min(Math.max(0, Math.trunc(days)), MAX_PROJECTION_DAYS);
  if (horizon === 0) return [];

  const daily = indexByDay(samples);
  const last = daily.at(-1);
  const origin = dayKeyIndex(fit.originDayKey);
  if (last === undefined || origin === null) return [];

  const xs = daily.map((sample) => sample.index - origin);
  const meanX = xs.reduce((total, x) => total + x, 0) / xs.length;
  const sxx = xs.reduce((total, x) => total + (x - meanX) ** 2, 0);
  if (sxx === 0) return [];

  const points: ProjectedPoint[] = [];
  for (let ahead = 1; ahead <= horizon; ahead += 1) {
    const dayKey = shiftDayKey(last.dayKey, ahead);
    if (dayKey === null) break;

    const x = last.index - origin + ahead;
    const value = fit.intercept + fit.slope * x;
    /*
     * The *prediction* interval, not the interval for the mean: the extra 1
     * under the root is the spread of an individual future observation. A
     * projection band that only covered the mean would be materially too narrow
     * for the thing it is being read as — "where will I actually be".
     */
    const se = fit.standardError * Math.sqrt(1 + 1 / fit.n + (x - meanX) ** 2 / sxx);
    const half = BAND_MULTIPLIER * se;
    points.push({ dayKey, value, lower: value - half, upper: value + half, isProjection: true });
  }

  return points;
}

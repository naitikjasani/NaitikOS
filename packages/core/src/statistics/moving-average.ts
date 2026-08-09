/**
 * Moving averages — §6.2's `statistics/` folder, and §4.6's actual requirement.
 *
 *   "Day-to-day variation of 1–2 kg is water, not tissue: the honest number for
 *    a bulk is the seven-day moving average, not the raw reading."
 *
 * That sentence is a product requirement disguised as arithmetic. A lifter who
 * reads yesterday's raw number and today's raw number concludes they gained
 * 1.4 kg overnight, which is false, and acts on it, which is worse. The trend
 * line is the number that means something.
 *
 * ## Three decisions worth reading before changing anything
 *
 * **The window is measured in days, not in samples.** A seven-*sample* average
 * over readings taken on the 1st, 2nd, 3rd and then the 20th, 21st, 22nd and
 * 23rd would present three weeks of drift as one week's trend. The window here
 * is a calendar span, and a sparse span simply produces fewer contributors.
 *
 * **A thin window produces a gap, not a confident number.** `minSamples`
 * defaults to a majority of the window. One reading in seven days averages to
 * itself, which is the raw number wearing a trend line's clothes — the most
 * misleading output this file could produce. It returns `null` instead, the
 * line breaks, and §8.9(3) is satisfied.
 *
 * **Trailing, not centred.** A centred average is statistically better and
 * cannot be computed for the three most recent days, which are the days the
 * operator is actually looking at. Trailing lags by roughly half the window and
 * exists on the right-hand edge — the trade every scale app makes, and the right
 * one here.
 */

import { dayKeyIndex, shiftDayKey } from '../temporal/instant';
import type { DailyEstimate, DailyValue } from './types';

/** §4.6's window. Seven days, because bodyweight's dominant noise is weekly. */
export const DEFAULT_TREND_WINDOW_DAYS = 7;

export type MovingAverageOptions = {
  /** Calendar span of the window, inclusive of the day itself. */
  readonly windowDays?: number;
  /**
   * Contributing days required before a value is emitted.
   *
   * Defaults to `ceil(windowDays / 2)` — a majority. Set it higher for a
   * stricter line; setting it to 1 turns the trend into the raw series and is
   * almost certainly a mistake.
   */
  readonly minSamples?: number;
};

/**
 * A day key with its integer position, so the sweep never re-parses.
 *
 * Exported for `trend.ts`, and not from the package index. Sharing the *indexed*
 * form rather than re-deriving it there is what removes a set of `index === null`
 * branches that `indexByDay` has already made unreachable — dead defensive code
 * being exactly the kind of decorative check this codebase keeps finding.
 */
export type IndexedValue = { readonly dayKey: string; readonly index: number; readonly value: number };

/**
 * Collapse repeated readings on one day to a single value, sorted, indexed.
 *
 * Two weigh-ins on a Tuesday are two readings of one day's weight, not two days
 * of data. Without this, seven readings on one morning would satisfy a seven-day
 * window and produce a "weekly average" from a single morning.
 *
 * The mean is right for this module's inputs, all of which are `mean`-aggregated
 * metrics. A metric whose aggregation is `sum` (training volume) must be
 * collapsed by `derivation/rollup.ts`, which reads the registry, *before* it
 * reaches here — §9.2: "Summing bodyweight over a week is nonsense and averaging
 * training volume hides a taper; the registry is what stops a chart from doing
 * either."
 *
 * Rows whose day key is not a real date are dropped rather than carried. They
 * cannot be windowed, and one of them anchoring the left edge would silently
 * evict every genuine reading before it.
 */
export function indexByDay(samples: readonly DailyValue[]): readonly IndexedValue[] {
  const totals = new Map<string, { sum: number; count: number; index: number }>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const existing = totals.get(sample.dayKey);
    if (existing !== undefined) {
      existing.sum += sample.value;
      existing.count += 1;
      continue;
    }
    const index = dayKeyIndex(sample.dayKey);
    if (index === null) continue;
    totals.set(sample.dayKey, { sum: sample.value, count: 1, index });
  }

  return [...totals.entries()]
    .map(([dayKey, { sum, count, index }]) => ({ dayKey, index, value: sum / count }))
    .sort((a, b) => a.index - b.index);
}

/** The public half of {@link indexByDay}: one value per day, chronological. */
export function collapseByDay(samples: readonly DailyValue[]): readonly DailyValue[] {
  return indexByDay(samples).map(({ dayKey, value }) => ({ dayKey, value }));
}

/**
 * A trailing moving average, one entry per day that has a reading.
 *
 * Output days mirror input days on purpose: emitting a value for every calendar
 * day in the range would require inventing readings for the days without one,
 * and §8.9(3) calls that fabrication. The chart draws the raw series and this
 * one over the same axis; days with no reading appear in neither.
 */
export function movingAverage(
  samples: readonly DailyValue[],
  options: MovingAverageOptions = {},
): readonly DailyEstimate[] {
  const windowDays = Math.max(1, Math.trunc(options.windowDays ?? DEFAULT_TREND_WINDOW_DAYS));
  const minSamples = Math.max(1, Math.trunc(options.minSamples ?? Math.ceil(windowDays / 2)));

  const daily = indexByDay(samples);
  const results: DailyEstimate[] = [];

  /*
   * A two-pointer sweep rather than a nested scan. Both edges only ever move
   * forward, so the whole series costs one pass. Ninety points would be fine
   * either way; a twenty-year record is what this is for.
   */
  let left = 0;
  let sum = 0;

  for (const [right, current] of daily.entries()) {
    sum += current.value;

    // Evict everything older than the window's calendar span.
    while (left <= right) {
      const oldest = daily[left];
      if (oldest === undefined || current.index - oldest.index < windowDays) break;
      sum -= oldest.value;
      left += 1;
    }

    const contributing = right - left + 1;
    results.push({
      dayKey: current.dayKey,
      value: contributing >= minSamples ? sum / contributing : null,
    });
  }

  return results;
}

/**
 * The two numbers the composition screen actually shows.
 *
 * What the trend says today, and whether it is moving. Both are `null` when the
 * data is too thin to say — which in a bulk's first week is the truthful answer,
 * and the one a naive implementation replaces with a dramatic arrow.
 */
export type TrendSummary = {
  readonly latest: number | null;
  readonly latestDayKey: string | null;
  /** Change from the trend value around `overDays` ago. `null` when unknowable. */
  readonly change: number | null;
  /**
   * The day `change` is actually measured from.
   *
   * Rarely exactly `overDays` back, because a missed weigh-in moves it. The UI
   * says "since 3 August" rather than "over the last week" for precisely this
   * reason — the second phrasing would be false on most weeks.
   */
  readonly changeFromDayKey: string | null;
  readonly overDays: number;
  /** Contributing days in the most recent window. Below `minSamples`, `latest` is null. */
  readonly sampleDays: number;
};

export function summariseTrend(
  samples: readonly DailyValue[],
  overDays: number,
  options: MovingAverageOptions = {},
): TrendSummary {
  const series = movingAverage(samples, options);
  const last = series.at(-1);

  if (last === undefined) {
    return { latest: null, latestDayKey: null, change: null, changeFromDayKey: null, overDays, sampleDays: 0 };
  }

  const windowDays = options.windowDays ?? DEFAULT_TREND_WINDOW_DAYS;

  /*
   * The comparison point is the *nearest trend value at or before* the target
   * day, not the value exactly `overDays` back. A missed weigh-in on the target
   * day would otherwise report no change at all, which reads as "the bulk
   * stalled" — a false statement produced by an absent reading rather than by
   * anything the body did.
   *
   * The search is bounded to one further window. Beyond that the honest answer
   * is that there is no comparison: reporting a forty-day-old value as "the
   * change over the last week" is the same lie in the other direction.
   */
  const target = shiftDayKey(last.dayKey, -overDays);
  const floor = shiftDayKey(last.dayKey, -overDays - windowDays);
  const earlier =
    target === null || floor === null
      ? undefined
      : [...series]
          .reverse()
          .find((point) => point.dayKey <= target && point.dayKey >= floor && point.value !== null);

  const endIndex = dayKeyIndex(last.dayKey);
  const sampleDays =
    endIndex === null
      ? 0
      : new Set(
          indexByDay(samples)
            .filter((sample) => endIndex - sample.index >= 0 && endIndex - sample.index < windowDays)
            .map((sample) => sample.dayKey),
        ).size;

  const comparable = last.value !== null && earlier !== undefined && earlier.value !== null;

  return {
    latest: last.value,
    latestDayKey: last.dayKey,
    change: comparable ? (last.value ?? 0) - (earlier?.value ?? 0) : null,
    changeFromDayKey: comparable ? (earlier?.dayKey ?? null) : null,
    overDays,
    sampleDays,
  };
}

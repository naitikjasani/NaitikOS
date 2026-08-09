import { describe, expect, it } from 'vitest';

import { collapseByDay, movingAverage, summariseTrend } from './moving-average';
import type { DailyValue } from './types';

/** A run of consecutive days starting at `from`. */
function run(from: string, values: readonly number[]): DailyValue[] {
  const [year, month, day] = from.split('-').map(Number) as [number, number, number];
  return values.map((value, offset) => {
    const date = Date.UTC(year, month - 1, day + offset, 12);
    return { dayKey: new Date(date).toISOString().slice(0, 10), value };
  });
}

describe('collapseByDay', () => {
  it('averages repeated readings on the same day', () => {
    expect(
      collapseByDay([
        { dayKey: '2026-08-03', value: 74 },
        { dayKey: '2026-08-03', value: 76 },
      ]),
    ).toEqual([{ dayKey: '2026-08-03', value: 75 }]);
  });

  it('sorts chronologically regardless of input order', () => {
    const collapsed = collapseByDay([
      { dayKey: '2026-08-05', value: 3 },
      { dayKey: '2026-08-03', value: 1 },
      { dayKey: '2026-08-04', value: 2 },
    ]);
    expect(collapsed.map((point) => point.dayKey)).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('drops keys that are not real dates rather than windowing on them', () => {
    expect(
      collapseByDay([
        { dayKey: '2026-08-03', value: 74 },
        { dayKey: 'not-a-day', value: 999 },
        { dayKey: '2026-02-31', value: 999 },
      ]),
    ).toEqual([{ dayKey: '2026-08-03', value: 74 }]);
  });

  it('drops NaN and Infinity, which would poison every window they touch', () => {
    expect(
      collapseByDay([
        { dayKey: '2026-08-03', value: Number.NaN },
        { dayKey: '2026-08-04', value: Number.POSITIVE_INFINITY },
        { dayKey: '2026-08-05', value: 74 },
      ]),
    ).toEqual([{ dayKey: '2026-08-05', value: 74 }]);
  });
});

describe('movingAverage', () => {
  it('averages the trailing window once enough days contribute', () => {
    // 1..7 on seven consecutive days. The seventh day's window holds all of them.
    const series = movingAverage(run('2026-08-01', [1, 2, 3, 4, 5, 6, 7]));
    expect(series).toHaveLength(7);
    expect(series.at(-1)).toEqual({ dayKey: '2026-08-07', value: 4 });
    // Day four is the first with a majority of the window (4 of 7).
    expect(series[3]).toEqual({ dayKey: '2026-08-04', value: 2.5 });
  });

  /**
   * The property that keeps the line honest. Three days of data cannot produce
   * a "seven-day average"; §8.9(3) wants the gap shown rather than filled.
   */
  it('emits a gap until the window has a majority of days', () => {
    const series = movingAverage(run('2026-08-01', [80, 80, 80]));
    expect(series.map((point) => point.value)).toEqual([null, null, null]);
  });

  it('is a calendar window, not a sample window', () => {
    // Three readings, then a three-week hole, then three more. The later
    // readings must not average with the earlier ones.
    const samples = [...run('2026-08-01', [70, 70, 70]), ...run('2026-08-22', [80, 80, 80, 80])];
    const series = movingAverage(samples);
    const last = series.at(-1);
    expect(last?.dayKey).toBe('2026-08-25');
    // 80, not the 75 a seven-sample window would produce.
    expect(last?.value).toBe(80);
  });

  it('never carries a value forward across a gap', () => {
    const samples = [...run('2026-08-01', [70, 70, 70, 70, 70, 70, 70]), ...run('2026-09-01', [90])];
    const series = movingAverage(samples);
    // The lone September reading has one contributing day in its window.
    expect(series.at(-1)).toEqual({ dayKey: '2026-09-01', value: null });
  });

  it('counts a day once however many times it was weighed', () => {
    const doubled = [
      ...run('2026-08-01', [1, 2, 3]),
      ...run('2026-08-01', [1, 2, 3]),
      ...run('2026-08-04', [4]),
    ];
    const series = movingAverage(doubled);
    // Four distinct days, so four entries — not seven.
    expect(series).toHaveLength(4);
    expect(series.at(-1)?.value).toBe(2.5);
  });

  it('honours an explicit window and minimum', () => {
    const series = movingAverage(run('2026-08-01', [1, 2, 3, 4]), { windowDays: 2, minSamples: 2 });
    expect(series.map((point) => point.value)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('returns nothing for no input', () => {
    expect(movingAverage([])).toEqual([]);
  });
});

describe('summariseTrend', () => {
  it('reports the latest trend value and its movement', () => {
    // A steady half-kilo per day, for three weeks.
    const samples = run(
      '2026-08-01',
      Array.from({ length: 21 }, (_, index) => 70 + index * 0.5),
    );
    const summary = summariseTrend(samples, 7);

    expect(summary.latestDayKey).toBe('2026-08-21');
    // Days 15–21 average to the value on day 18.
    expect(summary.latest).toBeCloseTo(78.5, 6);
    expect(summary.changeFromDayKey).toBe('2026-08-14');
    expect(summary.change).toBeCloseTo(3.5, 6);
    expect(summary.sampleDays).toBe(7);
  });

  /**
   * Ten days of data cannot yield a seven-day change in a seven-day average —
   * the average did not exist seven days ago. Null is the honest answer, and
   * the arrow the UI would otherwise draw is invented.
   */
  it('reports no change when the trend did not exist far enough back', () => {
    const samples = run('2026-08-01', [70, 70.5, 71, 71.5, 72, 72.5, 73, 73.5, 74, 74.5]);
    const summary = summariseTrend(samples, 7);

    expect(summary.latest).toBeCloseTo(73, 6);
    expect(summary.change).toBeNull();
    expect(summary.changeFromDayKey).toBeNull();
  });

  /**
   * The other direction of the same lie: a value from six weeks ago is not
   * "the change over the last week".
   */
  it('refuses a comparison point more than one further window back', () => {
    const samples = [
      ...run('2026-06-01', [70, 70, 70, 70, 70, 70, 70]),
      ...run('2026-08-01', [80, 80, 80, 80, 80, 80, 80]),
    ];
    expect(summariseTrend(samples, 7).change).toBeNull();
  });

  /**
   * The failure mode this guards. A missed weigh-in exactly `overDays` back must
   * not read as "no change" — that is a false statement produced by an absent
   * reading rather than by anything the body did.
   */
  it('falls back to the nearest earlier day when the comparison day has no reading', () => {
    const samples = [
      ...run('2026-08-01', [70, 70, 70, 70, 70, 70, 70]),
      // 8th and 9th missing.
      ...run('2026-08-10', [75, 75, 75, 75, 75]),
    ];
    const summary = summariseTrend(samples, 7);
    expect(summary.change).not.toBeNull();
    expect(summary.change ?? 0).toBeGreaterThan(0);
  });

  it('says nothing when it knows nothing', () => {
    expect(summariseTrend([], 7)).toEqual({
      latest: null,
      latestDayKey: null,
      change: null,
      changeFromDayKey: null,
      overDays: 7,
      sampleDays: 0,
    });
  });

  it('reports a null latest, with the sample count, when the window is thin', () => {
    const summary = summariseTrend(run('2026-08-01', [74, 74]), 7);
    expect(summary.latest).toBeNull();
    expect(summary.sampleDays).toBe(2);
  });
});

/**
 * §10.4's "structured summaries beat raw rows".
 *
 * The economics are the least of it. The reason is §10.0: ninety rows in a
 * prompt is ninety rows a model can average, and a model that averages has
 * computed.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens, summariseSeries } from './summarise';

function series(values: readonly number[]): { dayKey: string; value: number }[] {
  return values.map((value, index) => ({
    dayKey: `2026-03-${String(index + 1).padStart(2, '0')}`,
    value,
  }));
}

describe('summariseSeries', () => {
  it('replaces the rows with a sentence an order of magnitude smaller', () => {
    const points = series(Array.from({ length: 90 }, (_, index) => 3 + ((index % 5) - 2) * 0.4));
    const summary = summariseSeries({
      metricKey: 'mind.mood',
      label: 'Mood',
      unit: '',
      points,
      windowDays: 90,
    });

    expect(summary).not.toBeNull();
    const rowTokens = estimateTokens(JSON.stringify(points));
    expect(estimateTokens(summary?.sentence ?? '')).toBeLessThan(rowTokens / 5);
  });

  it('counts missing days rather than filling them', () => {
    /*
     * §8.9(3) as an epistemics rule. "6 days missing" is information — the
     * operator did not log — and interpolating would report a mean over days
     * that never happened.
     */
    const summary = summariseSeries({
      metricKey: 'mind.mood',
      label: 'Mood',
      unit: '',
      points: series([3, 4, 3, 4, 3]),
      windowDays: 30,
    });

    expect(summary?.missingDays).toBe(25);
    expect(summary?.n).toBe(5);
  });

  it('states the missing count even when it is zero', () => {
    /* A claim about completeness the reader would otherwise have to infer from
     * an absence. */
    const summary = summariseSeries({
      metricKey: 'mind.mood',
      label: 'Mood',
      unit: '',
      points: series([3, 4, 3, 4, 3]),
      windowDays: 5,
    });
    expect(summary?.sentence).toContain('0 of 5 days not recorded');
  });

  it('reports a falling trend as falling, and never as worse', () => {
    /* §4.7's register. "Falling" is a fact about a slope; "worse" would be a
     * judgement about a life. */
    const summary = summariseSeries({
      metricKey: 'mind.mood',
      label: 'Mood',
      unit: '',
      points: series([5, 4, 4, 3, 3, 2]),
      windowDays: 6,
    });

    expect(summary?.trendPerDay ?? 0).toBeLessThan(0);
    expect(summary?.sentence).toContain('falling');
    expect(summary?.sentence).not.toContain('worse');
  });

  it('declines a trend below four points', () => {
    /* A line through three points is a line through three points. */
    const summary = summariseSeries({
      metricKey: 'body.weight',
      label: 'Weight',
      unit: 'kg',
      points: series([80, 81, 82]),
      windowDays: 3,
    });
    expect(summary?.trendPerDay).toBeNull();
  });

  it('regresses on recorded-day index, not calendar distance', () => {
    /*
     * A three-week gap would dominate a calendar-distance fit through leverage
     * alone — one point far out on the x-axis moves a line more than twenty
     * clustered ones do, and a real series is full of unlogged stretches.
     */
    const clustered = [
      { dayKey: '2026-03-01', value: 1 },
      { dayKey: '2026-03-02', value: 2 },
      { dayKey: '2026-03-03', value: 3 },
      { dayKey: '2026-03-04', value: 4 },
    ];
    const gapped = [
      { dayKey: '2026-03-01', value: 1 },
      { dayKey: '2026-03-02', value: 2 },
      { dayKey: '2026-03-03', value: 3 },
      { dayKey: '2026-06-01', value: 4 },
    ];

    const a = summariseSeries({ metricKey: 'm', label: 'M', unit: '', points: clustered, windowDays: 10 });
    const b = summariseSeries({ metricKey: 'm', label: 'M', unit: '', points: gapped, windowDays: 10 });

    expect(a?.trendPerDay).toBeCloseTo(b?.trendPerDay ?? 0, 10);
  });

  it('returns null for an empty series rather than a summary of nothing', () => {
    expect(
      summariseSeries({ metricKey: 'm', label: 'M', unit: '', points: [], windowDays: 30 }),
    ).toBeNull();
  });
});

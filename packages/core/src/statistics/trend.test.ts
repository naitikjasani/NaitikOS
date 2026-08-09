import { describe, expect, it } from 'vitest';

import {
  MAX_PROJECTION_DAYS,
  MIN_TREND_POINTS,
  TREND_CAVEAT,
  type LinearFit,
  linearTrend,
  projectForward,
  trendBand,
} from './trend';
import type { DailyValue } from './types';

function run(from: string, values: readonly number[]): DailyValue[] {
  const [year, month, day] = from.split('-').map(Number) as [number, number, number];
  return values.map((value, offset) => ({
    dayKey: new Date(Date.UTC(year, month - 1, day + offset, 12)).toISOString().slice(0, 10),
    value,
  }));
}

describe('linearTrend', () => {
  it('recovers an exact line', () => {
    const fit = linearTrend(run('2026-08-01', [70, 71, 72, 73, 74]));
    expect(fit).not.toBeNull();
    expect(fit?.slope).toBeCloseTo(1, 10);
    expect(fit?.intercept).toBeCloseTo(70, 10);
    expect(fit?.originDayKey).toBe('2026-08-01');
    expect(fit?.rSquared).toBeCloseTo(1, 10);
    expect(fit?.standardError).toBeCloseTo(0, 10);
    expect(fit?.n).toBe(5);
    expect(fit?.spanDays).toBe(4);
  });

  it('measures slope per day, not per sample, across irregular spacing', () => {
    // Readings on days 0, 1, 10 and 11 of a series rising one unit per day.
    const samples: DailyValue[] = [
      { dayKey: '2026-08-01', value: 70 },
      { dayKey: '2026-08-02', value: 71 },
      { dayKey: '2026-08-11', value: 80 },
      { dayKey: '2026-08-12', value: 81 },
    ];
    expect(linearTrend(samples)?.slope).toBeCloseTo(1, 10);
  });

  it('refuses to fit fewer than the minimum number of days', () => {
    expect(linearTrend(run('2026-08-01', [70, 71, 72]))).toBeNull();
    expect(MIN_TREND_POINTS).toBe(4);
  });

  /**
   * Four weigh-ins on one morning are four readings of one day. A slope through
   * them is a vertical line, and returning zero would draw it flat — a trend
   * asserted from a single morning.
   */
  it('refuses to fit when every reading is on the same day', () => {
    expect(
      linearTrend([
        { dayKey: '2026-08-01', value: 70 },
        { dayKey: '2026-08-01', value: 71 },
        { dayKey: '2026-08-01', value: 72 },
        { dayKey: '2026-08-01', value: 73 },
      ]),
    ).toBeNull();
  });

  it('reports a flat series as perfectly explained rather than uncorrelated', () => {
    const fit = linearTrend(run('2026-08-01', [74, 74, 74, 74, 74]));
    expect(fit?.slope).toBeCloseTo(0, 10);
    // r = 1, not the 0/0 accident.
    expect(fit?.rSquared).toBe(1);
  });

  it('carries a residual error when the points are scattered', () => {
    const fit = linearTrend(run('2026-08-01', [70, 74, 71, 75, 72, 76]));
    expect(fit?.standardError ?? 0).toBeGreaterThan(0);
    expect(fit?.rSquared ?? 1).toBeLessThan(1);
  });

  it('states its caveat, so the chart can render it', () => {
    expect(TREND_CAVEAT).toContain('not independent');
  });
});

describe('trendBand', () => {
  it('is narrowest at the centre of the data and widest at the edges', () => {
    const samples = run('2026-08-01', [70, 74, 71, 75, 72, 76, 73]);
    const fit = linearTrend(samples);
    expect(fit).not.toBeNull();
    if (fit === null) return;

    const band = trendBand(samples, fit);
    expect(band).toHaveLength(7);

    const widths = band.map((point) => point.upper - point.lower);
    const middle = widths[3] ?? 0;
    const first = widths[0] ?? 0;
    const last = widths[6] ?? 0;

    expect(middle).toBeLessThan(first);
    expect(middle).toBeLessThan(last);
    // The band always contains the line it surrounds.
    for (const point of band) {
      expect(point.lower).toBeLessThanOrEqual(point.value);
      expect(point.upper).toBeGreaterThanOrEqual(point.value);
    }
  });

  it('collapses to the line itself when the fit is exact', () => {
    const samples = run('2026-08-01', [70, 71, 72, 73, 74]);
    const fit = linearTrend(samples);
    if (fit === null) throw new Error('expected a fit');

    for (const point of trendBand(samples, fit)) {
      expect(point.upper - point.lower).toBeCloseTo(0, 10);
    }
  });
});

describe('projectForward', () => {
  it('extends the line and flags every point as a projection', () => {
    const samples = run('2026-08-01', [70, 71, 72, 73, 74]);
    const fit = linearTrend(samples);
    if (fit === null) throw new Error('expected a fit');

    const projected = projectForward(samples, fit, 3);
    expect(projected).toHaveLength(3);
    expect(projected.map((point) => point.dayKey)).toEqual(['2026-08-06', '2026-08-07', '2026-08-08']);
    expect(projected[0]?.value).toBeCloseTo(75, 10);
    expect(projected.every((point) => point.isProjection)).toBe(true);
  });

  it('caps the horizon however far it is asked to go', () => {
    const samples = run('2026-08-01', [70, 71, 72, 73, 74, 76, 75]);
    const fit = linearTrend(samples);
    if (fit === null) throw new Error('expected a fit');

    expect(projectForward(samples, fit, 365)).toHaveLength(MAX_PROJECTION_DAYS);
    expect(projectForward(samples, fit, 0)).toEqual([]);
    expect(projectForward(samples, fit, -5)).toEqual([]);
  });

  /**
   * The property that makes a forecast honest: it gets visibly less sure the
   * further out it goes.
   */
  it('widens the band with distance', () => {
    const samples = run('2026-08-01', [70, 74, 71, 75, 72, 76, 73]);
    const fit = linearTrend(samples);
    if (fit === null) throw new Error('expected a fit');

    const projected = projectForward(samples, fit, MAX_PROJECTION_DAYS);
    const widths = projected.map((point) => point.upper - point.lower);
    for (const [index, width] of widths.entries()) {
      if (index === 0) continue;
      expect(width).toBeGreaterThan(widths[index - 1] ?? 0);
    }
  });

  it('is wider than the band over the fitted range, because it predicts a reading', () => {
    const samples = run('2026-08-01', [70, 74, 71, 75, 72, 76, 73]);
    const fit = linearTrend(samples);
    if (fit === null) throw new Error('expected a fit');

    const inSample = trendBand(samples, fit).at(-1);
    const outOfSample = projectForward(samples, fit, 1)[0];
    expect((outOfSample?.upper ?? 0) - (outOfSample?.lower ?? 0)).toBeGreaterThan(
      (inSample?.upper ?? 0) - (inSample?.lower ?? 0),
    );
  });
});

/**
 * The paths a caller can reach with a hand-built fit.
 *
 * `originDayKey` is the one key in this module that does not come from
 * `indexByDay` — it is carried on the fit, which a caller may have persisted,
 * transported, or constructed. Everything else is filtered before it arrives, so
 * these are the only remaining ways in.
 */
describe('a fit whose origin is not usable', () => {
  const samples = run('2026-08-01', [70, 71, 72, 73, 74]);
  const broken = { ...(linearTrend(samples) as LinearFit), originDayKey: '2026-02-31' };

  it('produces no band', () => {
    expect(trendBand(samples, broken)).toEqual([]);
  });

  it('produces no projection', () => {
    expect(projectForward(samples, broken, 5)).toEqual([]);
  });
});

describe('a fit applied to a series it did not come from', () => {
  const fit = linearTrend(run('2026-08-01', [70, 71, 72, 73, 74])) as LinearFit;

  it('has no band over an empty series', () => {
    expect(trendBand([], fit)).toEqual([]);
  });

  it('has no projection over an empty series', () => {
    expect(projectForward([], fit, 5)).toEqual([]);
  });

  /** One day has no spread, so there is nothing for the band to widen over. */
  it('has no band over a single day', () => {
    expect(trendBand([{ dayKey: '2026-08-01', value: 70 }], fit)).toEqual([]);
    expect(projectForward([{ dayKey: '2026-08-01', value: 70 }], fit, 5)).toEqual([]);
  });
});

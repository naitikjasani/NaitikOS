/**
 * Correlation, tested against series with known properties.
 *
 * §10.6 requires the detectors to be "fully unit-tested against synthetic data
 * with known properties", and the reason is specific to this file: a
 * correlation function that is subtly wrong does not crash. It returns a
 * plausible number, forever, and every downstream finding is quietly false.
 */

import { describe, expect, it } from 'vitest';

import { shiftDayKey } from '../temporal/instant';
import { bestLaggedCorrelation, pairOnDayKey, spearman } from './correlation';

/** Consecutive days from `from`. `shiftDayKey`, not `new Date` — §11.3 has no test exemption. */
function days(values: readonly number[], from = '2026-01-01'): { dayKey: string; value: number }[] {
  return values.map((value, index) => ({ dayKey: shiftDayKey(from, index) ?? from, value }));
}

describe('spearman', () => {
  it('returns 1 for a perfectly monotone increasing pair', () => {
    const samples = [1, 2, 3, 4, 5, 6].map((x) => ({ x, y: x * x }));
    const result = spearman(samples);
    expect(result?.rho).toBeCloseTo(1, 10);
  });

  it('returns 1 for a monotone *non-linear* pair, where Pearson would not', () => {
    /*
     * This is the reason the file uses Spearman. `y = e^x` is a perfect
     * monotone relationship; Pearson's r on it is about 0.9, which would
     * understate a relationship that is exact.
     */
    const samples = [1, 2, 3, 4, 5, 6, 7, 8].map((x) => ({ x, y: Math.exp(x) }));
    expect(spearman(samples)?.rho).toBeCloseTo(1, 10);
  });

  it('returns −1 for a perfectly decreasing pair', () => {
    const samples = [1, 2, 3, 4, 5].map((x) => ({ x, y: -x }));
    expect(spearman(samples)?.rho).toBeCloseTo(-1, 10);
  });

  it('is unmoved by a single wild outlier, which Pearson would not be', () => {
    const clean = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, y: x }));
    const withOutlier = [...clean.slice(0, 9), { x: 10, y: 10_000 }];
    /* Ranks are unchanged, so rho is unchanged. One catastrophic Tuesday must
     * not create — or destroy — a correlation. */
    expect(spearman(withOutlier)?.rho).toBeCloseTo(1, 10);
  });

  it('handles ties by averaging ranks, which a 1–5 scale is full of', () => {
    /*
     * Two constant-ish tap scales. Without averaged ranks, rho would depend on
     * the sort order of equal values — a stable, plausible, entirely fictional
     * correlation.
     */
    const samples = [
      { x: 3, y: 4 },
      { x: 3, y: 4 },
      { x: 4, y: 5 },
      { x: 4, y: 5 },
      { x: 5, y: 5 },
    ];
    const result = spearman(samples);
    expect(result).not.toBeNull();
    expect(result?.rho ?? 0).toBeGreaterThan(0.8);
  });

  it('returns null for a constant series rather than reporting no association', () => {
    /* A constant has no ranks. Returning 0 would say "unrelated" when the
     * honest answer is "not a question that has an answer". */
    expect(spearman([1, 2, 3, 4, 5].map((x) => ({ x, y: 7 })))).toBeNull();
  });

  it('returns null below three pairs', () => {
    expect(spearman([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull();
  });

  it('produces a small p-value for a strong association at reasonable n', () => {
    const samples = Array.from({ length: 40 }, (_, index) => ({ x: index, y: index + (index % 3) }));
    const result = spearman(samples);
    expect(result?.pValue ?? 1).toBeLessThan(0.001);
  });

  it('produces a large p-value for an unrelated pair', () => {
    /* A deterministic pseudo-random y, so the test does not flake. */
    const samples = Array.from({ length: 40 }, (_, index) => ({
      x: index,
      y: (index * 37) % 41,
    }));
    expect(spearman(samples)?.pValue ?? 0).toBeGreaterThan(0.05);
  });
});

describe('lag search', () => {
  it('finds a relationship offset by two days', () => {
    /* The §4.9 case: a trigger and a flare 48 hours later. A zero-lag-only
     * search would report nothing here. */
    const base = Array.from({ length: 40 }, (_, index) => (index * 7) % 5);
    const x = days(base);
    const y = days([0, 0, ...base], '2026-01-01');

    const best = bestLaggedCorrelation(x, y, 7);
    expect(best?.lagDays).toBe(2);
    expect(Math.abs(best?.rho ?? 0)).toBeGreaterThan(0.9);
  });

  it('charges for the lags it searched', () => {
    /*
     * §10.6's central complaint made concrete: searching eight lags and
     * reporting the winner's raw p-value is eight tests reported as one.
     */
    const samples = Array.from({ length: 40 }, (_, index) => (index * 13) % 7);
    const x = days(samples);
    const y = days(samples);

    const noSearch = bestLaggedCorrelation(x, y, 0);
    const searched = bestLaggedCorrelation(x, y, 7);

    expect(searched?.lagsSearched).toBe(8);
    expect(noSearch?.lagsSearched).toBe(1);
    /* Same winning lag, larger p-value, because seven more chances were taken. */
    expect(searched?.lagDays).toBe(0);
    expect(searched?.pValue ?? 0).toBeGreaterThanOrEqual(noSearch?.pValue ?? 0);
  });
});

describe('pairing', () => {
  it('drops a day missing from either series rather than interpolating', () => {
    /* An interpolated day is a fabricated observation entering a statistical
     * test — §8.9(3) as a correctness rule rather than a charting one. */
    const x = days([1, 2, 3, 4]);
    const y = [x[0], x[2]].flatMap((point) => (point === undefined ? [] : [point]));

    expect(pairOnDayKey(x, y, 0)).toHaveLength(2);
  });

  it('offsets by the lag when pairing', () => {
    const x = days([1, 2, 3]);
    const y = days([10, 20, 30]);
    const paired = pairOnDayKey(x, y, 1);

    /* x on day 1 pairs with y on day 2. */
    expect(paired).toEqual([
      { x: 1, y: 20 },
      { x: 2, y: 30 },
    ]);
  });
});

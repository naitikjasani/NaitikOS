import { describe, expect, it } from 'vitest';

import { MIN_TREND_POINTS } from '../../statistics/trend';
import type { DailyValue } from '../../statistics/types';
import { MAX_ARRIVAL_DAYS, deriveProgress, explainProgress } from './progress';
import type { GoalTarget } from './target';

function target(overrides: Partial<GoalTarget> = {}): GoalTarget {
  return {
    id: 't1',
    goalId: 'g1',
    metricKey: 'body.weight',
    comparator: 'at_least',
    targetValue: '80',
    unit: 'kg',
    windowDays: null,
    ...overrides,
  };
}

/** A clean upward series: 74 kg rising 0.1 kg/day over `days` days. */
function rising(days: number, from = 74, perDay = 0.1): DailyValue[] {
  return Array.from({ length: days }, (_, index) => ({
    dayKey: `2026-11-${String(index + 1).padStart(2, '0')}`,
    value: from + perDay * index,
  }));
}

const TODAY = '2026-11-20';

describe('a level target', () => {
  it('reports met the moment the level is reached, without needing a line', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '74' }),
      series: [{ dayKey: '2026-11-01', value: 74.2 }],
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('met');
    expect(progress.current).toBe(74.2);
  });

  /**
   * §10.9: a prediction "must degrade to 'insufficient data' rather than
   * guessing". Three points is a line through noise.
   */
  it('refuses to fit a line below the minimum, and says how far off it is', () => {
    const progress = deriveProgress({
      target: target(),
      series: rising(MIN_TREND_POINTS - 1),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('insufficient');
    expect(progress.fit).toBeNull();
    expect(progress.projection).toEqual([]);
    expect(explainProgress(progress, target())).toContain('3 of the 4 days');
  });

  it('projects an arrival and calls it on track inside the horizon', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '76' }),
      series: rising(20),
      horizonDayKey: '2027-06-01',
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('on_track');
    expect(progress.projectedAt).not.toBeNull();
    expect(progress.fit?.slope).toBeCloseTo(0.1, 5);
  });

  it('calls it behind when the line arrives after the horizon', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '90' }),
      series: rising(20),
      horizonDayKey: '2026-12-01',
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('behind');
  });

  it('calls it moving away when the slope points the wrong way', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '80' }),
      series: rising(20, 78, -0.1),
      horizonDayKey: '2027-06-01',
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('away');
  });

  /** "You will get there in 2043" is arithmetic, not information. */
  it('returns no arrival date when the line reaches the target absurdly far out', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '500' }),
      series: rising(20, 74, 0.001),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.projectedAt).toBeNull();
    expect(MAX_ARRIVAL_DAYS).toBe(730);
  });

  it('renders the projection dashed, per §8.9(4)', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '76' }),
      series: rising(20),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.projection.length).toBeGreaterThan(0);
    for (const point of progress.projection) {
      expect(point.isProjection).toBe(true);
      // §8.9(4): "A projection is rendered dashed with an interval."
      expect(point.upper).toBeGreaterThan(point.lower);
    }
  });
});

describe('a rate target', () => {
  const rate = target({ comparator: 'rate_of_change', targetValue: '0.25', unit: 'kg', windowDays: 28 });

  /**
   * The failure this branch exists to prevent: a bulk target reading as met
   * because the operator weighed 76 kg, when the question was about the slope.
   */
  it('is answered by the slope, not by the level', () => {
    const progress = deriveProgress({
      target: rate,
      series: rising(28, 74, 0.05),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    // 0.05 kg/day × 7 = 0.35 kg/week, which clears 0.25.
    expect(progress.current).toBeCloseTo(0.35, 5);
    expect(progress.status).toBe('met');
  });

  it('is behind when moving the right way too slowly', () => {
    const progress = deriveProgress({
      target: rate,
      series: rising(28, 74, 0.01),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('behind');
  });

  it('is moving away when the slope reverses', () => {
    const progress = deriveProgress({
      target: rate,
      series: rising(28, 74, -0.02),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('away');
  });

  /** "At least −0.25 kg/week" is a cut. The sign carries the direction. */
  it('handles a negative rate target', () => {
    const cut = target({ comparator: 'rate_of_change', targetValue: '-0.5', unit: 'kg', windowDays: 28 });
    const losing = deriveProgress({
      target: cut,
      series: rising(28, 80, -0.1),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(losing.status).toBe('met');
  });

  it('never projects an arrival date, because a rate has no destination', () => {
    const progress = deriveProgress({
      target: rate,
      series: rising(28, 74, 0.05),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.projectedAt).toBeNull();
  });

  it('has nothing to say without a line at all', () => {
    const progress = deriveProgress({
      target: rate,
      series: rising(2),
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.status).toBe('insufficient');
    expect(progress.current).toBeNull();
  });
});

describe('the ratio', () => {
  /**
   * Not clamped: a bulk that overshot has a ratio above 1, and flattening it
   * hides exactly the overshoot the tension detector is looking for.
   */
  it('goes above 1 rather than clamping', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '70' }),
      series: [{ dayKey: '2026-11-01', value: 91 }],
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.ratio).toBeCloseTo(1.3, 5);
  });

  it('is null against a target of zero rather than infinite', () => {
    const progress = deriveProgress({
      target: target({ targetValue: '0' }),
      series: [{ dayKey: '2026-11-01', value: 5 }],
      horizonDayKey: null,
      todayDayKey: TODAY,
    });
    expect(progress.ratio).toBeNull();
  });
});

describe('empty and malformed input', () => {
  it('says insufficient rather than throwing', () => {
    expect(
      deriveProgress({ target: target(), series: [], horizonDayKey: null, todayDayKey: TODAY }).status,
    ).toBe('insufficient');
    expect(
      deriveProgress({
        target: target({ targetValue: 'eighty' }),
        series: rising(20),
        horizonDayKey: null,
        todayDayKey: TODAY,
      }).status,
    ).toBe('insufficient');
  });
});

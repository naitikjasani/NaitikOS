import { describe, expect, it } from 'vitest';

import { MIN_TREND_POINTS } from '../../statistics/trend';
import { deriveProgress } from './progress';
import { planSnapshot, snapshotDrift } from './snapshot';
import type { GoalInput, GoalTarget } from './target';
import { GOAL_COMPARATORS, describeTarget, validateGoal, validateTarget } from './target';

const BASE: GoalInput = {
  id: 'g1',
  title: 'Build muscle',
  startedAt: '2026-11-01T12:00:00.000Z',
  targets: [
    { id: 't1', metricKey: 'body.weight', comparator: 'rate_of_change', targetValue: '0.25', unit: 'kg', windowDays: 28 },
  ],
};

describe('validating a goal', () => {
  it('accepts a well-formed one', () => {
    expect(validateGoal(BASE).ok).toBe(true);
  });

  /**
   * §4.10: "goal definition with a measurable target". A goal with no target is
   * an intention, and an intention with a progress bar beside it is the thing
   * this module exists not to be.
   */
  it('refuses a goal with no measurable target', () => {
    const result = validateGoal({ ...BASE, targets: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('goal_target_missing');
  });

  it('refuses an empty title, a bad instant, and a horizon before the start', () => {
    for (const [override, code] of [
      [{ title: '  ' }, 'goal_title_empty'],
      [{ startedAt: 'soon' }, 'goal_started_at_invalid'],
      [{ horizonAt: 'later' }, 'goal_horizon_invalid'],
      [{ horizonAt: '2026-01-01T12:00:00.000Z' }, 'goal_horizon_before_start'],
    ] as const) {
      const result = validateGoal({ ...BASE, ...override });
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
    }
  });
});

describe('validating a target', () => {
  it('knows its three comparators and no others', () => {
    expect([...GOAL_COMPARATORS]).toEqual(['at_least', 'at_most', 'rate_of_change']);
    const result = validateTarget({
      id: 't',
      metricKey: 'body.weight',
      comparator: 'roughly',
      targetValue: '80',
      unit: 'kg',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('goal_comparator_unknown');
  });

  /**
   * A rate over a week of bodyweight is dominated by water and gut content, and
   * reads as a spectacular gain or an alarming loss depending on which morning
   * the window starts. A silently assumed window is a different goal.
   */
  it('refuses a rate target with no window, or too short a one', () => {
    for (const windowDays of [null, 3, 13]) {
      const result = validateTarget({
        id: 't',
        metricKey: 'body.weight',
        comparator: 'rate_of_change',
        targetValue: '0.25',
        unit: 'kg',
        windowDays,
      });
      expect(result.ok, String(windowDays)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('goal_rate_window_missing');
    }
  });

  it('refuses a target value that is not a number', () => {
    const result = validateTarget({
      id: 't',
      metricKey: 'body.weight',
      comparator: 'at_least',
      targetValue: 'heavier',
      unit: 'kg',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('goal_target_value_invalid');
  });
});

describe('describing a target', () => {
  const target = (overrides: Partial<GoalTarget>): GoalTarget => ({
    id: 't',
    goalId: 'g',
    metricKey: 'body.weight',
    comparator: 'at_least',
    targetValue: '80.000000',
    unit: 'kg',
    windowDays: null,
    ...overrides,
  });

  /** `numeric(20,6)` returns `80.000000`; nobody says that out loud. */
  it('trims the storage zeros', () => {
    expect(describeTarget(target({}))).toBe('at least 80 kg');
    expect(describeTarget(target({ comparator: 'at_most' }))).toBe('at most 80 kg');
  });

  /** Nobody thinks in kilograms per day, and nobody would have typed 0.036. */
  it('renders a rate per week, with its window', () => {
    expect(
      describeTarget(target({ comparator: 'rate_of_change', targetValue: '0.25', windowDays: 28 })),
    ).toBe('0.25 kg per week over 28 days');
  });
});

describe('snapshots', () => {
  const target: GoalTarget = {
    id: 't1',
    goalId: 'g1',
    metricKey: 'body.weight',
    comparator: 'at_least',
    targetValue: '76',
    unit: 'kg',
    windowDays: null,
  };

  const series = Array.from({ length: 20 }, (_, index) => ({
    dayKey: `2026-11-${String(index + 1).padStart(2, '0')}`,
    value: 74 + 0.1 * index,
  }));

  it('records the believed trajectory, with the projection anchored at noon', () => {
    const progress = deriveProgress({ target, series, horizonDayKey: null, todayDayKey: '2026-11-20' });
    const snapshot = planSnapshot('s1', 'g1', target, progress, '2026-11-20T22:00:00.000Z');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.goalTargetId).toBe('t1');
    // Noon, for the same DST reason every other day-anchored instant uses it.
    expect(snapshot?.projectedAt?.endsWith('T12:00:00.000Z')).toBe(true);
    // A fit, not a likelihood — and in range.
    const confidence = Number(snapshot?.projectionConfidence);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  /**
   * A snapshot of "we could not say" reads as a measurement of zero in six
   * months. The absence of a row is already the honest record.
   */
  it('writes nothing when progress is insufficient', () => {
    const progress = deriveProgress({
      target,
      series: series.slice(0, MIN_TREND_POINTS - 2),
      horizonDayKey: null,
      todayDayKey: '2026-11-20',
    });
    expect(planSnapshot('s1', 'g1', target, progress, '2026-11-20T22:00:00.000Z')).toBeNull();
  });

  /** `(1e-7).toString()` is `"1e-7"`, which Postgres `numeric` rejects. */
  it('never emits exponential notation, which numeric() will not take', () => {
    const huge = { ...target, targetValue: '10000000' };
    const tiny = deriveProgress({
      target: huge,
      series: series.map((point, index) => ({ dayKey: point.dayKey, value: 0.0000001 * (index + 1) })),
      horizonDayKey: null,
      todayDayKey: '2026-11-20',
    });
    const snapshot = planSnapshot('s1', 'g1', huge, tiny, '2026-11-20T22:00:00.000Z');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.currentValue).not.toContain('e');
    expect(snapshot?.progressRatio).not.toContain('e');
  });

  it('reports drift between two beliefs without explaining it away', () => {
    const drift = snapshotDrift(
      { id: 'a', goalId: 'g', goalTargetId: 't', takenAt: '2026-11-01T00:00:00.000Z', currentValue: '74', progressRatio: '0.90', projectedAt: '2026-12-01T12:00:00.000Z', projectionConfidence: '0.9' },
      { id: 'b', goalId: 'g', goalTargetId: 't', takenAt: '2026-11-20T00:00:00.000Z', currentValue: '75', progressRatio: '0.95', projectedAt: '2026-12-20T12:00:00.000Z', projectionConfidence: '0.9' },
    );
    expect(drift.ratioDelta).toBeCloseTo(0.05, 5);
    expect(drift.arrivalMoved).toBe(true);
  });
});

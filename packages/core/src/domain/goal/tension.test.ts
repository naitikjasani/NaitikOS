import { describe, expect, it } from 'vitest';

import { detectTensions } from './tension';
import type { Goal, GoalTarget } from './target';

function goal(id: string, title: string, status: Goal['status'] = 'active'): Goal {
  return {
    id,
    title,
    description: null,
    status,
    startedAt: '2026-11-01T12:00:00.000Z',
    horizonAt: null,
    achievedAt: null,
    closingNote: null,
    supersedesGoalId: null,
  };
}

function target(overrides: Partial<GoalTarget> & Pick<GoalTarget, 'id' | 'goalId' | 'metricKey'>): GoalTarget {
  return {
    comparator: 'at_least',
    targetValue: '1',
    unit: '',
    windowDays: null,
    ...overrides,
  };
}

describe('direct tension', () => {
  it('finds two goals pulling one metric opposite ways', () => {
    const tensions = detectTensions(
      [goal('bulk', 'Build muscle'), goal('lean', 'Stay lean')],
      [
        target({ id: 'a', goalId: 'bulk', metricKey: 'body.weight', comparator: 'at_least', targetValue: '82' }),
        target({ id: 'b', goalId: 'lean', metricKey: 'body.weight', comparator: 'at_most', targetValue: '76' }),
      ],
    );

    expect(tensions).toHaveLength(1);
    expect(tensions[0]?.kind).toBe('direct');
    expect(tensions[0]?.claim).toContain('Build muscle');
    expect(tensions[0]?.claim).toContain('Stay lean');
    expect(tensions[0]?.reason).toContain('body.weight');
  });

  it('says nothing when both point the same way', () => {
    const tensions = detectTensions(
      [goal('a', 'A'), goal('b', 'B')],
      [
        target({ id: 'a', goalId: 'a', metricKey: 'body.weight', comparator: 'at_least', targetValue: '80' }),
        target({ id: 'b', goalId: 'b', metricKey: 'body.weight', comparator: 'at_least', targetValue: '85' }),
      ],
    );
    expect(tensions).toEqual([]);
  });

  /** Two targets on one goal are the operator saying one thing two ways. */
  it('never reports a goal in tension with itself', () => {
    const tensions = detectTensions(
      [goal('one', 'One goal')],
      [
        target({ id: 'a', goalId: 'one', metricKey: 'body.weight', comparator: 'at_least', targetValue: '82' }),
        target({ id: 'b', goalId: 'one', metricKey: 'body.weight', comparator: 'at_most', targetValue: '84' }),
      ],
    );
    expect(tensions).toEqual([]);
  });
});

describe('antagonistic tension', () => {
  /** §4.10's named case, verbatim: "a bulk and a visible-abs goal are in tension". */
  it('finds the bulk against the visible-abs goal', () => {
    const tensions = detectTensions(
      [goal('bulk', 'Build muscle'), goal('abs', 'Visible abs')],
      [
        target({ id: 'a', goalId: 'bulk', metricKey: 'nutrition.energy', comparator: 'at_least', targetValue: '3200' }),
        target({ id: 'b', goalId: 'abs', metricKey: 'body.fat_percentage', comparator: 'at_most', targetValue: '12' }),
      ],
    );

    expect(tensions).toHaveLength(1);
    expect(tensions[0]?.kind).toBe('antagonistic');
    expect(tensions[0]?.reason).toContain('surplus');
  });

  it('finds it whichever order the targets arrive in', () => {
    const forward = detectTensions(
      [goal('bulk', 'Bulk'), goal('abs', 'Abs')],
      [
        target({ id: 'a', goalId: 'bulk', metricKey: 'nutrition.energy', comparator: 'at_least', targetValue: '3200' }),
        target({ id: 'b', goalId: 'abs', metricKey: 'body.fat_percentage', comparator: 'at_most', targetValue: '12' }),
      ],
    );
    const reverse = detectTensions(
      [goal('abs', 'Abs'), goal('bulk', 'Bulk')],
      [
        target({ id: 'b', goalId: 'abs', metricKey: 'body.fat_percentage', comparator: 'at_most', targetValue: '12' }),
        target({ id: 'a', goalId: 'bulk', metricKey: 'nutrition.energy', comparator: 'at_least', targetValue: '3200' }),
      ],
    );
    expect(forward[0]?.id).toBe(reverse[0]?.id);
  });

  it('is not triggered when the directions agree', () => {
    const tensions = detectTensions(
      [goal('cut', 'Cut'), goal('abs', 'Abs')],
      [
        target({ id: 'a', goalId: 'cut', metricKey: 'nutrition.energy', comparator: 'at_most', targetValue: '2200' }),
        target({ id: 'b', goalId: 'abs', metricKey: 'body.fat_percentage', comparator: 'at_most', targetValue: '12' }),
      ],
    );
    expect(tensions).toEqual([]);
  });
});

describe('what is excluded', () => {
  /**
   * A paused or abandoned goal is not being pursued. Reporting it would turn
   * goal archaeology into a nagging surface, which §14.1's no-guilt rule
   * forbids.
   */
  it('ignores goals that are not active', () => {
    for (const status of ['paused', 'abandoned', 'achieved', 'superseded'] as const) {
      const tensions = detectTensions(
        [goal('bulk', 'Bulk'), goal('lean', 'Lean', status)],
        [
          target({ id: 'a', goalId: 'bulk', metricKey: 'body.weight', comparator: 'at_least', targetValue: '82' }),
          target({ id: 'b', goalId: 'lean', metricKey: 'body.weight', comparator: 'at_most', targetValue: '76' }),
        ],
      );
      expect(tensions, status).toEqual([]);
    }
  });

  it('ignores a target whose goal is not in the list at all', () => {
    const tensions = detectTensions(
      [goal('bulk', 'Bulk')],
      [
        target({ id: 'a', goalId: 'bulk', metricKey: 'body.weight', comparator: 'at_least', targetValue: '82' }),
        target({ id: 'b', goalId: 'ghost', metricKey: 'body.weight', comparator: 'at_most', targetValue: '76' }),
      ],
    );
    expect(tensions).toEqual([]);
  });
});

describe('rate direction', () => {
  /**
   * "At least −0.5 kg/week" is a cut. Reading its `at_least` as "up" would
   * report a cut and a bulk as compatible, which is the whole failure.
   */
  it('takes its direction from the sign of the rate, not the comparator', () => {
    const tensions = detectTensions(
      [goal('bulk', 'Bulk'), goal('cut', 'Cut')],
      [
        target({
          id: 'a',
          goalId: 'bulk',
          metricKey: 'body.weight',
          comparator: 'rate_of_change',
          targetValue: '0.25',
          windowDays: 28,
        }),
        target({
          id: 'b',
          goalId: 'cut',
          metricKey: 'body.weight',
          comparator: 'rate_of_change',
          targetValue: '-0.5',
          windowDays: 28,
        }),
      ],
    );
    expect(tensions).toHaveLength(1);
    expect(tensions[0]?.kind).toBe('direct');
  });
});

describe('ids', () => {
  it('are stable across runs, so re-deriving does not duplicate', () => {
    const build = () =>
      detectTensions(
        [goal('bulk', 'Bulk'), goal('lean', 'Lean')],
        [
          target({ id: 'a', goalId: 'bulk', metricKey: 'body.weight', comparator: 'at_least', targetValue: '82' }),
          target({ id: 'b', goalId: 'lean', metricKey: 'body.weight', comparator: 'at_most', targetValue: '76' }),
        ],
      );
    expect(build()[0]?.id).toBe(build()[0]?.id);
  });
});

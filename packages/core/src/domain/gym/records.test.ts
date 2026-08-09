import { describe, expect, it } from 'vitest';

import { formatDecimal, parseDecimal } from '../../units/decimal';
import type { Exercise } from './exercise';
import {
  MAX_ESTIMABLE_REPS,
  NO_HISTORY,
  bestFrom,
  detectRecords,
  estimateOneRepMax,
  relativeStrength,
} from './records';

const bench: Pick<Exercise, 'isBodyweight'> = { isBodyweight: false };
const pullUp: Pick<Exercise, 'isBodyweight'> = { isBodyweight: true };

function decimal(value: string) {
  const parsed = parseDecimal(value);
  if (parsed === null) throw new Error(`bad fixture: ${value}`);
  return parsed;
}

function show(value: { unscaled: bigint; scale: number } | null): string | null {
  return value === null ? null : formatDecimal(value, { trim: true });
}

describe('estimateOneRepMax', () => {
  it('returns the load itself for a single', () => {
    expect(show(estimateOneRepMax(decimal('100'), 1))).toBe('100');
  });

  it('applies Epley exactly', () => {
    // 100 × (1 + 5/30) = 116.666667 to six places.
    expect(show(estimateOneRepMax(decimal('100'), 5))).toBe('116.666667');
    // 60 × (1 + 10/30) = 80 exactly.
    expect(show(estimateOneRepMax(decimal('60'), 10))).toBe('80');
  });

  /**
   * The ceiling that stops the app congratulating the operator on a lift nobody
   * could perform. Every rep-max formula is fitted to roughly one to ten reps.
   */
  it('refuses to estimate above the rep ceiling', () => {
    expect(estimateOneRepMax(decimal('60'), MAX_ESTIMABLE_REPS)).not.toBeNull();
    expect(estimateOneRepMax(decimal('60'), MAX_ESTIMABLE_REPS + 1)).toBeNull();
    expect(estimateOneRepMax(decimal('60'), 30)).toBeNull();
  });

  it('refuses nonsense inputs rather than producing a number', () => {
    expect(estimateOneRepMax(decimal('60'), 0)).toBeNull();
    expect(estimateOneRepMax(decimal('60'), -1)).toBeNull();
    expect(estimateOneRepMax(decimal('60'), 2.5)).toBeNull();
    expect(estimateOneRepMax(decimal('0'), 5)).toBeNull();
    expect(estimateOneRepMax(decimal('-60'), 5)).toBeNull();
  });
});

describe('bestFrom', () => {
  it('folds a history into its bests', () => {
    const best = bestFrom(
      [
        { kind: 'working', load: '60', reps: 8 },
        { kind: 'working', load: '70', reps: 5 },
        { kind: 'working', load: '70', reps: 6 },
      ],
      bench,
      null,
    );

    expect(show(best.load)).toBe('70');
    expect(best.repsAtBestLoad).toBe(6);
    // 70 × (1 + 6/30) = 84.
    expect(show(best.e1rm)).toBe('84');
    expect(best.hasHistory).toBe(true);
  });

  it('ignores warm-ups', () => {
    const best = bestFrom(
      [
        { kind: 'warmup', load: '100', reps: 1 },
        { kind: 'working', load: '60', reps: 8 },
      ],
      bench,
      null,
    );
    expect(show(best.load)).toBe('60');
  });

  it('resolves bodyweight movements against the session bodyweight', () => {
    const best = bestFrom([{ kind: 'working', load: '10', reps: 5 }], pullUp, '74');
    expect(show(best.load)).toBe('84');
  });

  it('reports no history when nothing qualifies', () => {
    expect(bestFrom([{ kind: 'warmup', load: '60', reps: 8 }], bench, null)).toEqual(NO_HISTORY);
    // A bodyweight movement with no bodyweight cannot establish a record either.
    expect(bestFrom([{ kind: 'working', load: '10', reps: 5 }], pullUp, null).hasHistory).toBe(false);
  });
});

describe('detectRecords', () => {
  const history = bestFrom(
    [
      { kind: 'working', load: '60', reps: 8 },
      { kind: 'working', load: '70', reps: 5 },
    ],
    bench,
    null,
  );

  it('flags a heavier load', () => {
    const verdict = detectRecords({ kind: 'working', load: '75', reps: 3 }, history, bench, null);
    expect(verdict.kinds).toContain('load');
    expect(verdict.isFirst).toBe(false);
  });

  it('flags more reps at the same weight', () => {
    const verdict = detectRecords({ kind: 'working', load: '70', reps: 6 }, history, bench, null);
    expect(verdict.kinds).toContain('reps');
    expect(verdict.kinds).toContain('e1rm');
    expect(verdict.kinds).not.toContain('load');
  });

  /**
   * The deload guard. Twelve reps at half the weight is not a rep record, and
   * without this the badge fires on exactly the week it should be silent.
   */
  it('does not call a light high-rep set a rep record', () => {
    const verdict = detectRecords({ kind: 'working', load: '40', reps: 12 }, history, bench, null);
    expect(verdict.kinds).not.toContain('reps');
    expect(verdict.kinds).not.toContain('load');
  });

  it('flags an estimated max that beats the previous one across rep ranges', () => {
    // 65 × 8 estimates 82.3; the best so far is 70 × 5 = 81.67.
    const verdict = detectRecords({ kind: 'working', load: '65', reps: 8 }, history, bench, null);
    expect(verdict.kinds).toEqual(['e1rm']);
  });

  it('treats equalling a best as a good session, not a record', () => {
    const verdict = detectRecords({ kind: 'working', load: '70', reps: 5 }, history, bench, null);
    expect(verdict.kinds).toEqual([]);
  });

  it('never awards a record to a warm-up', () => {
    const verdict = detectRecords({ kind: 'warmup', load: '200', reps: 1 }, history, bench, null);
    expect(verdict.kinds).toEqual([]);
  });

  /**
   * Everything is a record the first time. Badging it "PR" is noise that
   * teaches the operator to ignore the badge, so the first set says so instead.
   */
  it('marks a first-ever set as first rather than as three records', () => {
    const verdict = detectRecords({ kind: 'working', load: '60', reps: 8 }, NO_HISTORY, bench, null);
    expect(verdict.isFirst).toBe(true);
    expect(verdict.kinds).toEqual([]);
    expect(show(verdict.estimatedOneRepMax)).toBe('76');
  });

  it('awards nothing when a bodyweight movement has no bodyweight to resolve', () => {
    expect(detectRecords({ kind: 'working', load: '20', reps: 10 }, history, pullUp, null).kinds).toEqual([]);
  });

  it('reports the estimate even when no record was broken', () => {
    const verdict = detectRecords({ kind: 'working', load: '50', reps: 5 }, history, bench, null);
    expect(verdict.kinds).toEqual([]);
    expect(show(verdict.estimatedOneRepMax)).toBe('58.333333');
  });

  it('has no estimate for a set above the rep ceiling, and still checks load', () => {
    const verdict = detectRecords({ kind: 'working', load: '80', reps: 20 }, history, bench, null);
    expect(verdict.estimatedOneRepMax).toBeNull();
    expect(verdict.kinds).toEqual(['load', 'reps']);
  });
});

describe('relativeStrength', () => {
  it('expresses load as a multiple of bodyweight', () => {
    expect(show(relativeStrength(decimal('100'), '74'))).toBe('1.35');
  });

  it('refuses when bodyweight is unknown or impossible', () => {
    expect(relativeStrength(decimal('100'), null)).toBeNull();
    expect(relativeStrength(decimal('100'), '0')).toBeNull();
    expect(relativeStrength(decimal('100'), 'heavy')).toBeNull();
  });
});

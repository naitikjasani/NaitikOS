import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../../units/decimal';
import type { Exercise } from './exercise';
import { SECONDARY_MUSCLE_SHARE, sessionVolume, setVolume, setsByMuscle, volumeByMuscle } from './volume';

function exercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex-bench',
    name: 'Barbell Bench Press',
    slug: 'barbell-bench-press',
    aliases: [],
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
    instructions: null,
    formNotes: null,
    ...overrides,
  };
}

const pullUp = exercise({
  id: 'ex-pullup',
  name: 'Pull-Up',
  primaryMuscle: 'back',
  secondaryMuscles: ['biceps'],
  equipment: 'bodyweight',
  isBodyweight: true,
});

function set(overrides: Partial<{ exerciseId: string; kind: string; load: string | null; reps: number | null }> = {}) {
  return {
    exerciseId: 'ex-bench',
    kind: 'working' as const,
    load: '60',
    reps: 8,
    ...overrides,
  } as { exerciseId: string; kind: 'working'; load: string | null; reps: number | null };
}

const lookup = (id: string): Exercise | null =>
  id === 'ex-bench' ? exercise() : id === 'ex-pullup' ? pullUp : null;

describe('setVolume', () => {
  it('multiplies load by reps, exactly', () => {
    const result = setVolume({ kind: 'working', load: '62.5', reps: 8 }, exercise(), null);
    expect(result.counted).toBe(true);
    // 62.5 × 8 = 500 exactly. In binary floating point this is fine; the point
    // is that the arithmetic never leaves Decimal on the way to the record.
    if (result.counted) expect(formatDecimal(result.volume, { trim: true })).toBe('500');
  });

  it('is exact where a float would not be', () => {
    // 0.1 + 0.2 style: 100.1 × 3 is 300.29999999999995 in float.
    const result = setVolume({ kind: 'working', load: '100.1', reps: 3 }, exercise(), null);
    if (!result.counted) throw new Error('expected a counted set');
    expect(formatDecimal(result.volume, { trim: true })).toBe('300.3');
  });

  it('excludes warm-ups', () => {
    const result = setVolume({ kind: 'warmup', load: '40', reps: 10 }, exercise(), null);
    expect(result).toEqual({ counted: false, reason: 'warmup' });
  });

  it('counts drop, backoff, failure and amrap sets as real work', () => {
    for (const kind of ['drop', 'backoff', 'failure', 'amrap'] as const) {
      expect(setVolume({ kind, load: '40', reps: 10 }, exercise(), null).counted).toBe(true);
    }
  });

  it('adds bodyweight for a bodyweight movement', () => {
    // A +10 kg pull-up at 74 kg bodyweight is 84 kg per rep, not 10.
    const result = setVolume({ kind: 'working', load: '10', reps: 8 }, pullUp, '74');
    if (!result.counted) throw new Error('expected a counted set');
    expect(formatDecimal(result.effectiveLoad, { trim: true })).toBe('84');
    expect(formatDecimal(result.volume, { trim: true })).toBe('672');
  });

  it('treats an unweighted bodyweight set as bodyweight, not as zero', () => {
    const result = setVolume({ kind: 'working', load: null, reps: 8 }, pullUp, '74');
    if (!result.counted) throw new Error('expected a counted set');
    expect(formatDecimal(result.volume, { trim: true })).toBe('592');
  });

  /**
   * The decision this file is built around. Zero would understate a pull-up day
   * by an order of magnitude; the last known weigh-in would attribute today's
   * bodyweight to a session six weeks ago. Neither is acceptable, so the set is
   * excluded and counted.
   */
  it('refuses to guess when a bodyweight movement has no bodyweight', () => {
    expect(setVolume({ kind: 'working', load: '10', reps: 8 }, pullUp, null)).toEqual({
      counted: false,
      reason: 'bodyweight_unknown',
    });
  });

  it('excludes a set with no reps', () => {
    expect(setVolume({ kind: 'working', load: '60', reps: null }, exercise(), null)).toEqual({
      counted: false,
      reason: 'incomplete',
    });
    expect(setVolume({ kind: 'working', load: '60', reps: 0 }, exercise(), null)).toEqual({
      counted: false,
      reason: 'incomplete',
    });
  });
});

describe('sessionVolume', () => {
  it('sums the counted sets and reports what it left out', () => {
    const result = sessionVolume(
      [
        set({ kind: 'warmup', load: '40', reps: 10 }),
        set({ load: '60', reps: 8 }),
        set({ load: '60', reps: 8 }),
        set({ exerciseId: 'ex-pullup', load: '0', reps: 6 }),
        set({ exerciseId: 'ex-unknown' }),
      ],
      lookup,
      null,
    );

    expect(formatDecimal(result.total, { trim: true })).toBe('960');
    expect(result.countedSets).toBe(2);
    expect(result.totalReps).toBe(16);
    expect(result.excluded).toEqual({ warmup: 1, incomplete: 1, bodyweight_unknown: 1 });
  });

  it('is zero, with nothing counted, for a session of warm-ups', () => {
    const result = sessionVolume([set({ kind: 'warmup' })], lookup, null);
    expect(formatDecimal(result.total, { trim: true })).toBe('0');
    expect(result.countedSets).toBe(0);
  });
});

describe('volumeByMuscle', () => {
  it('gives the primary muscle the full set and each secondary a share', () => {
    const attributed = volumeByMuscle([set({ load: '60', reps: 8 })], lookup, null);

    expect(formatDecimal(attributed.get('chest') ?? { unscaled: 0n, scale: 0 }, { trim: true })).toBe('480');
    expect(formatDecimal(attributed.get('triceps') ?? { unscaled: 0n, scale: 0 }, { trim: true })).toBe('240');
    expect(formatDecimal(attributed.get('shoulders') ?? { unscaled: 0n, scale: 0 }, { trim: true })).toBe('240');
    expect(SECONDARY_MUSCLE_SHARE).toBe('0.5');
  });

  /**
   * A data-entry mistake that would otherwise pay a muscle 1.5× — and it is an
   * easy one to make, because "chest" is a plausible thing to list twice.
   */
  it('does not pay a muscle twice when it is listed as both primary and secondary', () => {
    const odd = exercise({ id: 'ex-odd', primaryMuscle: 'chest', secondaryMuscles: ['chest', 'triceps'] });
    const attributed = volumeByMuscle(
      [set({ exerciseId: 'ex-odd', load: '60', reps: 8 })],
      (id) => (id === 'ex-odd' ? odd : null),
      null,
    );
    expect(formatDecimal(attributed.get('chest') ?? { unscaled: 0n, scale: 0 }, { trim: true })).toBe('480');
  });

  /**
   * Documented, not a bug: attributed volume is not a partition of the session
   * total, and normalising it would understate every compound movement.
   */
  it('sums across muscles to more than the session total', () => {
    const sets = [set({ load: '60', reps: 8 })];
    const total = Number(formatDecimal(sessionVolume(sets, lookup, null).total));
    const attributed = [...volumeByMuscle(sets, lookup, null).values()].reduce(
      (sum, value) => sum + Number(formatDecimal(value)),
      0,
    );
    expect(attributed).toBeGreaterThan(total);
  });
});

describe('setsByMuscle', () => {
  it('counts working sets per primary muscle, whole', () => {
    const counts = setsByMuscle(
      [
        set(),
        set(),
        set({ kind: 'warmup' }),
        set({ exerciseId: 'ex-pullup' }),
      ],
      lookup,
    );
    expect(counts.get('chest')).toBe(2);
    expect(counts.get('back')).toBe(1);
    // No fractional sets: a secondary muscle does not earn half a set.
    expect(counts.get('triceps')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import type { DailyEstimate } from '../../statistics/types';
import { MIND_SCALES, MIN_MOVEMENT_DAYS, describeMovement, scaleLabel, toneFor } from './scales';

function series(values: readonly (number | null)[], startDay = 1): DailyEstimate[] {
  return values.map((value, index) => ({
    dayKey: `2026-06-${String(startDay + index).padStart(2, '0')}`,
    value,
  }));
}

describe('scaleLabel', () => {
  it('labels every point of every scale', () => {
    for (const scale of Object.values(MIND_SCALES)) {
      for (let value = 1; value <= 5; value += 1) {
        expect(scaleLabel(scale.id, value)).toBe(scale.labels[value - 1]);
      }
    }
  });

  it('returns null outside the scale rather than clamping', () => {
    expect(scaleLabel('mood', 0)).toBeNull();
    expect(scaleLabel('mood', 6)).toBeNull();
    expect(scaleLabel('mood', 3.5)).toBeNull();
  });
});

describe('toneFor', () => {
  it('inverts for anxiety, because down is better there', () => {
    expect(toneFor('mood', 5)).toBe('accent');
    expect(toneFor('anxiety', 5)).toBe('attention');
    expect(toneFor('anxiety', 1)).toBe('accent');
  });

  it('never returns an alarm tone — §4.7 forbids one', () => {
    const tones = new Set<string>();
    for (const scale of ['mood', 'energy', 'anxiety'] as const) {
      for (let value = 1; value <= 5; value += 1) tones.add(toneFor(scale, value));
    }
    expect([...tones].sort()).toEqual(['accent', 'attention', 'neutral']);
  });

  it('is neutral for anything off the scale', () => {
    expect(toneFor('mood', 0)).toBe('neutral');
    expect(toneFor('mood', 2.5)).toBe('neutral');
  });
});

describe('describeMovement', () => {
  it('reports the §4.7 sentence shape with both figures', () => {
    const points = series([...Array<number>(28).fill(4), ...Array<number>(7).fill(2)]);
    const movement = describeMovement('mood', points);

    expect(movement.direction).toBe('down');
    expect(movement.recent).toBeCloseTo(2, 10);
    expect(movement.baseline).toBeCloseTo(4, 10);
    expect(movement.sentence).toBe(
      'Mood has averaged 2.0 over the last 7 recorded days, against a baseline of 4.0.',
    );
  });

  it('calls a sub-threshold difference flat rather than a movement', () => {
    const points = series([...Array<number>(28).fill(3), 3, 3, 3, 3, 3, 3.2, 3.2]);
    const movement = describeMovement('mood', points);
    expect(movement.direction).toBe('flat');
    expect(movement.sentence).toContain('level with a baseline');
  });

  it('does not count gap days towards the minimum', () => {
    // Ten calendar days, only two with a reading on each side.
    const points = series([4, null, null, null, null, 4, null, null, 2, 2]);
    const movement = describeMovement('mood', points, { recentDays: 5, baselineDays: 5 });
    expect(movement.direction).toBe('unknown');
    expect(movement.delta).toBeNull();
    expect(movement.sentence).toContain('Not enough recorded days');
  });

  it('reports movement once each side clears the minimum', () => {
    const points = series([
      ...Array<number>(MIN_MOVEMENT_DAYS).fill(2),
      ...Array<number>(MIN_MOVEMENT_DAYS).fill(4),
    ]);
    const movement = describeMovement('anxiety', points, {
      recentDays: MIN_MOVEMENT_DAYS,
      baselineDays: MIN_MOVEMENT_DAYS,
    });
    expect(movement.direction).toBe('up');
    expect(movement.delta).toBeCloseTo(2, 10);
  });

  it('sorts before slicing, so out-of-order input gives the same answer', () => {
    const ordered = series([...Array<number>(10).fill(2), ...Array<number>(4).fill(5)]);
    const shuffled = [...ordered].reverse();
    expect(describeMovement('energy', shuffled, { recentDays: 4, baselineDays: 10 })).toEqual(
      describeMovement('energy', ordered, { recentDays: 4, baselineDays: 10 }),
    );
  });
});

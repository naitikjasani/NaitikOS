import { describe, expect, it } from 'vitest';

import type { PracticeInput } from './practice';
import { MAX_PRACTICE_MINUTES, isPracticeKind, planPractice, practiceDelta } from './practice';

function input(overrides: Partial<PracticeInput> = {}): PracticeInput {
  return {
    id: 'ps-1',
    kind: 'meditation',
    startedAt: '2026-08-24T05:30:00.000Z',
    zone: 'Asia/Kolkata',
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof planPractice>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('practiceDelta', () => {
  it('is null when either end is missing, not zero', () => {
    expect(practiceDelta({ stateBefore: 2, stateAfter: null })).toBeNull();
    expect(practiceDelta({ stateBefore: null, stateAfter: 4 })).toBeNull();
  });

  it('is zero only when both were answered and matched', () => {
    expect(practiceDelta({ stateBefore: 3, stateAfter: 3 })).toBe(0);
    expect(practiceDelta({ stateBefore: 2, stateAfter: 4 })).toBe(2);
  });
});

describe('planPractice', () => {
  it('writes a duration observation subject-referenced to the session', () => {
    const planned = unwrap(
      planPractice(
        // eslint-disable-next-line @naitikos/no-bare-quantity -- minutes, stated by the field name and by the registry (canonicalUnit: 'minutes').
        input({ durationMinutes: 12 }),
      ),
    );
    expect(planned.observations).toHaveLength(1);
    expect(planned.observations[0]).toMatchObject({
      metricKey: 'mind.practice.duration',
      value: { kind: 'number', value: '12', unit: 'minutes' },
      subject: { type: 'practice_session', id: 'ps-1' },
      context: { kind: 'meditation' },
    });
  });

  it('writes no observation without a duration', () => {
    expect(unwrap(planPractice(input())).observations).toEqual([]);
  });

  it.each([
    ['practice_kind_unknown', input({ kind: 'yoga' })],
    ['practice_started_at_invalid', input({ startedAt: 'this morning' })],
    ['practice_zone_invalid', input({ zone: 'IST' })],
    ['practice_duration_range', input({ durationMinutes: 0 })],
    ['practice_duration_range', input({ durationMinutes: MAX_PRACTICE_MINUTES + 1 })],
    ['practice_state_range', input({ stateBefore: 6 })],
    ['practice_state_range', input({ stateAfter: 0 })],
  ])('rejects with %s', (code, candidate) => {
    const result = planPractice(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('trims the method and the note', () => {
    const planned = unwrap(planPractice(input({ method: '  Waking Up  ', note: '   ' })));
    expect(planned.practice.method).toBe('Waking Up');
    expect(planned.practice.note).toBeNull();
  });
});

describe('isPracticeKind', () => {
  it('accepts the vocabulary and nothing else', () => {
    expect(isPracticeKind('breathwork')).toBe(true);
    expect(isPracticeKind('sauna')).toBe(false);
  });
});

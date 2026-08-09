import { describe, expect, it } from 'vitest';

import type { Exercise } from './exercise';
import {
  EMPTY_PREFILL,
  lastSessionFor,
  prefillFor,
  progressionBySession,
  progressionSeries,
  type HistoricalSet,
} from './progression';

const bench: Pick<Exercise, 'isBodyweight'> = { isBodyweight: false };

function historical(overrides: Partial<HistoricalSet> = {}): HistoricalSet {
  return {
    sessionId: 'session-1',
    setId: 'set-1',
    exerciseId: 'ex-bench',
    performedAt: '2026-08-10T12:00:00.000Z',
    zone: 'Asia/Kolkata',
    orderIndex: 0,
    kind: 'working',
    load: '60',
    loadUnit: 'kg',
    reps: 8,
    rpe: null,
    side: null,
    bodyweightKg: '74',
    ...overrides,
  };
}

/** Two sessions: 10 August (60 kg) and 17 August (62.5 kg). */
const history: HistoricalSet[] = [
  historical({ setId: 'a1', sessionId: 's1', performedAt: '2026-08-10T12:00:00.000Z', orderIndex: 0, kind: 'warmup', load: '40', reps: 10 }),
  historical({ setId: 'a2', sessionId: 's1', performedAt: '2026-08-10T12:05:00.000Z', orderIndex: 1, load: '60', reps: 8 }),
  historical({ setId: 'a3', sessionId: 's1', performedAt: '2026-08-10T12:10:00.000Z', orderIndex: 2, load: '60', reps: 7 }),
  historical({ setId: 'b1', sessionId: 's2', performedAt: '2026-08-17T12:00:00.000Z', orderIndex: 0, kind: 'warmup', load: '40', reps: 10 }),
  historical({ setId: 'b2', sessionId: 's2', performedAt: '2026-08-17T12:05:00.000Z', orderIndex: 1, load: '62.5', reps: 8 }),
  historical({ setId: 'b3', sessionId: 's2', performedAt: '2026-08-17T12:10:00.000Z', orderIndex: 2, load: '62.5', reps: 6 }),
];

describe('lastSessionFor', () => {
  it('returns the most recent session, in order', () => {
    const sets = lastSessionFor(history, 'ex-bench');
    expect(sets.map((set) => set.setId)).toEqual(['b1', 'b2', 'b3']);
  });

  it('can exclude the session in progress', () => {
    expect(lastSessionFor(history, 'ex-bench', 's2').map((set) => set.setId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns nothing for an exercise never performed', () => {
    expect(lastSessionFor(history, 'ex-squat')).toEqual([]);
  });
});

describe('prefillFor', () => {
  /**
   * §4.1: "the primary interaction is confirming or nudging rather than
   * typing." This is that requirement, as a test.
   */
  it('offers last session’s numbers, matched by position', () => {
    expect(prefillFor(history, 'ex-bench', 0, 'working', { excludeSessionId: 's2' })).toEqual({
      load: '60',
      loadUnit: 'kg',
      reps: 8,
      rpe: null,
      source: 'last_session',
      fromSessionId: 's1',
      fromDayKey: '2026-08-10',
    });

    expect(prefillFor(history, 'ex-bench', 1, 'working', { excludeSessionId: 's2' }).reps).toBe(7);
  });

  it('repeats the final set when this session runs longer than the last', () => {
    const prefill = prefillFor(history, 'ex-bench', 5, 'working', { excludeSessionId: 's2' });
    expect(prefill.reps).toBe(7);
    expect(prefill.source).toBe('last_set');
  });

  /**
   * The most annoying possible failure: tapping "add set" mid-session and being
   * offered the empty bar because position 0 of the previous session was a
   * warm-up.
   */
  it('never prefills a working set from a warm-up', () => {
    expect(prefillFor(history, 'ex-bench', 0, 'working', { excludeSessionId: 's2' }).load).toBe('60');
    expect(prefillFor(history, 'ex-bench', 0, 'warmup', { excludeSessionId: 's2' }).load).toBe('40');
  });

  /**
   * RPE is a judgement about *this* set. Copying last week's would turn the one
   * subjective field in the logger into a number nobody assessed.
   */
  it('does not prefill RPE', () => {
    const withRpe = history.map((set) => ({ ...set, rpe: '8.000000' }));
    expect(prefillFor(withRpe, 'ex-bench', 0).rpe).toBeNull();
  });

  it('offers nothing for a first-ever exercise', () => {
    expect(prefillFor(history, 'ex-squat', 0)).toEqual(EMPTY_PREFILL);
  });
});

describe('progressionBySession', () => {
  it('produces one point per session, oldest first', () => {
    const points = progressionBySession(history, bench);
    expect(points.map((point) => point.dayKey)).toEqual(['2026-08-10', '2026-08-17']);

    const first = points[0];
    expect(first?.workingSets).toBe(2);
    expect(first?.totalReps).toBe(15);
    // 60 × 8 + 60 × 7 = 900.
    expect(Number(first?.volume?.unscaled ?? 0n) / 10 ** (first?.volume?.scale ?? 0)).toBe(900);
    expect(first?.topLoadReps).toBe(8);
  });

  it('reports the top load and the reps performed at it', () => {
    const [, second] = progressionBySession(history, bench);
    expect(second?.topLoadReps).toBe(8);
    expect(Number(second?.topLoad?.unscaled ?? 0n) / 10 ** (second?.topLoad?.scale ?? 0)).toBe(62.5);
  });

  /**
   * A session that produced nothing countable still happened. Dropping it would
   * make the frequency chart claim a week was skipped that was not.
   */
  it('keeps a session whose sets were all warm-ups, with nulls', () => {
    const points = progressionBySession(
      [historical({ sessionId: 's9', kind: 'warmup', performedAt: '2026-08-24T12:00:00.000Z' })],
      bench,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.volume).toBeNull();
    expect(points[0]?.topLoad).toBeNull();
    expect(points[0]?.workingSets).toBe(0);
  });

  it('resolves a bodyweight movement against each session’s own bodyweight', () => {
    const points = progressionBySession(
      [
        historical({ sessionId: 's1', load: '0', reps: 5, bodyweightKg: '70', performedAt: '2026-08-10T12:00:00Z' }),
        historical({ sessionId: 's2', load: '0', reps: 5, bodyweightKg: '80', performedAt: '2026-08-17T12:00:00Z' }),
      ],
      { isBodyweight: true },
    );
    expect(Number(points[0]?.topLoad?.unscaled ?? 0n)).toBe(70);
    expect(Number(points[1]?.topLoad?.unscaled ?? 0n)).toBe(80);
  });
});

describe('progressionSeries', () => {
  it('drops null measures so the line breaks rather than interpolating', () => {
    const points = progressionBySession(
      [...history, historical({ sessionId: 's3', kind: 'warmup', performedAt: '2026-08-24T12:00:00Z' })],
      bench,
    );
    const series = progressionSeries(points, 'topLoad');
    expect(series.map((point) => point.dayKey)).toEqual(['2026-08-10', '2026-08-17']);
    expect(series[1]?.value).toBe(62.5);
  });
});

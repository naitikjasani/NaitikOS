import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../../units/decimal';
import type { Exercise } from './exercise';
import { NO_HISTORY, bestFrom } from './records';
import {
  GYM_METRICS,
  MAX_REPS,
  MAX_REST_SECONDS,
  SESSION_SUBJECT_TYPE,
  SET_SUBJECT_TYPE,
  planSessionClose,
  planSetLog,
  sessionDurationMinutes,
  type SetLogContext,
  type WorkoutSession,
  type WorkoutSet,
} from './session';

const bench: Exercise = {
  id: 'ex-bench',
  name: 'Barbell Bench Press',
  slug: 'barbell-bench-press',
  aliases: ['bench', 'bp'],
  primaryMuscle: 'chest',
  secondaryMuscles: ['triceps'],
  mechanic: 'compound',
  equipment: 'barbell',
  isBodyweight: false,
  isUnilateral: false,
  instructions: null,
  formNotes: null,
};

const lunge: Exercise = { ...bench, id: 'ex-lunge', name: 'Walking Lunge', isUnilateral: true };

let counter = 0;
function context(overrides: Partial<SetLogContext> = {}): SetLogContext {
  return {
    sessionId: 'session-1',
    exercise: bench,
    zone: 'Asia/Kolkata',
    performedAt: '2026-08-17T12:30:00.000Z',
    newId: () => `set-${String((counter += 1))}`,
    best: NO_HISTORY,
    bodyweightKg: null,
    ...overrides,
  };
}

describe('planSetLog', () => {
  it('produces the entity row and its observations from one submission', () => {
    const result = planSetLog(
      { exerciseId: 'ex-bench', orderIndex: 0, load: '60', reps: 8, rpe: '7.5' },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { set, observations } = result.value;
    expect(set.load).toBe('60.000000');
    expect(set.loadUnit).toBe('kg');
    expect(set.reps).toBe(8);
    expect(set.rpe).toBe('7.500000');
    expect(set.kind).toBe('working');

    expect(observations.map((o) => o.metricKey)).toEqual([
      GYM_METRICS.setLoad,
      GYM_METRICS.setReps,
      GYM_METRICS.setRpe,
    ]);
    // Every observation is subject-referenced to the set (§9.3(3)).
    for (const observation of observations) {
      expect(observation.subject).toEqual({ type: SET_SUBJECT_TYPE, id: set.id });
      expect(observation.observedZone).toBe('Asia/Kolkata');
    }
  });

  /**
   * §9.2 puts conversion "at the edges". A gym with pound plates types pounds;
   * the record holds kilograms; the display keeps the unit the operator used.
   */
  it('converts pounds to kilograms once, and remembers what was typed', () => {
    const result = planSetLog(
      { exerciseId: 'ex-bench', orderIndex: 0, load: '225', loadUnit: 'lb', reps: 5 },
      context(),
    );
    if (!result.ok) throw new Error('expected a set');

    expect(result.value.set.load).toBe('102.058283');
    expect(result.value.set.loadUnit).toBe('lb');
    const load = result.value.observations.find((o) => o.metricKey === GYM_METRICS.setLoad);
    expect(load?.value).toEqual({ kind: 'number', value: '102.058283', unit: 'kg' });
  });

  it('writes only the observations it was given values for', () => {
    const result = planSetLog({ exerciseId: 'ex-bench', orderIndex: 1, reps: 12 }, context());
    if (!result.ok) throw new Error('expected a set');
    expect(result.value.observations.map((o) => o.metricKey)).toEqual([GYM_METRICS.setReps]);
  });

  it('uses a client-supplied id so an offline set keeps its identity', () => {
    const result = planSetLog(
      { id: 'client-uuid', exerciseId: 'ex-bench', orderIndex: 0, reps: 5 },
      context(),
    );
    if (!result.ok) throw new Error('expected a set');
    expect(result.value.set.id).toBe('client-uuid');
  });

  it('flags a personal record from the exercise history', () => {
    const best = bestFrom([{ kind: 'working', load: '60', reps: 8 }], bench, null);
    const result = planSetLog(
      { exerciseId: 'ex-bench', orderIndex: 0, load: '65', reps: 8 },
      context({ best }),
    );
    if (!result.ok) throw new Error('expected a set');
    expect(result.value.set.isPersonalRecord).toBe(true);
    expect(result.value.records.kinds).toContain('load');
  });

  it('does not flag a first-ever set as a personal record', () => {
    const result = planSetLog({ exerciseId: 'ex-bench', orderIndex: 0, load: '60', reps: 8 }, context());
    if (!result.ok) throw new Error('expected a set');
    expect(result.value.set.isPersonalRecord).toBe(false);
    expect(result.value.records.isFirst).toBe(true);
  });

  describe('refusals', () => {
    const cases: readonly (readonly [string, Parameters<typeof planSetLog>[0], string])[] = [
      ['a fractional rep count', { exerciseId: 'ex-bench', orderIndex: 0, reps: 8.5 }, 'reps'],
      ['an implausible rep count', { exerciseId: 'ex-bench', orderIndex: 0, reps: MAX_REPS + 1 }, 'reps'],
      ['a negative weight', { exerciseId: 'ex-bench', orderIndex: 0, load: '-5', reps: 5 }, 'load'],
      ['a weight in an unknown unit', { exerciseId: 'ex-bench', orderIndex: 0, load: '5', loadUnit: 'stone', reps: 5 }, 'load'],
      ['RPE outside the scale', { exerciseId: 'ex-bench', orderIndex: 0, reps: 5, rpe: '11' }, 'rpe'],
      ['RPE at a precision nobody perceives', { exerciseId: 'ex-bench', orderIndex: 0, reps: 5, rpe: '7.25' }, 'rpe'],
      ['a rest longer than a session', { exerciseId: 'ex-bench', orderIndex: 0, reps: 5, restSeconds: MAX_REST_SECONDS + 1 }, 'restSeconds'],
      ['a negative position', { exerciseId: 'ex-bench', orderIndex: -1, reps: 5 }, 'orderIndex'],
    ];

    for (const [label, input, field] of cases) {
      it(`refuses ${label}`, () => {
        const result = planSetLog(input, context());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('validation');
        if (result.error.kind !== 'validation') return;
        expect(result.error.issues.some((problem) => problem.path.includes(field))).toBe(true);
      });
    }

    it('refuses a zone that is an offset rather than a zone', () => {
      const result = planSetLog(
        { exerciseId: 'ex-bench', orderIndex: 0, reps: 5 },
        context({ zone: '+05:30' }),
      );
      expect(result.ok).toBe(false);
    });

    /**
     * A side on a two-sided movement would make bench press look unilateral in
     * every per-side breakdown, and would double its chest volume for the
     * session — because `volume.ts` counts each logged set once.
     */
    it('refuses a side on a movement that has none', () => {
      expect(planSetLog({ exerciseId: 'ex-bench', orderIndex: 0, reps: 5, side: 'left' }, context()).ok).toBe(
        false,
      );
      expect(
        planSetLog(
          { exerciseId: 'ex-lunge', orderIndex: 0, reps: 5, side: 'left' },
          context({ exercise: lunge }),
        ).ok,
      ).toBe(true);
    });

    it('refuses a set validated against the wrong exercise', () => {
      expect(planSetLog({ exerciseId: 'ex-squat', orderIndex: 0, reps: 5 }, context()).ok).toBe(false);
    });
  });
});

describe('sessionDurationMinutes', () => {
  it('measures whole minutes', () => {
    expect(sessionDurationMinutes('2026-08-17T12:00:00Z', '2026-08-17T13:14:00Z')).toBe(74);
  });

  it('refuses a session that ends before it starts', () => {
    expect(sessionDurationMinutes('2026-08-17T13:00:00Z', '2026-08-17T12:00:00Z')).toBeNull();
    expect(sessionDurationMinutes('nonsense', '2026-08-17T12:00:00Z')).toBeNull();
  });
});

describe('planSessionClose', () => {
  const session: WorkoutSession = {
    id: 'session-1',
    programId: null,
    programBlockId: null,
    startedAt: '2026-08-17T12:00:00.000Z',
    endedAt: null,
    zone: 'Asia/Kolkata',
    title: null,
    location: null,
    perceivedEffort: null,
    notes: null,
    bodyweightAtSession: '74',
  };

  function workoutSet(overrides: Partial<WorkoutSet> = {}): WorkoutSet {
    return {
      id: 'set-1',
      sessionId: 'session-1',
      exerciseId: 'ex-bench',
      orderIndex: 0,
      kind: 'working',
      load: '60',
      loadUnit: 'kg',
      reps: 8,
      rpe: null,
      restSeconds: null,
      supersetGroup: null,
      side: null,
      performedAt: '2026-08-17T12:10:00.000Z',
      isPersonalRecord: false,
      notes: null,
      ...overrides,
    };
  }

  const exercises = (id: string): Exercise | null => (id === 'ex-bench' ? bench : null);

  it('derives volume and duration, both subject-referenced to the session', () => {
    const result = planSessionClose(session, [workoutSet(), workoutSet({ id: 'set-2', orderIndex: 1 })], {
      endedAt: '2026-08-17T13:15:00.000Z',
      exercises,
    });
    if (!result.ok) throw new Error('expected a plan');

    expect(result.value.session.endedAt).toBe('2026-08-17T13:15:00.000Z');
    expect(result.value.durationMinutes).toBe(75);
    expect(formatDecimal(result.value.volume.total, { trim: true })).toBe('960');
    expect(result.value.exerciseCount).toBe(1);

    const keys = result.value.observations.map((o) => o.metricKey);
    expect(keys).toEqual([GYM_METRICS.sessionVolume, GYM_METRICS.sessionDuration]);
    for (const observation of result.value.observations) {
      expect(observation.subject).toEqual({ type: SESSION_SUBJECT_TYPE, id: 'session-1' });
      // The day a session belongs to is the day it finished on.
      expect(observation.observedAt).toBe('2026-08-17T13:15:00.000Z');
    }
  });

  /**
   * Zero and absent are different facts. A session whose sets could not be
   * resolved has no volume figure; recording it as zero would drag every
   * weekly average down with a number nobody measured.
   */
  it('writes no volume observation when nothing could be counted', () => {
    const result = planSessionClose(session, [workoutSet({ kind: 'warmup' })], {
      endedAt: '2026-08-17T13:00:00.000Z',
      exercises,
    });
    if (!result.ok) throw new Error('expected a plan');

    expect(result.value.observations.map((o) => o.metricKey)).toEqual([GYM_METRICS.sessionDuration]);
    expect(result.value.volume.excluded.warmup).toBe(1);
  });

  it('records what it excluded, in the observation context', () => {
    const result = planSessionClose(session, [workoutSet(), workoutSet({ id: 'set-2', kind: 'warmup', orderIndex: 1 })], {
      endedAt: '2026-08-17T13:00:00.000Z',
      exercises,
    });
    if (!result.ok) throw new Error('expected a plan');

    const volume = result.value.observations.find((o) => o.metricKey === GYM_METRICS.sessionVolume);
    expect(volume?.context).toMatchObject({ countedSets: 1, secondaryMuscleShare: '0.5' });
  });

  it('refuses an end before the start', () => {
    const result = planSessionClose(session, [], { endedAt: '2026-08-17T11:00:00.000Z', exercises });
    expect(result.ok).toBe(false);
  });
});

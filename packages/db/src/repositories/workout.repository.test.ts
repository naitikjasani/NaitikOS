/**
 * Gym — integration, against real Postgres.
 *
 * `core/domain/gym/*.test.ts` covers what a set *means*. This covers what only
 * a database can answer:
 *
 *   - A set is one entity row **and** its observations, or it is neither.
 *   - A replayed write — which the offline outbox guarantees will happen — is a
 *     no-op rather than a duplicate or a conflict (§5.7).
 *   - A set that arrives before its session comes back as a *retryable*
 *     precondition, not a permanent rejection.
 *   - Closing a session twice does not move its end time.
 *   - The day a session belongs to is the day in *its own* zone (§5.3).
 *   - The seed is idempotent on the slug, and does not overwrite the one column
 *     the operator writes.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, uuidV7 } from '@naitikos/shared';
import type { Exercise, MetricRegistry, WorkoutSession } from '@naitikos/core';
import {
  GYM_METRICS,
  NO_HISTORY,
  bestFrom,
  initialHlcState,
  planSessionClose,
  planSetLog,
} from '@naitikos/core';

import { createDatabase } from '../client';
import { SEED_EXERCISES } from '../seed/exercises';
import { createExerciseRepository } from './exercise.repository';
import { createMetricRepository } from './metric.repository';
import { createObservationRepository } from './observation.repository';
import { SESSION_MISSING, createWorkoutRepository } from './workout.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_755_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

async function registry(): Promise<MetricRegistry> {
  if (db === undefined) throw new Error('no database');
  const result = await createMetricRepository(db).registry();
  if (!isOk(result)) throw new Error('registry unavailable');
  return result.value;
}

function writeContext(reg: MetricRegistry) {
  return {
    registry: reg,
    hlcState: initialHlcState(newId(), EPOCH),
    recordedAt: '2026-08-17T13:00:00.000Z',
    physicalMillis: EPOCH,
    newId,
  };
}

suite('gym repositories', () => {
  let bench: Exercise;
  let pullUp: Exercise;

  beforeEach(async () => {
    if (db === undefined) return;

    // The append-only trigger (§9.1) has to be lifted to clear the table, which
    // is itself evidence that it works.
    await db.$client`alter table observation disable trigger observation_append_only`;
    await db.$client`delete from workout_set`;
    await db.$client`delete from workout_session`;
    await db.$client`delete from observation`;
    await db.$client`alter table observation enable trigger observation_append_only`;
    await db.$client`delete from exercise`;

    const exercises = createExerciseRepository(db);
    const seeded = await exercises.upsert(SEED_EXERCISES);
    if (!isOk(seeded)) throw new Error('exercise seed failed');

    const benchResult = await exercises.bySlug('barbell-bench-press');
    const pullUpResult = await exercises.bySlug('pull-up');
    if (!isOk(benchResult) || !isOk(pullUpResult)) throw new Error('library read failed');
    bench = required(benchResult.value ?? undefined, 'bench press');
    pullUp = required(pullUpResult.value ?? undefined, 'pull-up');
  });

  async function startSession(overrides: Partial<{ id: string; startedAt: string; bodyweight: string }> = {}) {
    if (db === undefined) throw new Error('no database');
    const result = await createWorkoutRepository(db).startSession({
      id: overrides.id ?? newId(),
      startedAt: overrides.startedAt ?? '2026-08-17T12:00:00.000Z',
      zone: ZONE,
      bodyweightAtSession: overrides.bodyweight ?? '74',
    });
    if (!isOk(result)) throw new Error(`startSession failed: ${result.error.message}`);
    return result.value;
  }

  async function logSet(
    session: WorkoutSession,
    input: Parameters<typeof planSetLog>[0],
    exercise: Exercise = bench,
  ) {
    if (db === undefined) throw new Error('no database');
    const reg = await registry();
    const planned = planSetLog(input, {
      sessionId: session.id,
      exercise,
      zone: ZONE,
      performedAt: '2026-08-17T12:10:00.000Z',
      newId,
      best: NO_HISTORY,
      bodyweightKg: session.bodyweightAtSession,
    });
    if (!isOk(planned)) throw new Error(`plan failed: ${planned.error.message}`);
    return { planned: planned.value, result: await createWorkoutRepository(db).logSet(planned.value, writeContext(reg)) };
  }

  /* ---------------------------------------------------------------------
   * The exercise library
   * ------------------------------------------------------------------ */

  describe('the exercise library', () => {
    it('seeds, and seeding twice changes nothing', async () => {
      if (db === undefined) return;
      const exercises = createExerciseRepository(db);
      const before = await exercises.count();

      const again = await exercises.upsert(SEED_EXERCISES);
      expect(isOk(again)).toBe(true);
      expect(await createExerciseRepository(db).count()).toBe(before);
      expect(before).toBe(SEED_EXERCISES.length);
    });

    /**
     * The reason the conflict target is the slug. Upserting on a generated id
     * would insert the library again under new ids, and every historical set
     * would still point at the originals — silently splitting each exercise's
     * history in two.
     */
    it('keeps an exercise’s id stable across a re-seed', async () => {
      if (db === undefined) return;
      const before = bench.id;
      await createExerciseRepository(db).upsert(SEED_EXERCISES);
      const after = await createExerciseRepository(db).bySlug('barbell-bench-press');
      expect(isOk(after) && after.value?.id).toBe(before);
    });

    /**
     * §4.1 calls `formNotes` "user-authored cues that actually work for them" —
     * the only original content in the library. A re-seed that overwrote it
     * would silently destroy it.
     */
    it('does not overwrite the operator’s own form notes', async () => {
      if (db === undefined) return;
      await db.$client`update exercise set form_notes = 'tuck the elbows' where slug = 'barbell-bench-press'`;

      await createExerciseRepository(db).upsert(SEED_EXERCISES);

      const after = await createExerciseRepository(db).bySlug('barbell-bench-press');
      expect(isOk(after) && after.value?.formNotes).toBe('tuck the elbows');
    });

    it('finds a movement through a typo, using the trigram index (§9.6)', async () => {
      if (db === undefined) return;
      const results = await createExerciseRepository(db).search('bech pres');
      expect(isOk(results)).toBe(true);
      if (!isOk(results)) return;
      expect(results.value.map((item) => item.name)).toContain('Barbell Bench Press');
    });

    it('finds a short substring the trigram threshold would miss', async () => {
      if (db === undefined) return;
      const results = await createExerciseRepository(db).search('row');
      expect(isOk(results) && results.value.length).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------------------
   * Logging
   * ------------------------------------------------------------------ */

  describe('logging a set', () => {
    it('writes the entity row and its observations together', async () => {
      if (db === undefined) return;
      const session = await startSession();
      const { planned, result } = await logSet(session, {
        exerciseId: bench.id,
        orderIndex: 0,
        load: '60',
        reps: 8,
        rpe: '8',
      });

      expect(isOk(result)).toBe(true);

      const sets = await createWorkoutRepository(db).setsForSession(session.id);
      expect(isOk(sets) && sets.value).toHaveLength(1);

      const observations = await createObservationRepository(db).query({
        metricKeys: [GYM_METRICS.setLoad, GYM_METRICS.setReps, GYM_METRICS.setRpe],
      });
      expect(isOk(observations) && observations.value).toHaveLength(3);
      if (!isOk(observations)) return;

      // Every one is subject-referenced to the set, which is what makes P3's
      // "Skin can query training volume without knowing Gym exists" true.
      for (const observation of observations.value) {
        expect(observation.subjectType).toBe('workout_set');
        expect(observation.subjectId).toBe(planned.set.id);
      }
    });

    /**
     * §5.7: "the outbox may replay any request any number of times." A replay
     * must be a no-op, not a second set and not a conflict.
     */
    it('is idempotent on the set id, however many times it is replayed', async () => {
      if (db === undefined) return;
      const session = await startSession();
      const setId = newId();
      const input = { id: setId, exerciseId: bench.id, orderIndex: 0, load: '60', reps: 8 };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { result } = await logSet(session, input);
        expect(isOk(result)).toBe(true);
      }

      const sets = await createWorkoutRepository(db).setsForSession(session.id);
      expect(isOk(sets) && sets.value).toHaveLength(1);

      const observations = await createObservationRepository(db).query({ metricKeys: [GYM_METRICS.setLoad] });
      expect(isOk(observations) && observations.value).toHaveLength(1);
    });

    /**
     * The ordering hazard the outbox's dependency chain exists to prevent. If
     * one slips through, it must come back retryable — a permanent rejection
     * would block the entry and lose the set.
     */
    it('reports a set that outran its session as a retryable precondition', async () => {
      if (db === undefined) return;
      const orphan: WorkoutSession = {
        id: newId(),
        programId: null,
        programBlockId: null,
        startedAt: '2026-08-17T12:00:00.000Z',
        endedAt: null,
        zone: ZONE,
        title: null,
        location: null,
        perceivedEffort: null,
        notes: null,
        bodyweightAtSession: null,
      };

      const { result } = await logSet(orphan, { exerciseId: bench.id, orderIndex: 0, reps: 5, load: '60' });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.kind).toBe('precondition_failed');
      expect(result.error.code).toBe(SESSION_MISSING);
    });

    /**
     * Atomicity. The set row and the observations are one unit — if the
     * observations are refused, the set must not survive on its own.
     */
    it('writes neither half when the observations are refused', async () => {
      if (db === undefined) return;
      const session = await startSession();
      const reg = await registry();

      const planned = planSetLog(
        { exerciseId: bench.id, orderIndex: 0, load: '60', reps: 8 },
        {
          sessionId: session.id,
          exercise: bench,
          zone: ZONE,
          performedAt: '2026-08-17T12:10:00.000Z',
          newId,
          best: NO_HISTORY,
          bodyweightKg: null,
        },
      );
      if (!isOk(planned)) throw new Error('plan failed');

      // An unregistered metric key. §9.2 rejects it on write, from inside the
      // transaction — which is the only interesting way for this to fail.
      const poisoned = {
        ...planned.value,
        observations: [
          ...planned.value.observations,
          { ...required(planned.value.observations[0], 'observation'), metricKey: 'gym.set.nonsense' },
        ],
      };

      const result = await createWorkoutRepository(db).logSet(poisoned, writeContext(reg));
      expect(isErr(result)).toBe(true);

      const sets = await createWorkoutRepository(db).setsForSession(session.id);
      expect(isOk(sets) && sets.value).toHaveLength(0);
    });

    it('flags a personal record from the exercise’s stored history', async () => {
      if (db === undefined) return;
      const session = await startSession();
      await logSet(session, { exerciseId: bench.id, orderIndex: 0, load: '60', reps: 8 });

      const history = await createWorkoutRepository(db).historyFor(bench.id);
      if (!isOk(history)) throw new Error('history failed');

      const best = bestFrom(history.value, bench, session.bodyweightAtSession);
      const reg = await registry();
      const heavier = planSetLog(
        { exerciseId: bench.id, orderIndex: 1, load: '65', reps: 8 },
        {
          sessionId: session.id,
          exercise: bench,
          zone: ZONE,
          performedAt: '2026-08-17T12:20:00.000Z',
          newId,
          best,
          bodyweightKg: session.bodyweightAtSession,
        },
      );
      if (!isOk(heavier)) throw new Error('plan failed');
      expect(heavier.value.records.kinds).toContain('load');

      const written = await createWorkoutRepository(db).logSet(heavier.value, writeContext(reg));
      expect(isOk(written) && written.value.set.isPersonalRecord).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------
   * Sessions
   * ------------------------------------------------------------------ */

  describe('sessions', () => {
    it('is idempotent on start, and a replay does not move the start time', async () => {
      if (db === undefined) return;
      const id = newId();
      const first = await startSession({ id, startedAt: '2026-08-17T12:00:00.000Z' });

      const replay = await createWorkoutRepository(db).startSession({
        id,
        // The outbox delivered it twenty minutes late. The session did not
        // start twenty minutes late.
        startedAt: '2026-08-17T12:20:00.000Z',
        zone: ZONE,
      });

      expect(isOk(replay) && replay.value.startedAt).toBe(first.startedAt);
    });

    it('derives volume and duration on close', async () => {
      if (db === undefined) return;
      const session = await startSession();
      await logSet(session, { exerciseId: bench.id, orderIndex: 0, load: '60', reps: 8 });
      await logSet(session, { exerciseId: bench.id, orderIndex: 1, load: '60', reps: 8 });

      const sets = await createWorkoutRepository(db).setsForSession(session.id);
      if (!isOk(sets)) throw new Error('sets failed');

      const plan = planSessionClose(session, sets.value, {
        endedAt: '2026-08-17T13:15:00.000Z',
        exercises: (id) => (id === bench.id ? bench : null),
      });
      if (!isOk(plan)) throw new Error('close plan failed');

      const closed = await createWorkoutRepository(db).closeSession(plan.value, writeContext(await registry()));
      expect(isOk(closed) && closed.value.session.endedAt).toBe('2026-08-17T13:15:00.000Z');

      const derived = await createObservationRepository(db).query({
        metricKeys: [GYM_METRICS.sessionVolume, GYM_METRICS.sessionDuration],
      });
      if (!isOk(derived)) throw new Error('read failed');
      expect(derived.value).toHaveLength(2);

      const volume = derived.value.find((o) => o.metricKey === GYM_METRICS.sessionVolume);
      expect(volume?.value).toBe('960.000000');
      const duration = derived.value.find((o) => o.metricKey === GYM_METRICS.sessionDuration);
      expect(duration?.value).toBe('75.000000');
    });

    /**
     * A replayed close must not lengthen the session. Without the
     * `ended_at IS NULL` guard, the derived duration observation would then
     * disagree with the one already written.
     */
    it('does not move the end time when the close is replayed', async () => {
      if (db === undefined) return;
      const session = await startSession();
      const reg = await registry();

      const first = planSessionClose(session, [], {
        endedAt: '2026-08-17T13:00:00.000Z',
        exercises: () => bench,
      });
      if (!isOk(first)) throw new Error('plan failed');
      await createWorkoutRepository(db).closeSession(first.value, writeContext(reg));

      const later = planSessionClose(session, [], {
        endedAt: '2026-08-17T13:45:00.000Z',
        exercises: () => bench,
      });
      if (!isOk(later)) throw new Error('plan failed');
      const replayed = await createWorkoutRepository(db).closeSession(later.value, writeContext(reg));

      expect(isOk(replayed) && replayed.value.session.endedAt).toBe('2026-08-17T13:00:00.000Z');
      expect(isOk(replayed) && replayed.value.written).toBe(false);

      const derived = await createObservationRepository(db).query({
        metricKeys: [GYM_METRICS.sessionDuration],
      });
      expect(isOk(derived) && derived.value).toHaveLength(1);
    });

    it('finds the open session, and nothing once it is closed', async () => {
      if (db === undefined) return;
      const session = await startSession();
      const open = await createWorkoutRepository(db).activeSession();
      expect(isOk(open) && open.value?.id).toBe(session.id);

      const plan = planSessionClose(session, [], {
        endedAt: '2026-08-17T13:00:00.000Z',
        exercises: () => bench,
      });
      if (!isOk(plan)) throw new Error('plan failed');
      await createWorkoutRepository(db).closeSession(plan.value, writeContext(await registry()));

      const after = await createWorkoutRepository(db).activeSession();
      expect(isOk(after) && after.value).toBeNull();
    });

    /**
     * §5.3: a session at 01:00 IST on the 18th is not a session on the 17th,
     * however it looks in UTC. The day is resolved in the session's own zone.
     */
    it('files a session under the day it happened in its own zone', async () => {
      if (db === undefined) return;
      // 20:00 UTC on the 17th is 01:30 on the 18th in Kolkata.
      await startSession({ startedAt: '2026-08-17T20:00:00.000Z' });

      const days = await createWorkoutRepository(db).sessionDays(
        '2026-08-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      );
      expect(isOk(days) && days.value).toEqual(['2026-08-18']);
    });

    it('counts sets and distinct exercises per session, in one query', async () => {
      if (db === undefined) return;
      const session = await startSession();
      await logSet(session, { exerciseId: bench.id, orderIndex: 0, load: '60', reps: 8 });
      await logSet(session, { exerciseId: bench.id, orderIndex: 1, load: '60', reps: 8 });
      await logSet(session, { exerciseId: pullUp.id, orderIndex: 2, reps: 6 }, pullUp);

      const recent = await createWorkoutRepository(db).recentSessions();
      if (!isOk(recent)) throw new Error('read failed');
      expect(recent.value[0]?.setCount).toBe(3);
      expect(recent.value[0]?.exerciseCount).toBe(2);
    });
  });

  /* ---------------------------------------------------------------------
   * Reads that feed the logger
   * ------------------------------------------------------------------ */

  describe('history', () => {
    it('carries each session’s own bodyweight, not the latest one', async () => {
      if (db === undefined) return;
      const light = await startSession({ startedAt: '2026-08-10T12:00:00.000Z', bodyweight: '70' });
      await logSet(light, { exerciseId: pullUp.id, orderIndex: 0, reps: 6 }, pullUp);

      const heavy = await startSession({ startedAt: '2026-08-17T12:00:00.000Z', bodyweight: '80' });
      await logSet(heavy, { exerciseId: pullUp.id, orderIndex: 0, reps: 6 }, pullUp);

      const history = await createWorkoutRepository(db).historyFor(pullUp.id);
      if (!isOk(history)) throw new Error('history failed');

      expect(new Set(history.value.map((set) => set.bodyweightKg))).toEqual(
        new Set(['70.000000', '80.000000']),
      );
    });

    it('reads the bodyweight in force at a moment, from the observation log', async () => {
      if (db === undefined) return;
      const observations = createObservationRepository(db);
      const source = await observations.manualSourceId();
      if (!isOk(source)) throw new Error('source failed');

      await db.$client`
        insert into observation (id, metric_key, value, unit, observed_at, observed_zone, recorded_at, source_id, hlc)
        values (gen_random_uuid(), 'body.weight', 74.5, 'kg', '2026-08-16T02:00:00Z', ${ZONE},
                '2026-08-16T02:00:00Z', ${source.value}, '0000000000000000-000000000001')
      `;

      const weight = await createWorkoutRepository(db).bodyweightAt('2026-08-17T12:00:00.000Z');
      expect(isOk(weight) && weight.value).toBe('74.500000');

      // Nothing recorded before this instant. `null`, not the later reading.
      const earlier = await createWorkoutRepository(db).bodyweightAt('2026-08-01T00:00:00.000Z');
      expect(isOk(earlier) && earlier.value).toBeNull();
    });
  });
});

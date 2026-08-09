/**
 * Sessions and sets, persisted.
 *
 * `core/domain/gym` decides what a set *means*; this writes it. The one thing
 * this file decides on its own is atomicity, and it decides it the same way
 * `daily-close.repository.ts` does: a set is an entity row **and** two or three
 * observations, and a write that landed one without the other would leave the
 * record disagreeing with itself about what happened in the gym.
 *
 * ## The offline case this file is shaped around
 *
 * §12's exit criterion for this week is "a real training session logged in the
 * gym, on a phone, without friction", and gyms are basements. So every write
 * here is **idempotent on a client-generated id** (§5.7), because the outbox
 * will replay it:
 *
 * - `startSession` inserts `ON CONFLICT DO NOTHING` and returns the existing row.
 * - `logSet` does the same, and its observations inherit `append`'s own
 *   conflict handling.
 * - `closeSession` is an idempotent update — closing a closed session is a
 *   no-op rather than a second close with a later end time.
 *
 * The ordering hazard is real and is handled on both sides. A set references
 * its session by foreign key, so a set that arrives first fails with `23503`.
 * The client will not send it (`lib/offline/outbox.ts` holds an entry until its
 * dependency is acknowledged), and if it somehow does, {@link SESSION_MISSING}
 * comes back as a *retryable* precondition rather than a permanent rejection.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  DomainError,
  HistoricalSet,
  HlcState,
  MetricRegistry,
  Observation,
  PlannedSet,
  SessionClosePlan,
  SetSide,
  WorkoutSession,
  WorkoutSet,
  WorkoutSetKind,
} from '@naitikos/core';
import {
  conflictError,
  dayKeyInZone,
  isDomainError,
  preconditionFailedError,
  prepareObservations,
} from '@naitikos/core';

import type { Database } from '../client';
import { workoutSession, workoutSet } from '../schema/body';
import { observation } from '../schema/substrate';
import { createObservationRepository } from './observation.repository';

/** Returned when a set arrives before the session it belongs to. Retryable. */
export const SESSION_MISSING = 'workout_session_missing';

/** Postgres foreign-key violation. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Whether this error, or anything it wraps, is a foreign-key violation.
 *
 * **The cause chain is not optional.** Drizzle wraps every driver error in a
 * `DrizzleQueryError` carrying the SQL and the parameters, so the `code` the
 * check needs is one level down — a top-level `error.code` test compiles, reads
 * correctly, and matches nothing. The symptom is a set that outran its session
 * escaping as an unhandled exception (a 500, which the outbox retries forever)
 * instead of the retryable precondition below.
 */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  // Bounded, because a cause chain can in principle be cyclic.
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && (current as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Carries a domain error out through a rolled-back transaction. See §5.12. */
class TransactionAbort extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'TransactionAbort';
    this.domainError = domainError;
  }
}

function fromTransactionAbort(error: unknown): DomainError | null {
  if (error instanceof TransactionAbort) return error.domainError;
  if (isForeignKeyViolation(error)) {
    return preconditionFailedError(
      SESSION_MISSING,
      'The session this set belongs to has not been recorded yet. Retry once it has.',
      SESSION_MISSING,
    );
  }
  return isDomainError(error) ? error : null;
}

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function toSession(row: typeof workoutSession.$inferSelect): WorkoutSession {
  return {
    id: row.id,
    programId: row.programId,
    programBlockId: row.programBlockId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    zone: row.zone,
    title: row.title,
    location: row.location,
    perceivedEffort: row.perceivedEffort,
    notes: row.notes,
    bodyweightAtSession: row.bodyweightAtSession,
  };
}

function toSet(row: typeof workoutSet.$inferSelect): WorkoutSet {
  return {
    id: row.id,
    sessionId: row.sessionId,
    exerciseId: row.exerciseId,
    orderIndex: row.orderIndex,
    kind: row.kind,
    load: row.load,
    loadUnit: row.loadUnit,
    reps: row.reps,
    rpe: row.rpe,
    restSeconds: row.restSeconds,
    supersetGroup: row.supersetGroup,
    // The column is free text so a third value could be added without a
    // migration; anything unrecognised reads as "not sided", which is the
    // conservative answer for volume.
    side: row.side === 'left' || row.side === 'right' ? (row.side as SetSide) : null,
    performedAt: row.performedAt,
    isPersonalRecord: row.isPersonalRecord,
    notes: row.notes,
  };
}

/* -------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------- */

export type WriteContext = {
  readonly registry: MetricRegistry;
  readonly hlcState: HlcState;
  readonly recordedAt: string;
  readonly physicalMillis: number;
  readonly newId: () => string;
};

export type SessionSummary = {
  readonly session: WorkoutSession;
  readonly setCount: number;
  readonly exerciseCount: number;
  /** The day the session belongs to, in its own zone (§5.3). */
  readonly dayKey: string;
};

/**
 * A write's result, with the clock the server issued.
 *
 * `hlc` travels back so the device can store it and send it as `clientHlc` on
 * the next write — which is what keeps a device's writes monotone across
 * requests without the server remembering anything (§5.7, and the long note at
 * the top of `lib/platform/capture.ts`). `null` when the write was a replay and
 * therefore advanced no clock.
 */
export type LoggedSet = {
  readonly set: WorkoutSet;
  readonly hlc: string | null;
  /** False when this was a replay and nothing new was written. */
  readonly written: boolean;
};

export type ClosedSession = {
  readonly session: WorkoutSession;
  readonly hlc: string | null;
  readonly written: boolean;
};

export type StartSessionInput = {
  readonly id: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly programId?: string | null;
  readonly programBlockId?: string | null;
  readonly title?: string | null;
  readonly location?: string | null;
  readonly bodyweightAtSession?: string | null;
};

export type WorkoutRepository = {
  startSession(input: StartSessionInput): Promise<Result<WorkoutSession, DomainError>>;
  /** The session with no end time. At most one — see the note on the method. */
  activeSession(): Promise<Result<WorkoutSession | null, DomainError>>;
  sessionById(id: string): Promise<Result<WorkoutSession | null, DomainError>>;
  setsForSession(sessionId: string): Promise<Result<readonly WorkoutSet[], DomainError>>;

  logSet(planned: PlannedSet, context: WriteContext): Promise<Result<LoggedSet, DomainError>>;
  closeSession(plan: SessionClosePlan, context: WriteContext): Promise<Result<ClosedSession, DomainError>>;

  /** An exercise's whole history, newest first, capped. For prefill and charts. */
  historyFor(exerciseId: string, limit?: number): Promise<Result<readonly HistoricalSet[], DomainError>>;
  recentSessions(limit?: number): Promise<Result<readonly SessionSummary[], DomainError>>;
  /** Sets performed in a window, with each session's bodyweight. For volume work. */
  setsBetween(from: string, until: string): Promise<Result<readonly HistoricalSet[], DomainError>>;
  /** Days with at least one session, in a window. For the adherence grid. */
  sessionDays(from: string, until: string): Promise<Result<readonly string[], DomainError>>;
  /** The most recent bodyweight at or before an instant, in kg. */
  bodyweightAt(instant: string): Promise<Result<string | null, DomainError>>;
};

export function createWorkoutRepository(db: Database): WorkoutRepository {
  return {
    async startSession(input) {
      /*
       * `DO NOTHING` then read back, rather than `DO UPDATE`.
       *
       * A replayed start must not move `startedAt` — the outbox may deliver it
       * minutes after the session actually began, and the second write would
       * shorten the recorded session by exactly the sync delay.
       */
      await db
        .insert(workoutSession)
        .values({
          id: input.id,
          startedAt: input.startedAt,
          zone: input.zone,
          programId: input.programId ?? null,
          programBlockId: input.programBlockId ?? null,
          title: input.title ?? null,
          location: input.location ?? null,
          bodyweightAtSession: input.bodyweightAtSession ?? null,
        })
        .onConflictDoNothing({ target: workoutSession.id });

      const rows = await db.select().from(workoutSession).where(eq(workoutSession.id, input.id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        return err(
          conflictError('workout_session', 'invalid_state', {
            code: 'workout_session_not_written',
            message: 'The session could not be recorded.',
          }),
        );
      }
      return ok(toSession(row));
    },

    async activeSession() {
      /*
       * Most recent open session, not "the" open session.
       *
       * There is no constraint forbidding two — and there deliberately is not
       * one. A session left open because the operator walked out without
       * tapping stop is a normal occurrence, and a unique index would then
       * refuse the *next* session until the stale one was cleaned up, which is
       * a worse failure than an untidy row.
       */
      const rows = await db
        .select()
        .from(workoutSession)
        .where(and(isNull(workoutSession.endedAt), isNull(workoutSession.deletedAt)))
        .orderBy(desc(workoutSession.startedAt))
        .limit(1);

      return ok(rows[0] === undefined ? null : toSession(rows[0]));
    },

    async sessionById(id) {
      const rows = await db
        .select()
        .from(workoutSession)
        .where(and(eq(workoutSession.id, id), isNull(workoutSession.deletedAt)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toSession(rows[0]));
    },

    async setsForSession(sessionId) {
      const rows = await db
        .select()
        .from(workoutSet)
        .where(and(eq(workoutSet.sessionId, sessionId), isNull(workoutSet.deletedAt)))
        .orderBy(asc(workoutSet.orderIndex));
      return ok(rows.map(toSet));
    },

    async logSet(planned, context) {
      const observations = createObservationRepository(db);
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(planned.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      try {
        return await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(workoutSet)
            .values({
              id: planned.set.id,
              sessionId: planned.set.sessionId,
              exerciseId: planned.set.exerciseId,
              orderIndex: planned.set.orderIndex,
              kind: planned.set.kind,
              load: planned.set.load,
              loadUnit: planned.set.loadUnit,
              reps: planned.set.reps,
              rpe: planned.set.rpe,
              restSeconds: planned.set.restSeconds,
              supersetGroup: planned.set.supersetGroup,
              side: planned.set.side,
              performedAt: planned.set.performedAt,
              isPersonalRecord: planned.set.isPersonalRecord,
              notes: planned.set.notes,
            })
            /*
             * The client-generated set id is the idempotency key (§5.7).
             */
            .onConflictDoNothing({ target: workoutSet.id })
            .returning({ id: workoutSet.id });

          /*
           * **The set row is the idempotency anchor for its observations too.**
           *
           * Nothing inserted means this exact set is already recorded, so this
           * is a replay and the whole call returns the stored row without
           * writing anything else. That guard is load-bearing rather than an
           * optimisation: the observations are re-planned on every attempt and
           * carry *fresh* ids each time, so `append`'s own conflict handling —
           * which dedupes on the observation id — would not recognise them.
           * Without this, a replayed set wrote its load and reps again, and the
           * exercise appeared to have been performed twice.
           *
           * The idempotency table (§5.7) catches the same replay one layer up.
           * This is the braces, at the layer where a partial replay lands.
           */
          const rows = await tx.select().from(workoutSet).where(eq(workoutSet.id, planned.set.id)).limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new TransactionAbort(
              conflictError('workout_set', 'invalid_state', {
                code: 'workout_set_not_written',
                message: 'The set could not be recorded.',
              }),
            );
          }

          if (inserted.length === 0) return ok({ set: toSet(row), hlc: null, written: false });

          const appended = await createObservationRepository(tx).append(prepared.value.observations);
          if (!appended.ok) throw new TransactionAbort(appended.error);

          return ok({
            set: toSet(row),
            hlc: prepared.value.observations.at(-1)?.hlc ?? null,
            written: true,
          });
        });
      } catch (error) {
        const domainError = fromTransactionAbort(error);
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async closeSession(plan, context) {
      const observations = createObservationRepository(db);
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(plan.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      try {
        return await db.transaction(async (tx) => {
          /*
           * Guarded by `ended_at IS NULL`, which makes the close idempotent.
           *
           * A replayed close matches nothing and the session keeps its original
           * end time. Without the guard, a replay three minutes later would
           * silently lengthen the session — and the derived duration
           * observation would then disagree with the one already written.
           */
          const updated = await tx
            .update(workoutSession)
            .set({
              endedAt: plan.session.endedAt,
              notes: plan.session.notes,
              perceivedEffort: plan.session.perceivedEffort,
              updatedAt: sql`now()`,
              version: sql`${workoutSession.version} + 1`,
            })
            .where(and(eq(workoutSession.id, plan.session.id), isNull(workoutSession.endedAt)))
            .returning();

          // Already closed: return the session as it stands and write nothing.
          if (updated.length === 0) {
            const rows = await tx
              .select()
              .from(workoutSession)
              .where(eq(workoutSession.id, plan.session.id))
              .limit(1);
            const existing = rows[0];
            if (existing === undefined) {
              throw new TransactionAbort(
                preconditionFailedError(
                  SESSION_MISSING,
                  'That session has not been recorded yet. Retry once it has.',
                  SESSION_MISSING,
                ),
              );
            }
            return ok({ session: toSession(existing), hlc: null, written: false });
          }

          const appended = await createObservationRepository(tx).append(prepared.value.observations);
          if (!appended.ok) throw new TransactionAbort(appended.error);

          const row = updated[0];
          if (row === undefined) {
            throw new TransactionAbort(
              conflictError('workout_session', 'invalid_state', {
                code: 'workout_session_not_closed',
                message: 'The session could not be closed.',
              }),
            );
          }
          return ok({
            session: toSession(row),
            hlc: prepared.value.observations.at(-1)?.hlc ?? null,
            written: true,
          });
        });
      } catch (error) {
        const domainError = fromTransactionAbort(error);
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async historyFor(exerciseId, limit = 200) {
      const rows = await db
        .select({
          set: workoutSet,
          zone: workoutSession.zone,
          bodyweight: workoutSession.bodyweightAtSession,
        })
        .from(workoutSet)
        .innerJoin(workoutSession, eq(workoutSet.sessionId, workoutSession.id))
        .where(
          and(
            eq(workoutSet.exerciseId, exerciseId),
            isNull(workoutSet.deletedAt),
            isNull(workoutSession.deletedAt),
          ),
        )
        // Uses `workout_set_exercise_idx`, which exists for exactly this query
        // — §4.1's prefill is on the P1 hot path.
        .orderBy(desc(workoutSet.performedAt))
        .limit(limit);

      return ok(rows.map((row) => toHistorical(row.set, row.zone, row.bodyweight)));
    },

    async recentSessions(limit = 30) {
      const sessions = await db
        .select()
        .from(workoutSession)
        .where(isNull(workoutSession.deletedAt))
        .orderBy(desc(workoutSession.startedAt))
        .limit(limit);

      if (sessions.length === 0) return ok([]);

      /*
       * Counts in one grouped query rather than one per session.
       *
       * Thirty sessions is thirty round trips otherwise, and the history screen
       * is the second thing the operator opens. `count(distinct)` for exercises
       * because a session of four exercises across sixteen sets is four.
       */
      const counts = await db
        .select({
          sessionId: workoutSet.sessionId,
          setCount: sql<number>`count(*)::int`,
          exerciseCount: sql<number>`count(distinct ${workoutSet.exerciseId})::int`,
        })
        .from(workoutSet)
        .where(
          and(
            inArray(
              workoutSet.sessionId,
              sessions.map((session) => session.id),
            ),
            isNull(workoutSet.deletedAt),
          ),
        )
        .groupBy(workoutSet.sessionId);

      const byId = new Map(counts.map((row) => [row.sessionId, row]));

      return ok(
        sessions.map((row) => {
          const session = toSession(row);
          const count = byId.get(session.id);
          return {
            session,
            setCount: count?.setCount ?? 0,
            exerciseCount: count?.exerciseCount ?? 0,
            dayKey: dayKeyInZone(session.startedAt, session.zone),
          };
        }),
      );
    },

    async setsBetween(from, until) {
      const rows = await db
        .select({
          set: workoutSet,
          zone: workoutSession.zone,
          bodyweight: workoutSession.bodyweightAtSession,
        })
        .from(workoutSet)
        .innerJoin(workoutSession, eq(workoutSet.sessionId, workoutSession.id))
        .where(
          and(
            gte(workoutSet.performedAt, from),
            lt(workoutSet.performedAt, until),
            isNull(workoutSet.deletedAt),
            isNull(workoutSession.deletedAt),
          ),
        )
        .orderBy(asc(workoutSet.performedAt));

      return ok(rows.map((row) => toHistorical(row.set, row.zone, row.bodyweight)));
    },

    async sessionDays(from, until) {
      const rows = await db
        .select({ startedAt: workoutSession.startedAt, zone: workoutSession.zone })
        .from(workoutSession)
        .where(
          and(
            gte(workoutSession.startedAt, from),
            lt(workoutSession.startedAt, until),
            isNull(workoutSession.deletedAt),
          ),
        )
        .orderBy(asc(workoutSession.startedAt));

      /*
       * The day key is computed here rather than in SQL, and that is the same
       * decision `observation.repository.ts` records: `date_trunc(text,
       * timestamptz)` is STABLE rather than IMMUTABLE so Postgres refuses it in
       * an index, and `AT TIME ZONE 'UTC'` would file every Indian evening
       * under the following date.
       */
      return ok([...new Set(rows.map((row) => dayKeyInZone(row.startedAt, row.zone)))]);
    },

    async bodyweightAt(instant) {
      const rows = await db
        .select({ value: observation.value })
        .from(observation)
        .where(
          and(
            eq(observation.metricKey, 'body.weight'),
            lt(observation.observedAt, instant),
            isNull(observation.supersededById),
          ),
        )
        .orderBy(desc(observation.observedAt))
        .limit(1);

      return ok(rows[0]?.value ?? null);
    },
  };
}

function toHistorical(
  row: typeof workoutSet.$inferSelect,
  zone: string,
  bodyweight: string | null,
): HistoricalSet {
  return {
    sessionId: row.sessionId,
    setId: row.id,
    exerciseId: row.exerciseId,
    performedAt: row.performedAt,
    zone,
    orderIndex: row.orderIndex,
    kind: row.kind as WorkoutSetKind,
    load: row.load,
    loadUnit: row.loadUnit,
    reps: row.reps,
    rpe: row.rpe,
    side: row.side === 'left' || row.side === 'right' ? (row.side as SetSide) : null,
    bodyweightKg: bodyweight,
  };
}

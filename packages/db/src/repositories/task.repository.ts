/**
 * The deferred-task table.
 *
 * §5.2 permits exactly one scheduled entry point, so **nothing polls this**. The
 * nightly run's last step drains it. A row here is work that will happen tonight,
 * not work that is happening now — which is the single most important thing to
 * understand before adding a task kind, because a caller expecting a thumbnail in
 * five seconds will be disappointed by up to twenty-four hours.
 *
 * The claim/settle protocol below exists anyway, and the reason is not concurrency
 * between workers (there are none). It is that §5.2 requires the run be "manually
 * triggerable from `/settings/developer`", so a human can start a second run while
 * the cron's is still going. Two runs draining one table is exactly the race the
 * status transitions prevent.
 */

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DeferredTask, DomainError, TaskKind } from '@naitikos/core';
import { TASK_MAX_ATTEMPTS, backoffSeconds, isoAfterSeconds, parseInstant } from '@naitikos/core';

import type { Database } from '../client';
import { deferredTask } from '../schema/events';

/** Row → the `core` shape. */
function toTask(row: typeof deferredTask.$inferSelect): DeferredTask {
  return {
    id: row.id,
    kind: row.kind,
    subject: { type: row.subjectType, id: row.subjectId },
    enqueuedAt: row.createdAt,
    attempts: row.attempts,
    ...(row.notBefore === null ? {} : { notBefore: row.notBefore }),
    ...(row.causationEventId === null ? {} : { causationEventId: row.causationEventId }),
  };
}

export type EnqueueTaskInput = {
  readonly kind: TaskKind;
  readonly subject: { readonly type: string; readonly id: string };
  /** Not before this instant. For notification scheduling, and for backoff. */
  readonly notBefore?: string;
  readonly causationEventId?: string;
};

export type TaskRepository = {
  /**
   * Enqueue, deduplicating against the live task for the same subject.
   *
   * @returns the id of the live task — the existing one if there was one.
   */
  enqueue(input: EnqueueTaskInput): Promise<Result<string, DomainError>>;

  /** Due, pending tasks in enqueue order. The drain query. */
  claimDue(limit: number, now: string): Promise<Result<readonly DeferredTask[], DomainError>>;

  /** Mark a claimed task done. */
  settle(taskId: string): Promise<Result<void, DomainError>>;

  /**
   * Record a failure, scheduling a retry or dead-lettering.
   *
   * @returns whether the task is now dead.
   */
  fail(taskId: string, errorCode: string, now: string): Promise<Result<boolean, DomainError>>;

  /** Return a `running` task to `pending`. For a run that died mid-step. */
  release(taskId: string): Promise<Result<void, DomainError>>;

  /**
   * Reset tasks stuck in `running`.
   *
   * A run killed by a serverless timeout leaves its claims held forever, and the
   * partial unique index means the *next* enqueue for that subject silently
   * dedupes against a task nobody will ever drain. §5.2's "safe to re-run" needs
   * this to be true in practice, not just in intent.
   */
  recoverStale(olderThan: string): Promise<Result<number, DomainError>>;

  /** §5.16's alert surface, and `/settings/developer`. */
  deadTasks(limit?: number): Promise<readonly DeferredTask[]>;
  pendingCount(): Promise<number>;
};

export function createTaskRepository(db: Database): TaskRepository {
  return {
    async enqueue(input) {
      const values = {
        id: crypto.randomUUID(),
        kind: input.kind,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        ...(input.notBefore === undefined ? {} : { notBefore: input.notBefore }),
        ...(input.causationEventId === undefined ? {} : { causationEventId: input.causationEventId }),
      };

      // `DO NOTHING` against the partial unique index on (kind, subject) where
      // status is pending or running. Enqueuing a thumbnail for the same photo
      // twice must not produce two rows: the second does redundant work and can
      // race the first.
      const inserted = await db
        .insert(deferredTask)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: deferredTask.id });

      const created = inserted[0]?.id;
      if (created !== undefined) return ok(created);

      // Lost the race, or a live task already existed. Read it back so the caller
      // gets an id it can trace rather than a silent success.
      const existing = await db
        .select({ id: deferredTask.id })
        .from(deferredTask)
        .where(
          and(
            eq(deferredTask.kind, input.kind),
            eq(deferredTask.subjectType, input.subject.type),
            eq(deferredTask.subjectId, input.subject.id),
            inArray(deferredTask.status, ['pending', 'running']),
          ),
        )
        .limit(1);

      // If the row vanished between the two statements the enqueue is genuinely
      // lost, but re-inserting could produce the duplicate the index exists to
      // prevent. Returning the empty string would be worse than an id that says so.
      return ok(existing[0]?.id ?? '');
    },

    async claimDue(limit, now) {
      /**
       * Claim by UPDATE ... RETURNING, in one statement.
       *
       * Select-then-update would let a manually triggered run claim the same rows
       * the cron's run is about to. `FOR UPDATE SKIP LOCKED` in the subquery is
       * what makes the second run take *different* rows rather than block.
       */
      const claimed = await db
        .update(deferredTask)
        .set({ status: 'running', lastAttemptAt: now, updatedAt: sql`now()` })
        .where(
          inArray(
            deferredTask.id,
            db
              .select({ id: deferredTask.id })
              .from(deferredTask)
              .where(
                and(
                  eq(deferredTask.status, 'pending'),
                  // A null `notBefore` means "as soon as possible".
                  or(isNull(deferredTask.notBefore), lte(deferredTask.notBefore, now)),
                ),
              )
              .orderBy(asc(deferredTask.createdAt))
              .limit(limit)
              .for('update', { skipLocked: true }),
          ),
        )
        .returning();

      // Re-sorted: `RETURNING` order is not specified, and the drain must still be
      // oldest-first so a task enqueued three nights ago does not lose to tonight's.
      return ok(
        claimed
          .map(toTask)
          .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0)),
      );
    },

    async settle(taskId) {
      await db
        .update(deferredTask)
        .set({ status: 'succeeded', updatedAt: sql`now()` })
        .where(eq(deferredTask.id, taskId));
      return ok(undefined);
    },

    async fail(taskId, errorCode, now) {
      // Through `parseInstant` rather than `Date.parse`, which returns NaN for a
      // malformed string and would make `notBefore` the string "Invalid Date".
      const nowMillis = parseInstant(now)?.getTime() ?? null;

      const rows = await db
        .select({ attempts: deferredTask.attempts })
        .from(deferredTask)
        .where(eq(deferredTask.id, taskId))
        .limit(1);

      const attempts = (rows[0]?.attempts ?? 0) + 1;
      const isDead = attempts >= TASK_MAX_ATTEMPTS;

      await db
        .update(deferredTask)
        .set({
          attempts,
          lastAttemptAt: now,
          lastErrorCode: errorCode,
          // `dead`, not `failed`, on exhaustion — §5.16 alerts on the dead rows, and
          // a transient `failed` that will be retried tonight must not page anyone.
          status: isDead ? 'dead' : 'pending',
          // Backoff from the *new* attempt count: 1h, 6h, 24h. Coarse because the
          // runner fires nightly and finer granularity would be theatre.
          //
          // A null on an unparseable `now` means "retry as soon as possible" —
          // better than a poisoned timestamp that would either never come due or
          // come due immediately in a loop.
          notBefore:
            isDead || nowMillis === null
              ? null
              : isoAfterSeconds(nowMillis, backoffSeconds(attempts - 1)),
          updatedAt: sql`now()`,
        })
        .where(eq(deferredTask.id, taskId));

      return ok(isDead);
    },

    async release(taskId) {
      await db
        .update(deferredTask)
        .set({ status: 'pending', updatedAt: sql`now()` })
        .where(and(eq(deferredTask.id, taskId), eq(deferredTask.status, 'running')));
      return ok(undefined);
    },

    async recoverStale(olderThan) {
      const recovered = await db
        .update(deferredTask)
        .set({ status: 'pending', updatedAt: sql`now()` })
        .where(and(eq(deferredTask.status, 'running'), lte(deferredTask.lastAttemptAt, olderThan)))
        .returning({ id: deferredTask.id });

      return ok(recovered.length);
    },

    async deadTasks(limit = 100) {
      const rows = await db
        .select()
        .from(deferredTask)
        .where(eq(deferredTask.status, 'dead'))
        .orderBy(sql`${deferredTask.lastAttemptAt} DESC`)
        .limit(limit);
      return rows.map(toTask);
    },

    async pendingCount() {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(deferredTask)
        .where(eq(deferredTask.status, 'pending'));
      return rows[0]?.count ?? 0;
    },
  };
}

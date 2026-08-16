/**
 * Goals, persisted — definitions and snapshots. **Never progress.**
 *
 * §4.10 draws the line and §9.3(4) restates it as a rule for the whole
 * cross-cutting tier: "Goals own definitions, not progress. Insights own
 * findings, not data. This is what stops derived state from becoming a second,
 * drifting source of truth."
 *
 * So there is no `currentValue` column on `goal_target` and no method here that
 * would fill one. Progress is `dailyRollup` → `linearTrend` → `deriveProgress`,
 * computed on every read from observations that Gym, Composition and Nutrition
 * already wrote.
 *
 * ## What `goal_progress_snapshot` is, since it looks like a contradiction
 *
 * A dated record of a *belief*, written nightly. §9.2: "Snapshots exist so the
 * *trajectory as it was believed at the time* is preserved even after the
 * underlying data is corrected." It becomes interesting exactly when it
 * disagrees with today's derivation — a March bodyweight corrected in June
 * changes today's line, and the January snapshot is the only evidence that the
 * review that month was looking at something else.
 *
 * ## Closing a goal is an update, and that is correct
 *
 * Unlike `condition` (§9.5) or `medication_schedule`, a goal is not bitemporal
 * and does not supersede. A goal that was abandoned was not *believed to be
 * something else* — it was abandoned, on a date, for a reason, and
 * `closingNote` plus `supersedesGoalId` carry that. §9.5 is explicit that
 * bitemporality stops at `medical_event` and its subtypes; extending it here
 * would double the query cost of every screen for a distinction goals do not
 * have.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Goal,
  GoalComparator,
  GoalInput,
  GoalStatus,
  GoalTarget,
  ProgressSnapshot,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { goal, goalProgressSnapshot, goalTarget } from '../schema/crosscutting';

function toGoal(row: typeof goal.$inferSelect): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as GoalStatus,
    startedAt: row.startedAt,
    horizonAt: row.horizonAt,
    achievedAt: row.achievedAt,
    closingNote: row.closingNote,
    supersedesGoalId: row.supersedesGoalId,
  };
}

function toTarget(row: typeof goalTarget.$inferSelect): GoalTarget {
  return {
    id: row.id,
    goalId: row.goalId,
    metricKey: row.metricKey,
    /*
     * The column is `text`, so an unknown comparator is representable. It is
     * cast rather than validated here because `core` owns the vocabulary and
     * `deriveProgress` already falls through to a level comparison for anything
     * that is not `rate_of_change` — a wrong comparator produces a wrong
     * reading, never a crash on a screen the operator opened.
     */
    comparator: row.comparator as GoalComparator,
    targetValue: row.targetValue,
    unit: row.unit,
    windowDays: row.windowDays,
  };
}

function toSnapshot(row: typeof goalProgressSnapshot.$inferSelect): ProgressSnapshot {
  return {
    id: row.id,
    goalId: row.goalId,
    goalTargetId: row.goalTargetId,
    takenAt: row.takenAt,
    currentValue: row.currentValue,
    progressRatio: row.progressRatio,
    projectedAt: row.projectedAt,
    projectionConfidence: row.projectionConfidence,
  };
}

export type CloseGoalInput = {
  readonly id: string;
  readonly status: GoalStatus;
  readonly closingNote: string | null;
  readonly at: string;
};

export type GoalRepository = {
  /** Every goal, newest first. Closed ones included — §4.10's archaeology. */
  all(): Promise<Result<readonly Goal[], DomainError>>;
  byId(id: string): Promise<Result<Goal | null, DomainError>>;
  /** Targets for the given goals, or for all of them. */
  targets(goalIds?: readonly string[]): Promise<Result<readonly GoalTarget[], DomainError>>;
  create(input: GoalInput): Promise<Result<Goal, DomainError>>;
  close(input: CloseGoalInput): Promise<Result<Goal, DomainError>>;
  snapshots(goalId: string, limit?: number): Promise<Result<readonly ProgressSnapshot[], DomainError>>;
  /** The nightly write. Idempotent on the row id the caller mints. */
  recordSnapshots(rows: readonly ProgressSnapshot[]): Promise<Result<number, DomainError>>;
  /** The most recent snapshot per target, for the review's "what changed". */
  latestSnapshots(before: string): Promise<Result<readonly ProgressSnapshot[], DomainError>>;
};

export function createGoalRepository(db: Database): GoalRepository {
  return {
    async all() {
      const rows = await db
        .select()
        .from(goal)
        .where(isNull(goal.deletedAt))
        /* Active first, then by recency. A closed goal is history and belongs
         * below the thing being pursued, not interleaved with it by date. */
        .orderBy(desc(goal.startedAt));
      return ok(rows.map(toGoal));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(goal)
        .where(and(eq(goal.id, id), isNull(goal.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toGoal(row));
    },

    async targets(goalIds) {
      const rows = await db
        .select()
        .from(goalTarget)
        .where(
          goalIds === undefined
            ? isNull(goalTarget.deletedAt)
            : goalIds.length === 0
              ? /* An explicit empty list means "no goals", which must return
                 * nothing — not everything, which is what dropping the filter
                 * would do. */
                eq(goalTarget.goalId, '00000000-0000-0000-0000-000000000000')
              : and(isNull(goalTarget.deletedAt), inArray(goalTarget.goalId, [...goalIds])),
        )
        .orderBy(asc(goalTarget.metricKey));
      return ok(rows.map(toTarget));
    },

    async create(input) {
      const written = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(goal)
          .values({
            id: input.id,
            title: input.title,
            description: input.description ?? null,
            startedAt: input.startedAt,
            horizonAt: input.horizonAt ?? null,
          })
          /* §5.7: a replayed write arrives with the same client-minted UUIDv7. */
          .onConflictDoNothing()
          .returning();

        /* Targets only on a first insert. On a replay the goal already has
         * them, and inserting again would double every denominator. */
        if (rows[0] !== undefined) {
          await tx.insert(goalTarget).values(
            input.targets.map((target) => ({
              id: target.id,
              goalId: input.id,
              metricKey: target.metricKey,
              comparator: target.comparator,
              targetValue: target.targetValue,
              unit: target.unit,
              windowDays: target.windowDays ?? null,
            })),
          );
        }

        return rows[0];
      });

      if (written !== undefined) return ok(toGoal(written));

      const replayed = await db.select().from(goal).where(eq(goal.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined ? { ok: false, error: notFoundError('goal', input.id) } : ok(toGoal(row));
    },

    async close(input) {
      const rows = await db
        .update(goal)
        .set({
          status: input.status,
          closingNote: input.closingNote,
          /* Only an achievement gets a date. An abandoned goal has a closing
           * note and no `achievedAt`, because it was not achieved and a
           * populated column there would read as though it had been. */
          ...(input.status === 'achieved' ? { achievedAt: input.at } : {}),
          updatedAt: input.at,
        })
        .where(eq(goal.id, input.id))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('goal', input.id) } : ok(toGoal(row));
    },

    async snapshots(goalId, limit = 90) {
      const rows = await db
        .select()
        .from(goalProgressSnapshot)
        .where(eq(goalProgressSnapshot.goalId, goalId))
        .orderBy(desc(goalProgressSnapshot.takenAt))
        .limit(limit);
      return ok(rows.map(toSnapshot));
    },

    async recordSnapshots(rows) {
      if (rows.length === 0) return ok(0);
      await db
        .insert(goalProgressSnapshot)
        .values(
          rows.map((row) => ({
            id: row.id,
            goalId: row.goalId,
            goalTargetId: row.goalTargetId,
            takenAt: row.takenAt,
            currentValue: row.currentValue,
            progressRatio: row.progressRatio,
            projectedAt: row.projectedAt,
            projectionConfidence: row.projectionConfidence,
          })),
        )
        /* The nightly job re-run on the same evening must not double the row.
         * The caller derives the id from the target and the day for exactly
         * this reason. */
        .onConflictDoNothing({ target: goalProgressSnapshot.id });
      return ok(rows.length);
    },

    async latestSnapshots(before) {
      /*
       * One row per target, the newest at or before `before`.
       *
       * `DISTINCT ON` rather than a window function or a correlated subquery:
       * it is the Postgres-native way to say "first row per group" and it uses
       * the `(goal_id, taken_at desc)` index directly. The ORDER BY must lead
       * with the same expression as the DISTINCT ON, which is why `goalTargetId`
       * appears twice.
       */
      const rows = await db
        .selectDistinctOn([goalProgressSnapshot.goalTargetId])
        .from(goalProgressSnapshot)
        .where(lte(goalProgressSnapshot.takenAt, before))
        .orderBy(asc(goalProgressSnapshot.goalTargetId), desc(goalProgressSnapshot.takenAt));
      return ok(rows.map(toSnapshot));
    },
  };
}

/** Kept so the review query has one spelling of "since". */
export function snapshotsSince(from: string) {
  return gte(goalProgressSnapshot.takenAt, from);
}

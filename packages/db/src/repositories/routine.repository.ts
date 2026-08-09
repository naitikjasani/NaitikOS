/**
 * The routine engine, persisted — §9.2's "one implementation, three consumers".
 *
 * Skincare is the only consumer with a surface in the MVP. Nothing in this file
 * knows that: every query takes a `kind`, and dental hygiene and supplements
 * will arrive as data rather than as code.
 *
 * ## The step log is idempotent on the natural key, not on an id
 *
 * `routine_log` carries a unique index on `(routineId, stepId, occurredOn)`,
 * and that is the idempotency key rather than the row id. The reason is the
 * interaction: the operator taps a step, the tap goes into the offline outbox,
 * they tap it again because the first tap did not visibly register, and two
 * client-generated ids arrive for the same completion. Deduping on the id would
 * record the step twice and make a three-step routine report 200% adherence.
 *
 * Tapping a *different* status for the same step is a correction, so the
 * conflict updates rather than doing nothing.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Routine,
  RoutineKind,
  RoutineLog,
  RoutinePeriod,
  RoutineStep,
  RoutineStepStatus,
} from '@naitikos/core';

import type { Database } from '../client';
import { routine, routineLog, routineStep } from '../schema/body';

function toRoutine(row: typeof routine.$inferSelect): Routine {
  return {
    id: row.id,
    kind: row.kind as RoutineKind,
    period: row.period as RoutinePeriod,
    name: row.name,
    isActive: row.isActive,
    expectedAt: row.expectedAt,
  };
}

function toStep(row: typeof routineStep.$inferSelect): RoutineStep {
  return {
    id: row.id,
    routineId: row.routineId,
    orderIndex: row.orderIndex,
    label: row.label,
    productId: row.productId,
    medicationId: row.medicationId,
    isOptional: row.isOptional,
    instructions: row.instructions,
  };
}

function toLog(row: typeof routineLog.$inferSelect): RoutineLog {
  return {
    id: row.id,
    routineId: row.routineId,
    stepId: row.stepId,
    occurredOn: row.occurredOn,
    completedAt: row.completedAt,
    zone: row.zone,
    status: row.status as RoutineStepStatus,
    note: row.note,
  };
}

export type LogStepInput = {
  readonly id: string;
  readonly routineId: string;
  readonly stepId: string | null;
  readonly occurredOn: string;
  readonly completedAt: string | null;
  readonly zone: string;
  readonly status: RoutineStepStatus;
  readonly note?: string | null;
};

export type RoutineRepository = {
  /** Active routines of a kind, in period order. */
  activeRoutines(kind?: RoutineKind): Promise<Result<readonly Routine[], DomainError>>;
  routineById(id: string): Promise<Result<Routine | null, DomainError>>;
  stepsFor(routineIds: readonly string[]): Promise<Result<readonly RoutineStep[], DomainError>>;
  logsBetween(
    routineIds: readonly string[],
    fromDayKey: string,
    toDayKey: string,
  ): Promise<Result<readonly RoutineLog[], DomainError>>;
  logsForDay(routineIds: readonly string[], dayKey: string): Promise<Result<readonly RoutineLog[], DomainError>>;
  logStep(input: LogStepInput): Promise<Result<RoutineLog, DomainError>>;
  /** Remove a completion the operator un-tapped. */
  clearStep(routineId: string, stepId: string, dayKey: string): Promise<Result<boolean, DomainError>>;
};

export function createRoutineRepository(db: Database): RoutineRepository {
  return {
    async activeRoutines(kind) {
      const rows = await db
        .select()
        .from(routine)
        .where(
          and(
            eq(routine.isActive, true),
            isNull(routine.deletedAt),
            ...(kind === undefined ? [] : [eq(routine.kind, kind)]),
          ),
        )
        // `am` before `pm` is alphabetical by luck; the explicit order is the
        // enum's, so `midday` lands between them rather than at the end.
        .orderBy(asc(routine.kind), sql`array_position(array['am','midday','pm','as_needed'], ${routine.period}::text)`);
      return ok(rows.map(toRoutine));
    },

    async routineById(id) {
      const rows = await db
        .select()
        .from(routine)
        .where(and(eq(routine.id, id), isNull(routine.deletedAt)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toRoutine(rows[0]));
    },

    async stepsFor(routineIds) {
      if (routineIds.length === 0) return ok([]);
      const rows = await db
        .select()
        .from(routineStep)
        .where(and(inArray(routineStep.routineId, [...routineIds]), isNull(routineStep.deletedAt)))
        .orderBy(asc(routineStep.routineId), asc(routineStep.orderIndex));
      return ok(rows.map(toStep));
    },

    async logsBetween(routineIds, fromDayKey, toDayKey) {
      if (routineIds.length === 0) return ok([]);
      const rows = await db
        .select()
        .from(routineLog)
        .where(
          and(
            inArray(routineLog.routineId, [...routineIds]),
            gte(routineLog.occurredOn, fromDayKey),
            lte(routineLog.occurredOn, toDayKey),
          ),
        )
        .orderBy(asc(routineLog.occurredOn));
      return ok(rows.map(toLog));
    },

    async logsForDay(routineIds, dayKey) {
      if (routineIds.length === 0) return ok([]);
      const rows = await db
        .select()
        .from(routineLog)
        .where(and(inArray(routineLog.routineId, [...routineIds]), eq(routineLog.occurredOn, dayKey)));
      return ok(rows.map(toLog));
    },

    async logStep(input) {
      await db
        .insert(routineLog)
        .values({
          id: input.id,
          routineId: input.routineId,
          stepId: input.stepId,
          occurredOn: input.occurredOn,
          completedAt: input.completedAt,
          zone: input.zone,
          status: input.status,
          note: input.note ?? null,
        })
        /*
         * Conflicting on the natural key, not the id. See the file header.
         */
        .onConflictDoUpdate({
          target: [routineLog.routineId, routineLog.stepId, routineLog.occurredOn],
          set: {
            status: input.status,
            completedAt: input.completedAt,
            note: input.note ?? null,
            updatedAt: sql`now()`,
          },
        });

      const rows = await db
        .select()
        .from(routineLog)
        .where(
          and(
            eq(routineLog.routineId, input.routineId),
            input.stepId === null ? isNull(routineLog.stepId) : eq(routineLog.stepId, input.stepId),
            eq(routineLog.occurredOn, input.occurredOn),
          ),
        )
        .limit(1);

      const row = rows[0];
      /*
       * The upsert above guarantees a row, so this is unreachable in practice —
       * but returning the *input* rather than the stored row would hide a
       * divergence between what was asked for and what was kept.
       */
      return ok(row === undefined ? { ...input, note: input.note ?? null } : toLog(row));
    },

    async clearStep(routineId, stepId, dayKey) {
      /*
       * A hard delete, and the only one in this package.
       *
       * `routine_log` has no `deletedAt` — it is not an entity, it is a tally.
       * A soft-deleted completion would still occupy the unique key and block
       * the operator from re-tapping the step, which is the behaviour they will
       * try first when they realise they un-tapped the wrong one.
       */
      const deleted = await db
        .delete(routineLog)
        .where(
          and(
            eq(routineLog.routineId, routineId),
            eq(routineLog.stepId, stepId),
            eq(routineLog.occurredOn, dayKey),
          ),
        )
        .returning({ id: routineLog.id });
      return ok(deleted.length > 0);
    },
  };
}

/** Days on which any step of any of these routines was logged. For streaks. */
export async function loggedDays(
  db: Database,
  routineIds: readonly string[],
  fromDayKey: string,
  toDayKey: string,
): Promise<readonly string[]> {
  if (routineIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ day: routineLog.occurredOn })
    .from(routineLog)
    .where(
      and(
        inArray(routineLog.routineId, [...routineIds]),
        gte(routineLog.occurredOn, fromDayKey),
        lte(routineLog.occurredOn, toDayKey),
      ),
    )
    .orderBy(desc(routineLog.occurredOn));
  return rows.map((row) => row.day);
}

/* -------------------------------------------------------------------------
 * Definition — §2.1's "no manual database intervention required"
 * ---------------------------------------------------------------------- */

export type RoutineDefinition = {
  readonly id: string;
  readonly kind: RoutineKind;
  readonly period: RoutinePeriod;
  readonly name: string;
  readonly isActive: boolean;
  readonly expectedAt: string | null;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly orderIndex: number;
    readonly isOptional: boolean;
    readonly instructions: string | null;
  }[];
};

/**
 * Create or replace a routine and its steps, atomically.
 *
 * ## Steps are soft-deleted, never removed
 *
 * A step dropped from the definition is tombstoned rather than deleted, and the
 * reason is `routine_log`: completions reference `step_id` by foreign key, so a
 * hard delete would either fail or orphan three months of adherence history.
 *
 * The consequence is that `requiredSteps` must only ever see live steps — which
 * `stepsFor` guarantees with `isNull(deletedAt)`. A retired step therefore
 * leaves *past* adherence intact and stops counting towards *future* ratios,
 * which is the only reading of "I dropped the toner" that does not rewrite
 * history.
 *
 * ## The order index is the natural key, so it is reassigned wholesale
 *
 * `routine_step_order_unique` is `(routineId, orderIndex)`. Swapping two steps
 * by updating each in turn transiently violates it, so every surviving step is
 * pushed past the end of the range first and then written to its final
 * position — the standard two-phase renumber, in one transaction.
 */
export async function defineRoutine(
  db: Database,
  definition: RoutineDefinition,
): Promise<Result<Routine, DomainError>> {
  return db.transaction(async (tx) => {
    await tx
      .insert(routine)
      .values({
        id: definition.id,
        kind: definition.kind,
        period: definition.period,
        name: definition.name,
        isActive: definition.isActive,
        expectedAt: definition.expectedAt,
      })
      .onConflictDoUpdate({
        target: routine.id,
        set: {
          kind: definition.kind,
          period: definition.period,
          name: definition.name,
          isActive: definition.isActive,
          expectedAt: definition.expectedAt,
          updatedAt: sql`now()`,
          version: sql`${routine.version} + 1`,
        },
      });

    const keptIds = new Set(definition.steps.map((step) => step.id));

    const existing = await tx
      .select({ id: routineStep.id })
      .from(routineStep)
      .where(and(eq(routineStep.routineId, definition.id), isNull(routineStep.deletedAt)));

    /*
     * Phase one: move every existing step out of the way.
     *
     * Negative indices, which nothing else uses, so the unique constraint
     * cannot be violated part-way through the renumber below.
     */
    for (const [offset, row] of existing.entries()) {
      await tx
        .update(routineStep)
        .set({ orderIndex: -1 - offset })
        .where(eq(routineStep.id, row.id));
    }

    // Tombstone what the operator removed. See the header.
    for (const row of existing) {
      if (keptIds.has(row.id)) continue;
      await tx
        .update(routineStep)
        .set({ deletedAt: sql`now()`, deleteReason: 'removed_from_routine' })
        .where(eq(routineStep.id, row.id));
    }

    // Phase two: write every step at its final position.
    for (const step of definition.steps) {
      await tx
        .insert(routineStep)
        .values({
          id: step.id,
          routineId: definition.id,
          orderIndex: step.orderIndex,
          label: step.label,
          isOptional: step.isOptional,
          instructions: step.instructions,
        })
        .onConflictDoUpdate({
          target: routineStep.id,
          set: {
            orderIndex: step.orderIndex,
            label: step.label,
            isOptional: step.isOptional,
            instructions: step.instructions,
            deletedAt: null,
            updatedAt: sql`now()`,
            version: sql`${routineStep.version} + 1`,
          },
        });
    }

    const rows = await tx.select().from(routine).where(eq(routine.id, definition.id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('routine_not_written');
    }
    return ok(toRoutine(row));
  });
}

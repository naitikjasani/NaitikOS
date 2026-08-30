/**
 * Intake targets, persisted.
 *
 * ## Setting a target closes the previous one; it never updates it
 *
 * The schema explains why the table is time-bounded: "a bulk and a cut have
 * different ones, and §4.10 needs to detect that a bulk target and a
 * visible-abs goal are in tension. A single mutable target row would erase the
 * history that makes that comparison possible."
 *
 * So `setTarget` is two statements — close, then insert — and there is no
 * `updateTarget`. The absence is the feature, the same way `food.addVersion`
 * has no `updateVersion`.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, NutritionTarget } from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { nutritionTarget } from '../schema/nutrition';

function toTarget(row: typeof nutritionTarget.$inferSelect): NutritionTarget {
  return {
    id: row.id,
    phase: row.phase,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    metricKey: row.metricKey,
    targetValue: row.targetValue,
    unit: row.unit,
    toleranceLow: row.toleranceLow,
    toleranceHigh: row.toleranceHigh,
  };
}

export type SetTargetInput = {
  readonly id: string;
  readonly phase: string | null;
  readonly effectiveFrom: string;
  readonly metricKey: string;
  readonly targetValue: string;
  readonly unit: string;
  readonly toleranceLow: string | null;
  readonly toleranceHigh: string | null;
};

export type NutritionTargetRepository = {
  /** Every target ever set, newest first. The phase history §4.10 reads. */
  history(): Promise<Result<readonly NutritionTarget[], DomainError>>;
  setTarget(input: SetTargetInput): Promise<Result<NutritionTarget, DomainError>>;
};

export function createNutritionTargetRepository(db: Database): NutritionTargetRepository {
  return {
    async history() {
      const rows = await db
        .select()
        .from(nutritionTarget)
        .where(isNull(nutritionTarget.deletedAt))
        .orderBy(desc(nutritionTarget.effectiveFrom));
      return ok(rows.map(toTarget));
    },

    async setTarget(input) {
      const written = await db.transaction(async (tx) => {
        /* Close whatever was open for this metric. The new row's start is the
         * old row's end, so there is never a gap and never an overlap. */
        await tx
          .update(nutritionTarget)
          .set({ effectiveTo: input.effectiveFrom })
          .where(
            and(
              eq(nutritionTarget.metricKey, input.metricKey),
              isNull(nutritionTarget.effectiveTo),
              isNull(nutritionTarget.deletedAt),
            ),
          );

        const rows = await tx
          .insert(nutritionTarget)
          .values({
            id: input.id,
            phase: input.phase,
            effectiveFrom: input.effectiveFrom,
            metricKey: input.metricKey,
            targetValue: input.targetValue,
            unit: input.unit,
            toleranceLow: input.toleranceLow,
            toleranceHigh: input.toleranceHigh,
          })
          .onConflictDoNothing()
          .returning();
        return rows[0];
      });

      if (written !== undefined) return ok(toTarget(written));
      const replayed = await db.select().from(nutritionTarget).where(eq(nutritionTarget.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined
        ? { ok: false, error: notFoundError('nutrition_target', input.id) }
        : ok(toTarget(row));
    },
  };
}

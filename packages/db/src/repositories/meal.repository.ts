/**
 * Meals, persisted — and the write that has to be atomic in four places at once.
 *
 * Modelled on `lab.repository.ts`, whose shape is exactly right here: **plan the
 * observations before the transaction opens**, so a metric that is not
 * registered fails the whole write rather than leaving a meal with half its
 * nutrients trending. §9.2 rejects unregistered keys on write and this is where
 * that rejection has to land.
 *
 * Then, in one transaction:
 *
 *   1. `meal` and its `meal_item` rows
 *   2. `food.timesEaten` / `lastEatenAt` bumped — the counters tier 1 reads
 *   3. `meal_template.timesUsed` / `lastUsedAt` bumped when one was used
 *   4. the observations appended
 *
 * ## Deleting a meal has to undo the counters
 *
 * Forgetting is silent and permanent: the suggestion grid stays skewed forever
 * by a meal that no longer exists, and nothing ever surfaces it. There is a
 * test named after that failure.
 *
 * ## One `Meal.Logged` event, not ten `Observation.Recorded`
 *
 * A meal writes around ten observations. `capture-events.ts` maps each
 * observation to a timeline entry unless told otherwise, so one breakfast would
 * become ten rows on the timeline. The nutrition keys are filtered out there
 * and the meal emits a single event — the same treatment
 * `system.daily_close.completed` already gets.
 */

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  MealTemplate,
  Observation,
  ObservationInput,
  ProteinSource,
} from '@naitikos/core';
import {
  mealTotals,
  notFoundError,
  parseTemplateItems,
  prepareObservations,
  proteinBySource,
  toQuantityString,
} from '@naitikos/core';

import type { Database } from '../client';
import type { MealCaptureTier } from '../schema/enums';
import { food, foodNutrient, foodVersion, meal, mealItem, mealTemplate } from '../schema/nutrition';
import { createObservationRepository } from './observation.repository';
import type { WriteContext } from './workout.repository';

export type MealItemRow = {
  readonly id: string;
  readonly mealId: string;
  readonly foodVersionId: string;
  readonly foodId: string;
  readonly foodName: string;
  readonly quantity: string;
  readonly unit: string;
  readonly parsedFromText: string | null;
};

export type MealRow = {
  readonly id: string;
  readonly eatenAt: string;
  readonly zone: string;
  readonly slot: string | null;
  readonly note: string | null;
  readonly templateId: string | null;
  /** §4.3's capture tier. `null` for meals logged before the column existed. */
  readonly captureTier: MealCaptureTier | null;
  readonly items: readonly MealItemRow[];
};

export type LogMealInput = {
  readonly id: string;
  readonly eatenAt: string;
  readonly zone: string;
  readonly slot: string | null;
  readonly note: string | null;
  readonly templateId: string | null;
  readonly captureTier: MealCaptureTier | null;
  readonly items: readonly {
    readonly id: string;
    readonly foodVersionId: string;
    readonly quantity: string;
    readonly unit: string;
    readonly parsedFromText: string | null;
  }[];
};

export type LoggedMeal = {
  readonly mealId: string;
  readonly observationsWritten: number;
  /** Items that produced no nutrition, with why. Shown, never swallowed. */
  readonly unresolved: readonly { readonly itemId: string; readonly reason: string }[];
};

export type MealRepository = {
  mealsBetween(from: string, until: string): Promise<Result<readonly MealRow[], DomainError>>;
  byId(id: string): Promise<Result<MealRow | null, DomainError>>;
  logMeal(input: LogMealInput, context: WriteContext): Promise<Result<LoggedMeal, DomainError>>;
  deleteMeal(id: string, at: string): Promise<Result<boolean, DomainError>>;
  /**
   * How meals in a window were captured — §2.2's ten-second rule, measured.
   *
   * Meals with no recorded tier are omitted rather than bucketed as `manual`.
   * A pre-column meal is a meal whose tier is *unknown*, and counting unknowns
   * as the worst case would report the gate as failing on history that predates
   * it (P5).
   */
  tierMix(from: string, until: string): Promise<Result<readonly MealCaptureTier[], DomainError>>;
  templates(): Promise<Result<readonly MealTemplate[], DomainError>>;
  saveTemplate(input: MealTemplate): Promise<Result<MealTemplate, DomainError>>;
};

function toTemplate(row: typeof mealTemplate.$inferSelect): MealTemplate {
  return {
    id: row.id,
    name: row.name,
    slot: row.slot,
    items: parseTemplateItems(row.items),
    lastUsedAt: row.lastUsedAt,
    timesUsed: row.timesUsed,
  };
}

export function createMealRepository(db: Database): MealRepository {
  const observations = createObservationRepository(db);

  return {
    async mealsBetween(from, until) {
      const rows = await db
        .select({
          meal,
          item: mealItem,
          foodId: foodVersion.foodId,
          foodName: food.name,
        })
        .from(meal)
        .leftJoin(mealItem, and(eq(mealItem.mealId, meal.id), isNull(mealItem.deletedAt)))
        .leftJoin(foodVersion, eq(mealItem.foodVersionId, foodVersion.id))
        .leftJoin(food, eq(foodVersion.foodId, food.id))
        .where(and(isNull(meal.deletedAt), gte(meal.eatenAt, from), lt(meal.eatenAt, until)))
        .orderBy(desc(meal.eatenAt));

      return ok(assemble(rows));
    },

    async byId(id) {
      const rows = await db
        .select({ meal, item: mealItem, foodId: foodVersion.foodId, foodName: food.name })
        .from(meal)
        .leftJoin(mealItem, and(eq(mealItem.mealId, meal.id), isNull(mealItem.deletedAt)))
        .leftJoin(foodVersion, eq(mealItem.foodVersionId, foodVersion.id))
        .leftJoin(food, eq(foodVersion.foodId, food.id))
        .where(and(eq(meal.id, id), isNull(meal.deletedAt)));

      return ok(assemble(rows)[0] ?? null);
    },

    async logMeal(input, context) {
      /* --- read the facts the computation needs ------------------------ */

      const versionIds = [...new Set(input.items.map((item) => item.foodVersionId))];
      if (versionIds.length === 0) {
        return { ok: false, error: notFoundError('meal_item', input.id) };
      }

      /* `inArray`, never interpolation. The ids come from a parsed request
       * body, and §5.14 treats writing the interpolated form at all as the
       * defect — not merely writing it somewhere it happens to be exploitable. */
      const versions = await db.select().from(foodVersion).where(inArray(foodVersion.id, versionIds));
      const nutrientRows = await db
        .select()
        .from(foodNutrient)
        .where(inArray(foodNutrient.foodVersionId, versionIds));

      const foodIds = [...new Set(versions.map((row) => row.foodId))];
      const foods =
        foodIds.length === 0
          ? []
          : await db
              .select({ id: food.id, proteinSource: food.proteinSource })
              .from(food)
              .where(inArray(food.id, foodIds));

      /* --- compute, in core -------------------------------------------- */

      const versionFacts = new Map(
        versions.map((row) => [
          row.id,
          {
            id: row.id,
            foodId: row.foodId,
            basisQuantity: row.basisQuantity,
            basisUnit: row.basisUnit,
            servingQuantity: row.servingQuantity,
            servingUnit: row.servingUnit,
          },
        ]),
      );

      const nutrientsByVersion = new Map<string, { foodVersionId: string; nutrientKey: string; amount: string; unit: string }[]>();
      for (const row of nutrientRows) {
        const bucket = nutrientsByVersion.get(row.foodVersionId) ?? [];
        bucket.push({
          foodVersionId: row.foodVersionId,
          nutrientKey: row.nutrientKey,
          amount: row.amount,
          unit: row.unit,
        });
        nutrientsByVersion.set(row.foodVersionId, bucket);
      }

      const itemFacts = input.items.map((item) => ({
        id: item.id,
        foodVersionId: item.foodVersionId,
        quantity: item.quantity,
        unit: item.unit,
      }));

      const totals = mealTotals(itemFacts, versionFacts, nutrientsByVersion);
      const split = proteinBySource(
        itemFacts,
        versionFacts,
        nutrientsByVersion,
        new Map(foods.map((row) => [row.id, row.proteinSource as ProteinSource | null])),
      );

      /* --- plan the observations *before* the transaction --------------- */

      const planned: ObservationInput[] = [
        ...totals.totals.map((total) => ({
          metricKey: total.metricKey,
          value: { kind: 'number' as const, value: toQuantityString(total.amount) },
          observedAt: input.eatenAt,
          observedZone: input.zone,
          subject: { type: MEAL_SUBJECT_TYPE, id: input.id },
        })),
        ...split.bySource.map((entry) => ({
          metricKey: entry.metricKey,
          value: { kind: 'number' as const, value: toQuantityString(entry.grams) },
          observedAt: input.eatenAt,
          observedZone: input.zone,
          subject: { type: MEAL_SUBJECT_TYPE, id: input.id },
        })),
      ];

      const source = await observations.manualSourceId();
      if (!source.ok) return source;

      const prepared = prepareObservations(planned, context.hlcState, {
        registry: context.registry,
        sourceId: source.value as Observation['sourceId'],
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
        newId: context.newId,
      });
      if (!prepared.ok) return prepared;

      /* --- write ------------------------------------------------------- */

      const inserted = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(meal)
          .values({
            id: input.id,
            eatenAt: input.eatenAt,
            zone: input.zone,
            slot: input.slot,
            note: input.note,
            templateId: input.templateId,
            captureTier: input.captureTier,
          })
          /* §5.7: a replayed outbox entry arrives with the same UUIDv7. */
          .onConflictDoNothing()
          .returning();

        if (rows[0] === undefined) return false;

        await tx.insert(mealItem).values(
          input.items.map((item) => ({
            id: item.id,
            mealId: input.id,
            foodVersionId: item.foodVersionId,
            quantity: item.quantity,
            unit: item.unit,
            parsedFromText: item.parsedFromText,
          })),
        );

        /* The counters tier 1 reads. One statement per food, because the
         * `lastEatenAt` comparison is per row. */
        for (const foodId of foodIds) {
          await tx
            .update(food)
            .set({
              timesEaten: sql`${food.timesEaten} + 1`,
              /* `greatest`, not assignment: back-filling last Tuesday's dinner
               * must not move `lastEatenAt` backwards and demote the food in
               * the recency ranking. */
              lastEatenAt: sql`greatest(coalesce(${food.lastEatenAt}, ${input.eatenAt}), ${input.eatenAt})`,
              updatedAt: sql`now()`,
            })
            .where(eq(food.id, foodId));
        }

        if (input.templateId !== null) {
          await tx
            .update(mealTemplate)
            .set({
              timesUsed: sql`${mealTemplate.timesUsed} + 1`,
              lastUsedAt: input.eatenAt,
              updatedAt: sql`now()`,
            })
            .where(eq(mealTemplate.id, input.templateId));
        }

        return true;
      });

      if (!inserted) {
        /* A replay. The meal, its items, its counters and its observations were
         * all written the first time; doing any of it again would double the
         * counters, which is the one part `ON CONFLICT` cannot protect. */
        return ok({ mealId: input.id, observationsWritten: 0, unresolved: [...totals.unresolved] });
      }

      const appended = await observations.append(prepared.value.observations, prepared.value.supersessions);
      if (!appended.ok) return appended;

      return ok({
        mealId: input.id,
        observationsWritten: appended.value,
        unresolved: [...totals.unresolved],
      });
    },

    async deleteMeal(id, at) {
      const items = await db
        .select({ foodId: foodVersion.foodId })
        .from(mealItem)
        .innerJoin(foodVersion, eq(mealItem.foodVersionId, foodVersion.id))
        .where(and(eq(mealItem.mealId, id), isNull(mealItem.deletedAt)));

      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .update(meal)
          .set({ deletedAt: at, deleteReason: 'removed by operator' })
          .where(and(eq(meal.id, id), isNull(meal.deletedAt)))
          .returning({ id: meal.id });

        if (rows.length === 0) return false;

        await tx.update(mealItem).set({ deletedAt: at }).where(eq(mealItem.mealId, id));

        /*
         * Undo the counters.
         *
         * Forgetting this is silent and permanent: the suggestion grid stays
         * skewed by a meal that no longer exists and nothing ever surfaces it.
         * `lastEatenAt` is deliberately *not* recomputed — that would need a
         * scan of every remaining meal, and being one meal stale in the recency
         * decay is invisible where a wrong `timesEaten` is not.
         */
        for (const foodId of new Set(items.map((row) => row.foodId))) {
          await tx
            .update(food)
            .set({ timesEaten: sql`greatest(0, ${food.timesEaten} - 1)`, updatedAt: sql`now()` })
            .where(eq(food.id, foodId));
        }

        return true;
      });

      return ok(deleted);
    },

    async tierMix(from, until) {
      const rows = await db
        .select({ tier: meal.captureTier })
        .from(meal)
        .where(
          and(
            isNull(meal.deletedAt),
            isNotNull(meal.captureTier),
            gte(meal.eatenAt, from),
            lt(meal.eatenAt, until),
          ),
        );

      return ok(rows.flatMap((row) => (row.tier === null ? [] : [row.tier])));
    },

    async templates() {
      const rows = await db
        .select()
        .from(mealTemplate)
        .where(isNull(mealTemplate.deletedAt))
        .orderBy(desc(mealTemplate.lastUsedAt));
      return ok(rows.map(toTemplate));
    },

    async saveTemplate(input) {
      const rows = await db
        .insert(mealTemplate)
        .values({
          id: input.id,
          name: input.name,
          slot: input.slot,
          items: input.items,
        })
        .onConflictDoUpdate({
          target: mealTemplate.id,
          set: { name: input.name, slot: input.slot, items: input.items, updatedAt: sql`now()` },
        })
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('meal_template', input.id) }
        : ok(toTemplate(row));
    },
  };
}

/** What a nutrition observation's subject points at. */
export const MEAL_SUBJECT_TYPE = 'meal';

type JoinedRow = {
  readonly meal: typeof meal.$inferSelect;
  readonly item: typeof mealItem.$inferSelect | null;
  readonly foodId: string | null;
  readonly foodName: string | null;
};

function assemble(rows: readonly JoinedRow[]): readonly MealRow[] {
  const byId = new Map<string, { row: typeof meal.$inferSelect; items: MealItemRow[] }>();

  for (const row of rows) {
    const entry = byId.get(row.meal.id) ?? { row: row.meal, items: [] };
    if (row.item !== null) {
      entry.items.push({
        id: row.item.id,
        mealId: row.item.mealId,
        foodVersionId: row.item.foodVersionId,
        foodId: row.foodId ?? '',
        foodName: row.foodName ?? '',
        quantity: row.item.quantity,
        unit: row.item.unit,
        parsedFromText: row.item.parsedFromText,
      });
    }
    byId.set(row.meal.id, entry);
  }

  return [...byId.values()].map((entry) => ({
    id: entry.row.id,
    eatenAt: entry.row.eatenAt,
    zone: entry.row.zone,
    slot: entry.row.slot,
    note: entry.row.note,
    templateId: entry.row.templateId,
    captureTier: entry.row.captureTier,
    items: entry.items,
  }));
}

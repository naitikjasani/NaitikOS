/**
 * The food library, persisted — and the one query the ten-second rule depends
 * on.
 *
 * ## `suggestions` is an indexed read, never an aggregate
 *
 * `food.lastEatenAt` and `food.timesEaten` are denormalised, and the schema
 * says why in as many words: "§4.3's first tier is 'recents and frequents — one
 * tap, covers the large majority of real intake', and computing that from
 * `meal_item` at every keystroke would put an aggregate over years of history
 * in front of a ten-second budget."
 *
 * So `food_recent_idx` and `food_frequent_idx` exist, this method reads them,
 * and **nothing here may quietly reintroduce the aggregate**. The ranking
 * itself is `core`'s — `suggestFoods` decays frequency by recency — and this
 * layer supplies the counters it needs.
 *
 * ## A version is never edited
 *
 * §9.2: "Foods are versioned: a nutrition-label change creates a new version,
 * and historical meals keep pointing at the version that was true when eaten."
 * There is therefore an `addVersion` and no `updateVersion`, and the absence is
 * the feature.
 *
 * ## The seed upserts on the folded name, not on an id
 *
 * Re-seeding must not create a second "Paneer", and seeded rows have no
 * client-generated identity to conflict on. Same decision
 * `exercise.repository.ts` makes for the same reason.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Food, FoodNutrient, FoodUsage, FoodVersion, ProteinSource } from '@naitikos/core';
import { foldNutrientName, notFoundError } from '@naitikos/core';

import type { Database, Executor } from '../client';
import { food, foodNutrient, foodVersion, meal, mealItem } from '../schema/nutrition';

function toFood(row: typeof food.$inferSelect): Food {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    gtin: row.gtin,
    lastEatenAt: row.lastEatenAt,
    timesEaten: row.timesEaten,
    isVegetarian: row.isVegetarian,
    isVegan: row.isVegan,
    proteinSource: row.proteinSource as ProteinSource | null,
  };
}

function toVersion(row: typeof foodVersion.$inferSelect): FoodVersion {
  return {
    id: row.id,
    foodId: row.foodId,
    versionNumber: row.versionNumber,
    basisQuantity: row.basisQuantity,
    basisUnit: row.basisUnit,
    servingQuantity: row.servingQuantity,
    servingUnit: row.servingUnit,
    servingLabel: row.servingLabel,
    effectiveFrom: row.effectiveFrom,
    sourceNote: row.sourceNote,
  };
}

function toNutrient(row: typeof foodNutrient.$inferSelect): FoodNutrient {
  return {
    foodVersionId: row.foodVersionId,
    nutrientKey: row.nutrientKey,
    amount: row.amount,
    unit: row.unit,
  };
}

export type CreateFoodInput = {
  readonly id: string;
  readonly name: string;
  readonly brand?: string | null;
  readonly isVegetarian?: boolean | null;
  readonly isVegan?: boolean | null;
  readonly proteinSource?: ProteinSource | null;
  readonly version: {
    readonly id: string;
    readonly basisQuantity: string;
    readonly basisUnit: string;
    readonly servingQuantity?: string | null;
    readonly servingUnit?: string | null;
    readonly servingLabel?: string | null;
    readonly effectiveFrom: string;
    readonly sourceNote?: string | null;
    readonly nutrients: readonly { readonly key: string; readonly amount: string; readonly unit: string }[];
  };
};

export type FoodRepository = {
  /** The whole library. Small at n=1, and the picker ranks it client-side. */
  all(): Promise<Result<readonly Food[], DomainError>>;
  byId(id: string): Promise<Result<Food | null, DomainError>>;
  versionsFor(foodIds: readonly string[]): Promise<Result<readonly FoodVersion[], DomainError>>;
  nutrientsFor(versionIds: readonly string[]): Promise<Result<readonly FoodNutrient[], DomainError>>;
  /** Counters and last-used quantities — everything `suggestFoods` needs. */
  usage(): Promise<Result<readonly FoodUsage[], DomainError>>;
  create(input: CreateFoodInput): Promise<Result<Food, DomainError>>;
  addVersion(input: CreateFoodInput['version'] & { readonly foodId: string }): Promise<Result<FoodVersion, DomainError>>;
  /** Idempotent on the folded name. For the seed only. */
  upsertSeed(input: CreateFoodInput): Promise<Result<boolean, DomainError>>;
};

export function createFoodRepository(db: Database): FoodRepository {
  return {
    async all() {
      const rows = await db.select().from(food).where(isNull(food.deletedAt)).orderBy(asc(food.name));
      return ok(rows.map(toFood));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(food)
        .where(and(eq(food.id, id), isNull(food.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toFood(row));
    },

    async versionsFor(foodIds) {
      if (foodIds.length === 0) return ok([]);
      const rows = await db
        .select()
        .from(foodVersion)
        .where(and(inArray(foodVersion.foodId, [...foodIds]), isNull(foodVersion.deletedAt)))
        .orderBy(asc(foodVersion.foodId), asc(foodVersion.effectiveFrom));
      return ok(rows.map(toVersion));
    },

    async nutrientsFor(versionIds) {
      if (versionIds.length === 0) return ok([]);
      const rows = await db
        .select()
        .from(foodNutrient)
        .where(inArray(foodNutrient.foodVersionId, [...versionIds]));
      return ok(rows.map(toNutrient));
    },

    async usage() {
      /*
       * Two reads, and the first is the fast one.
       *
       * The counters come straight off `food` — one indexed scan, no join. The
       * slot histogram and the last quantity need `meal_item`, so they are a
       * separate query bounded to the recent window rather than a lifetime
       * aggregate. That bound is the difference between a query that stays
       * constant-time and one that degrades over twenty years.
       */
      const counters = await db
        .select({
          id: food.id,
          timesEaten: food.timesEaten,
          lastEatenAt: food.lastEatenAt,
        })
        .from(food)
        .where(isNull(food.deletedAt))
        .orderBy(desc(food.timesEaten));

      const recent = await db
        .select({
          foodId: foodVersion.foodId,
          slot: meal.slot,
          quantity: mealItem.quantity,
          unit: mealItem.unit,
          eatenAt: meal.eatenAt,
        })
        .from(mealItem)
        .innerJoin(foodVersion, eq(mealItem.foodVersionId, foodVersion.id))
        .innerJoin(meal, eq(mealItem.mealId, meal.id))
        .where(and(isNull(meal.deletedAt), sql`${meal.eatenAt} > now() - interval '180 days'`))
        .orderBy(desc(meal.eatenAt))
        .limit(USAGE_SAMPLE_LIMIT);

      const slots = new Map<string, Record<string, number>>();
      const lastQuantity = new Map<string, { quantity: string; unit: string }>();

      for (const row of recent) {
        if (row.slot !== null) {
          const counts = slots.get(row.foodId) ?? {};
          counts[row.slot] = (counts[row.slot] ?? 0) + 1;
          slots.set(row.foodId, counts);
        }
        /* Ordered newest-first, so the first sighting is the latest. */
        if (!lastQuantity.has(row.foodId)) {
          lastQuantity.set(row.foodId, { quantity: row.quantity, unit: row.unit });
        }
      }

      return ok(
        counters.map((row) => ({
          foodId: row.id,
          timesEaten: row.timesEaten,
          lastEatenAt: row.lastEatenAt,
          slotCounts: slots.get(row.id) ?? {},
          lastQuantity: lastQuantity.get(row.id)?.quantity ?? null,
          lastUnit: lastQuantity.get(row.id)?.unit ?? null,
        })),
      );
    },

    async create(input) {
      const written = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(food)
          .values({
            id: input.id,
            name: input.name,
            brand: input.brand ?? null,
            isVegetarian: input.isVegetarian ?? null,
            isVegan: input.isVegan ?? null,
            proteinSource: input.proteinSource ?? null,
          })
          .onConflictDoNothing()
          .returning();

        if (rows[0] !== undefined) await insertVersion(tx, input.id, 1, input.version);
        return rows[0];
      });

      if (written !== undefined) return ok(toFood(written));
      const replayed = await db.select().from(food).where(eq(food.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined ? { ok: false, error: notFoundError('food', input.id) } : ok(toFood(row));
    },

    async addVersion(input) {
      const existing = await db
        .select({ versionNumber: foodVersion.versionNumber })
        .from(foodVersion)
        .where(eq(foodVersion.foodId, input.foodId))
        .orderBy(desc(foodVersion.versionNumber))
        .limit(1);

      const next = (existing[0]?.versionNumber ?? 0) + 1;
      const rows = await insertVersion(db, input.foodId, next, input);
      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('food_version', input.id) }
        : ok(toVersion(row));
    },

    async upsertSeed(input) {
      /*
       * Matched on the folded name — "Toor dal, cooked" and "toor dal cooked"
       * are the same food, and a re-seed must not produce two.
       */
      const folded = foldNutrientName(input.name);
      const existing = await db.select({ id: food.id, name: food.name }).from(food).where(isNull(food.deletedAt));
      const match = existing.find((row) => foldNutrientName(row.name) === folded);
      if (match !== undefined) return ok(false);

      const created = await this.create(input);
      return created.ok ? ok(true) : created;
    },
  };
}

/**
 * How many recent meal items feed the slot histogram.
 *
 * Bounded so this stays constant-time. Two thousand items is roughly a year of
 * four-item meals; past that, a slot preference has long since stabilised and
 * the older rows would not move the ranking.
 */
export const USAGE_SAMPLE_LIMIT = 2000;

/**
 * `Executor`, not `Database` — this runs both inside `create`'s transaction and
 * standalone from `addVersion`. See `client.ts` for why the two are distinct
 * types rather than one.
 */
async function insertVersion(
  executor: Executor,
  foodId: string,
  versionNumber: number,
  version: CreateFoodInput['version'],
): Promise<(typeof foodVersion.$inferSelect)[]> {
  const rows = await executor
    .insert(foodVersion)
    .values({
      id: version.id,
      foodId,
      versionNumber,
      basisQuantity: version.basisQuantity,
      basisUnit: version.basisUnit,
      servingQuantity: version.servingQuantity ?? null,
      servingUnit: version.servingUnit ?? null,
      servingLabel: version.servingLabel ?? null,
      effectiveFrom: version.effectiveFrom,
      sourceNote: version.sourceNote ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (rows[0] !== undefined && version.nutrients.length > 0) {
    await executor
      .insert(foodNutrient)
      .values(
        version.nutrients.map((entry) => ({
          id: crypto.randomUUID(),
          foodVersionId: version.id,
          nutrientKey: entry.key,
          amount: entry.amount,
          unit: entry.unit,
        })),
      )
      .onConflictDoNothing();
  }

  return rows;
}

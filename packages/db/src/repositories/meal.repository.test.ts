/**
 * Meals — integration, against real Postgres.
 *
 * `core` tests the arithmetic: `mealTotals` converts units, `basisMultiple`
 * refuses a cross-dimension one, `evaluateTargets` reports under and over. None
 * of that needs a database.
 *
 * What needs a database is the part that has bitten this codebase before: a
 * **denormalised counter written inside a transaction**. `food.timesEaten` and
 * `food.lastEatenAt` exist so the suggestion ranking never aggregates over
 * `meal_item`, and they are the only numbers in the module that are not derived
 * on read. Every test below that is not the happy path is about them.
 *
 * The three failures each test is named after:
 *
 *  1. **A replayed meal counts twice.** `ON CONFLICT DO NOTHING` protects the
 *     rows and does nothing at all for `timesEaten += 1`. §5.7 makes replay
 *     ordinary, not exceptional — the outbox retries on every flaky connection.
 *  2. **A deleted meal leaves its count behind**, so a food eaten once and
 *     removed outranks a food eaten once and kept, forever.
 *  3. **The observations and the meal disagree**, because the totals were
 *     written outside the meal's transaction.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { MetricRegistry } from '@naitikos/core';
import {
  activeTargets,
  evaluateTargets,
  formatMeasured,
  initialHlcState,
  nutritionMetricKey,
  parseDecimal,
  toQuantityString,
} from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createFoodRepository } from './food.repository';
import { createMealRepository, type LogMealInput } from './meal.repository';
import { createMetricRepository } from './metric.repository';
import { createNutritionTargetRepository } from './nutrition-target.repository';
import { createObservationRepository } from './observation.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

/** 2026-11-25, mid-morning in Kolkata. Inside one zoned day, deliberately. */
const EATEN_AT = '2026-11-25T04:00:00.000Z';

async function registry(): Promise<MetricRegistry> {
  if (db === undefined) throw new Error('no database');
  const result = await createMetricRepository(db).registry();
  if (!isOk(result)) throw new Error('registry unavailable');
  return result.value;
}

async function context(): Promise<Parameters<ReturnType<typeof createMealRepository>['logMeal']>[1]> {
  return {
    registry: await registry(),
    hlcState: initialHlcState('test-device', EPOCH),
    recordedAt: EATEN_AT,
    physicalMillis: EPOCH,
    newId,
  };
}

/**
 * One food, one version, per 100 g: 25 g protein, 400 kcal.
 *
 * Round numbers so a wrong multiple is obvious in the assertion rather than
 * arguable — 150 g must be exactly 37.5 g of protein, and nothing else.
 */
async function seedOats(): Promise<{ readonly foodId: string; readonly versionId: string }> {
  if (db === undefined) throw new Error('no database');
  const foodId = newId();
  const versionId = newId();

  const created = await createFoodRepository(db).create({
    id: foodId,
    name: 'Oats',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    version: {
      id: versionId,
      basisQuantity: '100',
      basisUnit: 'g',
      servingQuantity: '40',
      servingUnit: 'g',
      servingLabel: 'one bowl',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      sourceNote: 'Hand-entered for the test.',
      nutrients: [
        { key: 'protein', amount: '25', unit: 'g' },
        { key: 'energy', amount: '400', unit: 'kcal' },
      ],
    },
  });
  if (!isOk(created)) throw new Error('food not created');

  return { foodId, versionId };
}

function mealOf(versionId: string, quantity: string, overrides: Partial<LogMealInput> = {}): LogMealInput {
  return {
    id: newId(),
    eatenAt: EATEN_AT,
    zone: ZONE,
    slot: 'breakfast',
    note: null,
    templateId: null,
    captureTier: 'suggestion',
    items: [{ id: newId(), foodVersionId: versionId, quantity, unit: 'g', parsedFromText: null }],
    ...overrides,
  };
}

suite('meal repository', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await resetDomainTables(db.$client);
  });

  it('logs a meal, writes its nutrients as observations, and evaluates them against a target', async () => {
    if (db === undefined) return;
    const { versionId } = await seedOats();

    const logged = await createMealRepository(db).logMeal(mealOf(versionId, '150'), await context());
    expect(isOk(logged)).toBe(true);
    if (!isOk(logged)) return;

    expect(logged.value.unresolved).toEqual([]);
    expect(logged.value.observationsWritten).toBeGreaterThan(0);

    const observations = await createObservationRepository(db).query({
      metricKeys: [nutritionMetricKey('protein')],
      currentOnly: true,
    });
    expect(isOk(observations)).toBe(true);
    if (!isOk(observations)) return;

    /*
     * 150 g of a per-100 g basis is 1.5×, and 1.5 × 25 is 37.5.
     *
     * Compared through `formatMeasured` rather than against a `Decimal`
     * literal, because the column is `numeric(20, 6)` and reads back as
     * `37.500000`. That is the *same number* at a different scale, and a
     * structural comparison would fail on storage precision while asserting
     * nothing about the arithmetic. Not `Number(...)` either: §5.3 keeps floats
     * off this path, and `37.499999999999996` is the defect the rule exists to
     * prevent.
     */
    const protein = observations.value[0];
    expect(protein).toBeDefined();
    expect(formatMeasured(protein?.value ?? '')).toBe('37.5');

    const target = await createNutritionTargetRepository(db).setTarget({
      id: newId(),
      phase: 'bulk',
      effectiveFrom: '2026-11-01T00:00:00.000Z',
      metricKey: nutritionMetricKey('protein'),
      targetValue: '150',
      unit: 'g',
      toleranceLow: null,
      toleranceHigh: null,
    });
    expect(isOk(target)).toBe(true);

    const history = await createNutritionTargetRepository(db).history();
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;

    /* Read back at the column's scale, so the remaining figure is compared the
     * way the screen will compute it rather than at a scale nothing produces. */
    const stored = parseDecimal(protein?.value ?? '') ?? { unscaled: 0n, scale: 0 };
    const totals = new Map([[nutritionMetricKey('protein'), stored]]);
    const evaluated = evaluateTargets(totals, activeTargets(history.value, EATEN_AT));

    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.status).toBe('under');
    expect(formatMeasured(toQuantityString(evaluated[0]?.remaining ?? stored))).toBe('112.5');
  });

  it('resolves a pseudo-unit against the version’s own serving row', async () => {
    if (db === undefined) return;
    const { versionId } = await seedOats();

    /* One "bowl" is 40 g on this version, so one serving is 0.4× the basis and
     * 10 g of protein. The pseudo-unit is resolved from the row, never from a
     * global table of what a bowl is — there is no such thing. */
    const logged = await createMealRepository(db).logMeal(
      mealOf(versionId, '1', {
        items: [{ id: newId(), foodVersionId: versionId, quantity: '1', unit: 'serving', parsedFromText: null }],
      }),
      await context(),
    );
    expect(isOk(logged)).toBe(true);
    if (!isOk(logged)) return;
    expect(logged.value.unresolved).toEqual([]);

    const observations = await createObservationRepository(db).query({
      metricKeys: [nutritionMetricKey('protein')],
      currentOnly: true,
    });
    if (!isOk(observations)) return;
    expect(formatMeasured(observations.value[0]?.value ?? '')).toBe('10');
  });

  it('does not increment timesEaten twice when the outbox replays the same meal', async () => {
    if (db === undefined) return;
    const { foodId, versionId } = await seedOats();
    const meals = createMealRepository(db);

    const input = mealOf(versionId, '100');
    const first = await meals.logMeal(input, await context());
    const second = await meals.logMeal(input, await context());

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);

    const usage = await createFoodRepository(db).usage();
    if (!isOk(usage)) return;

    /*
     * One, not two. `ON CONFLICT DO NOTHING` keeps the rows unique and has no
     * opinion whatsoever about `timesEaten += 1`, so the replay check in
     * `logMeal` is the only thing standing between a flaky connection and a
     * suggestion ranking that believes breakfast is eaten twice as often as it
     * is.
     */
    expect(usage.value.find((entry) => entry.foodId === foodId)?.timesEaten).toBe(1);

    const observations = await createObservationRepository(db).query({
      metricKeys: [nutritionMetricKey('protein')],
      currentOnly: true,
    });
    if (!isOk(observations)) return;
    expect(observations.value).toHaveLength(1);
  });

  it('restores timesEaten when a meal is deleted, so a removed meal does not outrank a kept one', async () => {
    if (db === undefined) return;
    const { foodId, versionId } = await seedOats();
    const meals = createMealRepository(db);

    const logged = await meals.logMeal(mealOf(versionId, '100'), await context());
    if (!isOk(logged)) return;

    const removed = await meals.deleteMeal(logged.value.mealId, '2026-11-25T06:00:00.000Z');
    expect(isOk(removed)).toBe(true);

    const usage = await createFoodRepository(db).usage();
    if (!isOk(usage)) return;
    expect(usage.value.find((entry) => entry.foodId === foodId)?.timesEaten).toBe(0);
  });

  it('records the capture tier, so §2.2’s ten-second rule can be checked', async () => {
    if (db === undefined) return;
    const { versionId } = await seedOats();
    const meals = createMealRepository(db);

    await meals.logMeal(mealOf(versionId, '100', { captureTier: 'template' }), await context());
    await meals.logMeal(mealOf(versionId, '100', { captureTier: 'manual' }), await context());
    /* A meal with no tier — the shape of every meal written before the column
     * existed. It must be *omitted*, not counted as the worst case. */
    await meals.logMeal(mealOf(versionId, '100', { captureTier: null }), await context());

    const tiers = await meals.tierMix('2026-11-24T00:00:00.000Z', '2026-11-26T00:00:00.000Z');
    expect(isOk(tiers)).toBe(true);
    if (!isOk(tiers)) return;

    expect([...tiers.value].sort()).toEqual(['manual', 'template']);
  });

  it('reports an item it could not resolve rather than silently dropping it', async () => {
    if (db === undefined) return;
    const { versionId } = await seedOats();

    /*
     * Millilitres against a per-gram basis. Mass and volume are different
     * dimensions and there is no density on a food row, so converting would be
     * an invented number in an append-only log. The item is refused, named, and
     * the rest of the meal still lands.
     */
    const logged = await createMealRepository(db).logMeal(
      mealOf(versionId, '100', {
        items: [{ id: newId(), foodVersionId: versionId, quantity: '100', unit: 'mL', parsedFromText: '100ml oats' }],
      }),
      await context(),
    );
    expect(isOk(logged)).toBe(true);
    if (!isOk(logged)) return;

    expect(logged.value.unresolved).toHaveLength(1);
    expect(logged.value.unresolved[0]?.reason).toBe('incomparable_unit');
    expect(logged.value.observationsWritten).toBe(0);
  });
});

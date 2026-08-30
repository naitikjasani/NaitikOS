import { describe, expect, it } from 'vitest';

import type { Food, FoodVersion } from './food';
import { currentFoodVersion, foodLabel, searchFoods, versionAt } from './food';
import type { FoodUsage, TemplateUsage } from './ranking';
import { MAX_SUGGESTIONS, rankTemplates, slotForLocalTime, suggestFoods } from './ranking';
import type { MealTemplate } from './template';
import { parseTemplateItems, resolveTemplate, templateDrift, templateFromMeal } from './template';
import type { NutritionTarget } from './targets';
import { activeTargets, evaluateTargets, phaseFor } from './targets';
import { parseDecimal } from '../../units/decimal';

const NOW = '2026-11-20T08:00:00.000Z';

function usage(overrides: Partial<FoodUsage> & Pick<FoodUsage, 'foodId'>): FoodUsage {
  return {
    timesEaten: 1,
    lastEatenAt: NOW,
    slotCounts: {},
    lastQuantity: null,
    lastUnit: null,
    ...overrides,
  };
}

describe('suggesting foods', () => {
  /**
   * The failure pure recency produces: one restaurant dessert eaten yesterday
   * outranks the oats eaten every morning for a year.
   */
  it('ranks the daily staple above yesterday’s one-off', () => {
    const ranked = suggestFoods(
      [
        usage({ foodId: 'oats', timesEaten: 200, lastEatenAt: '2026-11-19T08:00:00.000Z' }),
        usage({ foodId: 'cake', timesEaten: 1, lastEatenAt: '2026-11-19T20:00:00.000Z' }),
      ],
      { nowIso: NOW, slot: null },
    );
    expect(ranked[0]?.foodId).toBe('oats');
  });

  /**
   * The failure pure frequency produces: six months of old habits outvote three
   * weeks of the new staple, and the grid freezes after a diet change.
   */
  it('lets a current staple overtake an abandoned one', () => {
    const ranked = suggestFoods(
      [
        // Eaten often, but not for three months.
        usage({ foodId: 'old', timesEaten: 120, lastEatenAt: '2026-08-20T08:00:00.000Z' }),
        // Eaten far less, but this week.
        usage({ foodId: 'new', timesEaten: 20, lastEatenAt: '2026-11-19T08:00:00.000Z' }),
      ],
      { nowIso: NOW, slot: null },
    );
    expect(ranked[0]?.foodId).toBe('new');
  });

  it('lifts a food usually eaten at this slot without excluding the others', () => {
    const ranked = suggestFoods(
      [
        usage({ foodId: 'eggs', timesEaten: 40, slotCounts: { breakfast: 40 } }),
        usage({ foodId: 'dal', timesEaten: 40, slotCounts: { dinner: 40 } }),
      ],
      { nowIso: NOW, slot: 'breakfast' },
    );
    expect(ranked[0]?.foodId).toBe('eggs');
    /* Not filtered: an empty grid at an unusual hour sends the operator to
     * search, which is the failure condition §2.2 names. */
    expect(ranked).toHaveLength(2);
  });

  it('keeps a never-eaten food reachable, ranked last', () => {
    const ranked = suggestFoods(
      [usage({ foodId: 'new', timesEaten: 0, lastEatenAt: null }), usage({ foodId: 'oats', timesEaten: 50 })],
      { nowIso: NOW, slot: null },
    );
    expect(ranked.map((entry) => entry.foodId)).toEqual(['oats', 'new']);
  });

  it('caps the grid, because a longer one is a menu', () => {
    const many = Array.from({ length: 40 }, (_, index) => usage({ foodId: `f${String(index)}`, timesEaten: index }));
    expect(suggestFoods(many, { nowIso: NOW, slot: null })).toHaveLength(MAX_SUGGESTIONS);
  });

  /** The move the whole design rests on: a repeat quantity is typed once. */
  it('carries the last quantity through as the tile default', () => {
    const ranked = suggestFoods(
      [usage({ foodId: 'oats', timesEaten: 10, lastQuantity: '100', lastUnit: 'g' })],
      { nowIso: NOW, slot: null },
    );
    expect(ranked[0]?.defaultQuantity).toBe('100');
    expect(ranked[0]?.defaultUnit).toBe('g');
  });
});

describe('ranking templates', () => {
  const template = (id: string, slot: string | null, timesUsed: number, lastUsedAt: string | null): TemplateUsage => ({
    templateId: id,
    slot,
    timesUsed,
    lastUsedAt,
  });

  /**
   * A template *names* a meal, so showing "usual breakfast" at dinner is showing
   * the wrong object rather than a lower-ranked one. The asymmetry with foods is
   * deliberate.
   */
  it('filters by slot rather than merely lifting', () => {
    const ranked = rankTemplates(
      [template('breakfast', 'breakfast', 50, NOW), template('dinner', 'dinner', 50, NOW)],
      'breakfast',
      NOW,
    );
    expect(ranked).toEqual(['breakfast']);
  });

  it('keeps a slotless template eligible everywhere', () => {
    const ranked = rankTemplates([template('any', null, 5, NOW)], 'dinner', NOW);
    expect(ranked).toEqual(['any']);
  });

  /** A template nobody can find never gets its second use, and tier 2 dies. */
  it('surfaces a template that has been defined but never used', () => {
    const ranked = rankTemplates([template('fresh', null, 0, null)], null, NOW);
    expect(ranked).toEqual(['fresh']);
  });
});

describe('slots', () => {
  it('guesses from the wall clock', () => {
    expect(slotForLocalTime('08:00')).toBe('breakfast');
    expect(slotForLocalTime('13:30')).toBe('lunch');
    expect(slotForLocalTime('20:15')).toBe('dinner');
    expect(slotForLocalTime('03:00')).toBe('snack');
    expect(slotForLocalTime('nonsense')).toBe('snack');
  });
});

/* =========================================================================
 * Food versions
 * ====================================================================== */

describe('food versions', () => {
  const version = (id: string, number: number, from: string): FoodVersion => ({
    id,
    foodId: 'f',
    versionNumber: number,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    effectiveFrom: from,
    sourceNote: null,
  });

  const versions = [
    version('v1', 1, '2026-01-01T00:00:00.000Z'),
    version('v2', 2, '2026-11-19T00:00:00.000Z'),
  ];

  /**
   * The bug this prevents: logging yesterday's dinner this morning, after an
   * overnight reformulation, must pin *yesterday's* label. `max(versionNumber)`
   * would silently not.
   */
  it('pins the version in force when the meal was eaten', () => {
    expect(versionAt(versions, '2026-11-18T20:00:00.000Z')?.id).toBe('v1');
    expect(versionAt(versions, '2026-11-20T08:00:00.000Z')?.id).toBe('v2');
    expect(currentFoodVersion(versions, NOW)?.id).toBe('v2');
  });

  /**
   * A meal predating every label is not unloggable. The earliest version is the
   * closest thing to the truth available, and `null` would block a back-fill
   * for a reason the operator cannot act on.
   */
  it('falls back to the earliest version for a meal older than any label', () => {
    expect(versionAt(versions, '2020-01-01T00:00:00.000Z')?.id).toBe('v1');
    expect(versionAt([], NOW)).toBeNull();
  });
});

describe('food search', () => {
  const food = (id: string, name: string, brand: string | null, timesEaten: number): Food => ({
    id,
    name,
    brand,
    gtin: null,
    lastEatenAt: null,
    timesEaten,
    isVegetarian: true,
    isVegan: false,
    proteinSource: null,
  });

  const library = [food('a', 'Oats', null, 40), food('b', 'Oat milk', 'Alpro', 2)];

  it('prefers the exact and prefix match over a substring', () => {
    expect(searchFoods(library, 'oats')[0]?.food.id).toBe('a');
    expect(searchFoods(library, 'oat milk')[0]?.food.id).toBe('b');
  });

  it('labels with the brand when there is one', () => {
    expect(foodLabel(food('b', 'Oat milk', 'Alpro', 0))).toBe('Alpro Oat milk');
    expect(foodLabel(food('a', 'Oats', null, 0))).toBe('Oats');
  });

  it('returns nothing for an empty term rather than everything', () => {
    expect(searchFoods(library, '   ')).toEqual([]);
  });
});

/* =========================================================================
 * Templates
 * ====================================================================== */

describe('templates', () => {
  const version: FoodVersion = {
    id: 'v1',
    foodId: 'oats',
    versionNumber: 1,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    sourceNote: null,
  };

  const template: MealTemplate = {
    id: 't1',
    name: 'Usual breakfast',
    slot: 'breakfast',
    items: [{ foodId: 'oats', quantity: '100', unit: 'g' }],
    lastUsedAt: null,
    timesUsed: 0,
  };

  it('resolves to the versions in force at the meal’s own time', () => {
    const resolved = resolveTemplate(template, new Map([['oats', [version]]]), NOW);
    expect(resolved.items[0]?.foodVersionId).toBe('v1');
    expect(resolved.missing).toEqual([]);
  });

  it('reports a food with no version rather than dropping it', () => {
    const resolved = resolveTemplate(template, new Map(), NOW);
    expect(resolved.items).toEqual([]);
    expect(resolved.missing).toEqual(['oats']);
  });

  /** This is the P1 capture surface. It does not get to crash on bad jsonb. */
  it('parses the untyped jsonb defensively', () => {
    expect(parseTemplateItems([{ foodId: 'a', quantity: 100, unit: 'g' }])).toEqual([
      { foodId: 'a', quantity: '100', unit: 'g' },
    ]);
    expect(parseTemplateItems([{ foodId: 'a' }, null, 'nonsense', 42])).toEqual([]);
    expect(parseTemplateItems('not an array')).toEqual([]);
  });

  it('is created from a meal, which is the only creation path', () => {
    const made = templateFromMeal('t2', '  Usual lunch ', 'lunch', [{ foodId: 'dal', quantity: '200', unit: 'g' }]);
    expect(made.name).toBe('Usual lunch');
    expect(made.timesUsed).toBe(0);
    expect(made.items).toHaveLength(1);
  });

  /**
   * A "usual breakfast" that has not been the usual breakfast since March is a
   * template the operator stops trusting and then stops using — which is tier 2
   * dying quietly.
   */
  it('reports drift once there is enough evidence, and not before', () => {
    const meals = Array.from({ length: 5 }, () => [
      { foodId: 'oats', quantity: '100', unit: 'g' },
      { foodId: 'whey', quantity: '1', unit: 'scoop' },
    ]);
    const drift = templateDrift(template, meals);
    expect(drift.missingFromTemplate).toEqual(['whey']);
    expect(drift.unusedInPractice).toEqual([]);

    /* Two mornings is a coincidence, not a change of habit. */
    expect(templateDrift(template, meals.slice(0, 2)).missingFromTemplate).toEqual([]);
  });
});

/* =========================================================================
 * Targets
 * ====================================================================== */

describe('targets', () => {
  const target = (overrides: Partial<NutritionTarget> & Pick<NutritionTarget, 'id' | 'metricKey'>): NutritionTarget => ({
    phase: 'bulk',
    effectiveFrom: '2026-11-01T00:00:00.000Z',
    effectiveTo: null,
    targetValue: '180',
    unit: 'g',
    toleranceLow: null,
    toleranceHigh: null,
    ...overrides,
  });

  it('resolves the target in force, ignoring a closed one', () => {
    const active = activeTargets(
      [
        target({ id: 'old', metricKey: 'nutrition.protein', targetValue: '150', effectiveTo: '2026-11-01T00:00:00.000Z' }),
        target({ id: 'now', metricKey: 'nutrition.protein' }),
      ],
      NOW,
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe('now');
  });

  it('reports the phase, so the trends chart can band by it', () => {
    expect(phaseFor([target({ id: 'a', metricKey: 'nutrition.energy' })], NOW)).toBe('bulk');
    expect(phaseFor([], NOW)).toBeNull();
  });

  it('computes what is left, which is the number that gets the next meal logged', () => {
    const totals = new Map([['nutrition.protein', parseDecimal('93') as NonNullable<ReturnType<typeof parseDecimal>>]]);
    const [evaluation] = evaluateTargets(totals, [target({ id: 'a', metricKey: 'nutrition.protein' })]);
    expect(Number(evaluation?.remaining?.unscaled)).toBe(87);
    expect(evaluation?.status).toBe('under');
  });

  /**
   * Nothing logged is not the same as nothing eaten, and reporting a blank
   * morning as a shortfall is the guilt framing §4.7 and §14.1 rule out.
   */
  it('says nothing logged rather than under when the day is empty', () => {
    const [evaluation] = evaluateTargets(new Map(), [target({ id: 'a', metricKey: 'nutrition.protein' })]);
    expect(evaluation?.status).toBe('unknown');
    expect(evaluation?.actual).toBeNull();
  });

  /**
   * An invented ±10% band reading "within" is a claim the operator never made.
   */
  it('only reports "within" when a band was actually set', () => {
    const totals = new Map([['nutrition.protein', parseDecimal('180') as NonNullable<ReturnType<typeof parseDecimal>>]]);

    const bare = evaluateTargets(totals, [target({ id: 'a', metricKey: 'nutrition.protein' })]);
    expect(bare[0]?.hasBand).toBe(false);
    expect(bare[0]?.status).not.toBe('within');

    const banded = evaluateTargets(totals, [
      target({ id: 'b', metricKey: 'nutrition.protein', toleranceLow: '170', toleranceHigh: '200' }),
    ]);
    expect(banded[0]?.hasBand).toBe(true);
    expect(banded[0]?.status).toBe('within');
  });
});

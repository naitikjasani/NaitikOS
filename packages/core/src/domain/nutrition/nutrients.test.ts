import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../../units/decimal';
import { NUTRITION_METRICS } from './metrics';
import { NUTRIENTS, nutrientFor, nutritionMetricKey, normaliseNutrientUnit, fromInternationalUnits } from './nutrient';
import type { FoodVersionFacts, MealItemFacts, NutrientRow } from './nutrients';
import { basisMultiple, isPseudoUnit, mealTotals, proteinBySource } from './nutrients';

const OATS: FoodVersionFacts = {
  id: 'v-oats',
  foodId: 'f-oats',
  basisQuantity: '100',
  basisUnit: 'g',
  servingQuantity: null,
  servingUnit: null,
};

const WHEY: FoodVersionFacts = {
  id: 'v-whey',
  foodId: 'f-whey',
  basisQuantity: '100',
  basisUnit: 'g',
  /* One scoop is 30 g. Without this row a scoop cannot be resolved at all. */
  servingQuantity: '30',
  servingUnit: 'g',
};

const OAT_NUTRIENTS: readonly NutrientRow[] = [
  { foodVersionId: 'v-oats', nutrientKey: 'energy', amount: '389', unit: 'kcal' },
  { foodVersionId: 'v-oats', nutrientKey: 'protein', amount: '16.9', unit: 'g' },
  /* A nutrient the catalogue does not know. Kept in the row, skipped in the
   * total — see the note in `mealTotals`. */
  { foodVersionId: 'v-oats', nutrientKey: 'potassium', amount: '429', unit: 'mg' },
];

const WHEY_NUTRIENTS: readonly NutrientRow[] = [
  { foodVersionId: 'v-whey', nutrientKey: 'protein', amount: '80', unit: 'g' },
];

const versions = new Map([
  ['v-oats', OATS],
  ['v-whey', WHEY],
]);
const nutrients = new Map([
  ['v-oats', OAT_NUTRIENTS],
  ['v-whey', WHEY_NUTRIENTS],
]);

const item = (overrides: Partial<MealItemFacts> & Pick<MealItemFacts, 'id' | 'foodVersionId'>): MealItemFacts => ({
  quantity: '100',
  unit: 'g',
  ...overrides,
});

describe('the basis multiple', () => {
  it('is one when the item matches the basis exactly', () => {
    const result = basisMultiple({ quantity: '100', unit: 'g' }, OATS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(formatDecimal(result.multiple))).toBeCloseTo(1, 6);
  });

  it('converts within a dimension', () => {
    const result = basisMultiple({ quantity: '0.15', unit: 'kg' }, OATS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(formatDecimal(result.multiple))).toBeCloseTo(1.5, 6);
  });

  /**
   * A scoop is not a unit; it is a per-food alias. Registering it globally
   * would let a scoop of whey convert into a scoop of oats.
   */
  it('resolves a pseudo-unit against the version’s own serving row', () => {
    const result = basisMultiple({ quantity: '2', unit: 'scoop' }, WHEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 scoops × 30 g = 60 g, against a 100 g basis.
    expect(Number(formatDecimal(result.multiple))).toBeCloseTo(0.6, 6);
  });

  it('refuses a pseudo-unit when the version defines no serving', () => {
    const result = basisMultiple({ quantity: '1', unit: 'serving' }, OATS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_serving_defined');
  });

  /**
   * `food_version` has no density column and inventing one is the class of
   * error §6.2 exists to prevent.
   */
  it('refuses a cross-dimension quantity rather than guessing a density', () => {
    const result = basisMultiple({ quantity: '150', unit: 'mL' }, OATS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomparable_unit');
  });

  it('refuses an unregistered unit and an unreadable quantity', () => {
    expect(basisMultiple({ quantity: '1', unit: 'handful' }, OATS).ok).toBe(false);
    expect(basisMultiple({ quantity: 'some', unit: 'g' }, OATS).ok).toBe(false);
  });

  it('knows which strings are pseudo-units', () => {
    expect(isPseudoUnit('scoop')).toBe(true);
    expect(isPseudoUnit('Roti')).toBe(true);
    expect(isPseudoUnit('g')).toBe(false);
  });
});

describe('meal totals', () => {
  it('scales every nutrient by the item’s multiple', () => {
    const { totals, unresolved } = mealTotals(
      [item({ id: 'i1', foodVersionId: 'v-oats', quantity: '50', unit: 'g' })],
      versions,
      nutrients,
    );

    expect(unresolved).toEqual([]);
    const energy = totals.find((total) => total.metricKey === nutritionMetricKey('energy'));
    const protein = totals.find((total) => total.metricKey === nutritionMetricKey('protein'));
    expect(Number(formatDecimal(energy?.amount ?? { unscaled: 0n, scale: 0 }))).toBeCloseTo(194.5, 3);
    expect(Number(formatDecimal(protein?.amount ?? { unscaled: 0n, scale: 0 }))).toBeCloseTo(8.45, 3);
  });

  it('sums the same nutrient across items', () => {
    const { totals } = mealTotals(
      [
        item({ id: 'i1', foodVersionId: 'v-oats', quantity: '100', unit: 'g' }),
        item({ id: 'i2', foodVersionId: 'v-whey', quantity: '1', unit: 'scoop' }),
      ],
      versions,
      nutrients,
    );

    const protein = totals.find((total) => total.metricKey === nutritionMetricKey('protein'));
    // 16.9 g from oats + (80 × 0.3) = 24 g from whey.
    expect(Number(formatDecimal(protein?.amount ?? { unscaled: 0n, scale: 0 }))).toBeCloseTo(40.9, 3);
  });

  /**
   * `food_nutrient` is row-per-nutrient precisely so a label can carry
   * potassium before this system registers a metric for it. Flagging that as
   * unresolved would mark every complete label as partial.
   */
  it('skips an uncatalogued nutrient without calling the item unresolved', () => {
    const { totals, unresolved } = mealTotals(
      [item({ id: 'i1', foodVersionId: 'v-oats' })],
      versions,
      nutrients,
    );
    expect(unresolved).toEqual([]);
    expect(totals.some((total) => total.metricKey.includes('potassium'))).toBe(false);
  });

  /** The `lab.repository.ts` honesty pattern: reported, never silently zero. */
  it('reports an item it could not resolve rather than contributing zero', () => {
    const { totals, unresolved } = mealTotals(
      [
        item({ id: 'good', foodVersionId: 'v-oats' }),
        item({ id: 'bad', foodVersionId: 'v-missing' }),
        item({ id: 'volume', foodVersionId: 'v-oats', quantity: '200', unit: 'mL' }),
      ],
      versions,
      nutrients,
    );

    expect(unresolved).toHaveLength(2);
    expect(unresolved.find((entry) => entry.itemId === 'bad')?.reason).toBe('no_version');
    expect(unresolved.find((entry) => entry.itemId === 'volume')?.reason).toBe('incomparable_unit');
    // And the resolvable item still contributed.
    expect(totals.length).toBeGreaterThan(0);
  });

  it('reports a food version with no nutrient rows at all', () => {
    const { unresolved } = mealTotals(
      [item({ id: 'i1', foodVersionId: 'v-oats' })],
      versions,
      new Map([['v-oats', []]]),
    );
    expect(unresolved[0]?.reason).toBe('no_nutrients');
  });
});

describe('protein by source', () => {
  const sources = new Map<string, 'dairy' | 'egg' | 'legume' | 'supplement' | 'grain_other' | null>([
    ['f-whey', 'supplement'],
    ['f-oats', null],
  ]);

  /**
   * Attributing unclassified foods to `grain_other` would make an unclassified
   * library look like a grain-heavy diet — a claim the data does not support.
   */
  it('reports unclassified grams rather than absorbing them into a bucket', () => {
    const split = proteinBySource(
      [
        item({ id: 'i1', foodVersionId: 'v-whey', quantity: '1', unit: 'scoop' }),
        item({ id: 'i2', foodVersionId: 'v-oats', quantity: '100', unit: 'g' }),
      ],
      versions,
      nutrients,
      sources,
    );

    expect(split.bySource).toHaveLength(1);
    expect(split.bySource[0]?.source).toBe('supplement');
    expect(Number(formatDecimal(split.bySource[0]?.grams ?? { unscaled: 0n, scale: 0 }))).toBeCloseTo(24, 3);
    expect(Number(formatDecimal(split.unclassifiedGrams))).toBeCloseTo(16.9, 3);
  });
});

describe('the metric registry', () => {
  it('has a registered metric for every catalogued nutrient, with matching units', () => {
    for (const nutrient of NUTRIENTS) {
      const registered = NUTRITION_METRICS.find((entry) => entry.key === nutritionMetricKey(nutrient.slug));
      expect(registered, nutrient.slug).toBeDefined();
      expect(registered?.canonicalUnit, nutrient.slug).toBe(nutrient.canonicalUnit);
      /* A day's protein is the sum of its meals. A mean answers nothing. */
      expect(registered?.aggregation, nutrient.slug).toBe('sum');
      /* §4.0's budget is at six of eleven with a note and four medication
       * slots. Intake is captured as it happens, not recalled at 22:00. */
      expect(registered?.inDailyClose, nutrient.slug).toBe(false);
    }
  });

  it('registers the five protein-source keys', () => {
    for (const source of ['dairy', 'egg', 'legume', 'supplement', 'grain_other']) {
      expect(NUTRITION_METRICS.some((entry) => entry.key === `nutrition.protein.from_${source}`)).toBe(true);
    }
  });
});

describe('units', () => {
  it('folds the spellings labels actually print', () => {
    expect(normaliseNutrientUnit('µg')).toBe('mcg');
    expect(normaliseNutrientUnit('mcg')).toBe('mcg');
    expect(normaliseNutrientUnit('Kcal')).toBe('kcal');
    expect(normaliseNutrientUnit('ml')).toBe('mL');
  });

  /**
   * IU is not a registered unit and must never be treated as one — returning a
   * code here would let an IU value flow into arithmetic as micrograms.
   */
  it('refuses IU, which is handled by the substance-specific factor instead', () => {
    expect(normaliseNutrientUnit('IU')).toBeNull();
    expect(normaliseNutrientUnit('i.u.')).toBeNull();
  });

  it('converts IU for vitamin D and refuses it for everything else', () => {
    const vitaminD = nutrientFor('Vitamin D');
    const protein = nutrientFor('Protein');
    expect(vitaminD).not.toBeNull();
    expect(protein).not.toBeNull();

    // 1000 IU ÷ 40 = 25 µg.
    const converted = fromInternationalUnits(vitaminD as NonNullable<typeof vitaminD>, '1000');
    expect(Number(formatDecimal(converted?.value ?? { unscaled: 0n, scale: 0 }))).toBeCloseTo(25, 6);

    expect(fromInternationalUnits(protein as NonNullable<typeof protein>, '1000')).toBeNull();
  });
});

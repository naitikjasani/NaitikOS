/**
 * Turning a meal into numbers — the arithmetic §4.3 rests on.
 *
 * A meal item says "150 g of this food version". A food version says "per 100 g:
 * 11 g protein, 154 kcal". The multiple between them is where this is either
 * right or quietly wrong, so the resolution is specified rather than left to be
 * inferred from the code.
 *
 * ## Three rules, in order
 *
 * 1. **A pseudo-unit resolves against the version's serving row, or the item is
 *    unresolved.** `1 scoop`, `2 roti`, `1 serving` are not units; they are
 *    per-food aliases. A version with no `servingQuantity` cannot say what a
 *    scoop of it weighs, and assuming one basis would silently turn a 30 g scoop
 *    into 100 g.
 * 2. **Same dimension converts; cross-dimension refuses.** 150 g against a
 *    100 g basis is arithmetic. 150 mL against a 100 g basis needs a density,
 *    `food_version` has no density column, and inventing one is the exact class
 *    of error §6.2 exists to prevent.
 * 3. **Nothing rounds.** `quantity.ts` is explicit that conversion never rounds;
 *    rounding is a presentation decision and a converter that rounds loses a
 *    microgram somewhere.
 *
 * ## Unresolved items are reported, never zero
 *
 * The same honesty `lab.repository.ts` already carries with `withoutTrend`: a
 * value that could not be computed appears as *"2 items have no nutrition"* on
 * the screen. Silently contributing zero would make a day's protein read low
 * for a reason nobody could see.
 *
 * ## Pseudo-units are declared here and never in `UNITS`
 *
 * A serving is not a dimension. Registering `scoop` globally would break the
 * registry's one-base-unit-per-dimension invariant and would let a scoop of whey
 * convert into a scoop of oats.
 */

import type { Decimal } from '../../units/decimal';
import { DECIMAL_ZERO, addDecimal, divideDecimal, multiplyDecimal, parseDecimal } from '../../units/decimal';
import type { Quantity, UnitCode } from '../../units/quantity';
import { UNITS, convertQuantity } from '../../units/quantity';
import type { NutrientDefinition, ProteinSource } from './nutrient';
import { nutrientByKey, nutritionMetricKey, proteinSourceMetricKey, toCanonicalNutrient } from './nutrient';

/**
 * Units that mean "one of whatever this food is served as".
 *
 * Resolved per food version, never globally. The list is short and covers what
 * an Indian vegetarian kitchen actually counts in.
 */
export const PSEUDO_UNITS: readonly string[] = Object.freeze([
  'serving',
  'servings',
  'scoop',
  'scoops',
  'piece',
  'pieces',
  'slice',
  'slices',
  'roti',
  'rotis',
  'chapati',
  'bowl',
  'bowls',
  'glass',
  'glasses',
  'cup',
  'cups',
  'unit',
  'units',
  'egg',
  'eggs',
]);

export function isPseudoUnit(unit: string): boolean {
  return PSEUDO_UNITS.includes(unit.trim().toLowerCase());
}

/** Scale for the basis multiple. Six places, matching `QUANTITY_SCALE`. */
const MULTIPLE_SCALE = 6;

export type FoodVersionFacts = {
  readonly id: string;
  readonly foodId: string;
  /** Usually 100 with unit `g`. */
  readonly basisQuantity: string;
  readonly basisUnit: string;
  /** What one "serving" of this version is, when the label says. */
  readonly servingQuantity: string | null;
  readonly servingUnit: string | null;
};

export type NutrientRow = {
  readonly foodVersionId: string;
  /** A catalogue slug. Unknown keys are ignored — see {@link mealTotals}. */
  readonly nutrientKey: string;
  readonly amount: string;
  readonly unit: string;
};

export type MealItemFacts = {
  readonly id: string;
  readonly foodVersionId: string;
  readonly quantity: string;
  readonly unit: string;
};

export type UnresolvedItem = {
  readonly itemId: string;
  readonly reason:
    | 'no_version'
    | 'no_serving_defined'
    | 'unknown_unit'
    | 'incomparable_unit'
    | 'unreadable_quantity'
    | 'no_nutrients';
};

export type NutrientTotal = {
  readonly metricKey: string;
  readonly nutrient: NutrientDefinition;
  readonly amount: Decimal;
};

export type MealTotals = {
  readonly totals: readonly NutrientTotal[];
  readonly unresolved: readonly UnresolvedItem[];
};

/**
 * How many multiples of a version's basis one meal item is.
 *
 * Exported because it is the single most consequential number in the module and
 * a rule that can only be exercised through a whole meal is a rule that stops
 * being tested.
 */
export function basisMultiple(
  item: Pick<MealItemFacts, 'quantity' | 'unit'>,
  version: FoodVersionFacts,
): { readonly ok: true; readonly multiple: Decimal } | { readonly ok: false; readonly reason: UnresolvedItem['reason'] } {
  const quantity = parseDecimal(item.quantity);
  const basis = parseDecimal(version.basisQuantity);
  if (quantity === null || basis === null) return { ok: false, reason: 'unreadable_quantity' };
  if (basis.unscaled === 0n) return { ok: false, reason: 'unreadable_quantity' };

  /* Rule 1: a pseudo-unit is resolved against this version's serving row. */
  let resolved: Quantity;
  if (isPseudoUnit(item.unit)) {
    if (version.servingQuantity === null || version.servingUnit === null) {
      return { ok: false, reason: 'no_serving_defined' };
    }
    const serving = parseDecimal(version.servingQuantity);
    if (serving === null) return { ok: false, reason: 'unreadable_quantity' };
    if (!isKnownUnit(version.servingUnit)) return { ok: false, reason: 'unknown_unit' };
    /* "2 scoops" becomes "2 × 30 g". */
    resolved = { value: multiplyDecimal(quantity, serving), unit: version.servingUnit };
  } else {
    if (!isKnownUnit(item.unit)) return { ok: false, reason: 'unknown_unit' };
    resolved = { value: quantity, unit: item.unit };
  }

  if (!isKnownUnit(version.basisUnit)) return { ok: false, reason: 'unknown_unit' };

  /* Rule 2: same dimension converts; cross-dimension refuses. */
  if (UNITS[resolved.unit].dimension !== UNITS[version.basisUnit].dimension) {
    return { ok: false, reason: 'incomparable_unit' };
  }
  const converted = convertQuantity(resolved, version.basisUnit);
  if (converted === null) return { ok: false, reason: 'incomparable_unit' };

  const multiple = divideDecimal(converted.value, basis, MULTIPLE_SCALE);
  return multiple === null ? { ok: false, reason: 'unreadable_quantity' } : { ok: true, multiple };
}

/**
 * Sum a meal's nutrients, per registered metric.
 *
 * A nutrient key the catalogue does not know is **skipped silently**, and that
 * is the one silent drop in this module. It is correct: `food_nutrient` is
 * row-per-nutrient specifically so a label can carry potassium before this
 * system registers a metric for it, and the row keeps the number for the day it
 * does. Reporting it as "unresolved" would flag every complete label as partial.
 */
export function mealTotals(
  items: readonly MealItemFacts[],
  versions: ReadonlyMap<string, FoodVersionFacts>,
  nutrients: ReadonlyMap<string, readonly NutrientRow[]>,
): MealTotals {
  const sums = new Map<string, { nutrient: NutrientDefinition; amount: Decimal }>();
  const unresolved: UnresolvedItem[] = [];

  for (const item of items) {
    const version = versions.get(item.foodVersionId);
    if (version === undefined) {
      unresolved.push({ itemId: item.id, reason: 'no_version' });
      continue;
    }

    const multiple = basisMultiple(item, version);
    if (!multiple.ok) {
      unresolved.push({ itemId: item.id, reason: multiple.reason });
      continue;
    }

    const rows = nutrients.get(item.foodVersionId) ?? [];
    if (rows.length === 0) {
      unresolved.push({ itemId: item.id, reason: 'no_nutrients' });
      continue;
    }

    for (const row of rows) {
      const definition = nutrientByKey(row.nutrientKey);
      if (definition === null) continue;

      const amount = parseDecimal(row.amount);
      if (amount === null || !isKnownUnit(row.unit)) continue;

      const canonical = toCanonicalNutrient(definition, { value: amount, unit: row.unit });
      if (!canonical.ok) continue;

      const contribution = multiplyDecimal(canonical.quantity.value, multiple.multiple);
      const key = nutritionMetricKey(definition.slug);
      const existing = sums.get(key);
      sums.set(key, {
        nutrient: definition,
        amount: existing === undefined ? contribution : addDecimal(existing.amount, contribution),
      });
    }
  }

  return {
    totals: [...sums.entries()]
      .map(([metricKey, entry]) => ({ metricKey, nutrient: entry.nutrient, amount: entry.amount }))
      .sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
    unresolved,
  };
}

/* -------------------------------------------------------------------------
 * Protein by source
 * ---------------------------------------------------------------------- */

export type ProteinSplit = {
  readonly bySource: readonly { readonly metricKey: string; readonly source: ProteinSource; readonly grams: Decimal }[];
  /** Protein from foods with no recorded source. Reported, never absorbed. */
  readonly unclassifiedGrams: Decimal;
};

/**
 * Apportion a meal's protein across the five source keys.
 *
 * Computed per item rather than by splitting the total, because the split is a
 * property of each *food* and the total has already lost that.
 *
 * Foods with no `proteinSource` contribute to {@link ProteinSplit.unclassifiedGrams}
 * and to none of the five keys. Attributing them to `grain_other` would make an
 * unclassified library look like a grain-heavy diet, which is a claim the data
 * does not support.
 */
export function proteinBySource(
  items: readonly MealItemFacts[],
  versions: ReadonlyMap<string, FoodVersionFacts>,
  nutrients: ReadonlyMap<string, readonly NutrientRow[]>,
  sourceByFoodId: ReadonlyMap<string, ProteinSource | null>,
): ProteinSplit {
  const sums = new Map<ProteinSource, Decimal>();
  let unclassified = DECIMAL_ZERO;

  for (const item of items) {
    const version = versions.get(item.foodVersionId);
    if (version === undefined) continue;

    const multiple = basisMultiple(item, version);
    if (!multiple.ok) continue;

    const protein = (nutrients.get(item.foodVersionId) ?? []).find((row) => row.nutrientKey === 'protein');
    if (protein === undefined) continue;

    const definition = nutrientByKey('protein');
    const amount = parseDecimal(protein.amount);
    if (definition === null || amount === null || !isKnownUnit(protein.unit)) continue;

    const canonical = toCanonicalNutrient(definition, { value: amount, unit: protein.unit });
    if (!canonical.ok) continue;

    const grams = multiplyDecimal(canonical.quantity.value, multiple.multiple);
    const source = sourceByFoodId.get(version.foodId) ?? null;

    if (source === null) unclassified = addDecimal(unclassified, grams);
    else sums.set(source, addDecimal(sums.get(source) ?? DECIMAL_ZERO, grams));
  }

  return {
    bySource: [...sums.entries()].map(([source, grams]) => ({
      metricKey: proteinSourceMetricKey(source),
      source,
      grams,
    })),
    unclassifiedGrams: unclassified,
  };
}

function isKnownUnit(unit: string): unit is UnitCode {
  return Object.hasOwn(UNITS, unit);
}

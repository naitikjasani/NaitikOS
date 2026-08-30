/**
 * Nutrition's vocabulary — §4.3, generated from the catalogue.
 *
 * Generated rather than typed out for the same reason `domain/health/metrics.ts`
 * is: a unit written by hand here drifts from the unit in the catalogue, and the
 * drift is invisible because both sides still look correct on their own. That is
 * §6.2's failure mode with an extra step.
 *
 * ## Everything is `sum`, and nothing is in the Daily Close
 *
 * **`sum`** because every nutrition metric is a within-day total. A day's protein
 * is the sum of its meals; a mean would answer a question nobody asked.
 *
 * The seven-day moving average the trends screen draws is a rollup *over* these
 * rollups, computed at render time exactly as §4.6 does for bodyweight. The
 * registry's `aggregation` is the within-day rule and nothing else.
 *
 * **Not in the Close** because the Close is at six of §4.0's eleven elements
 * with a note and four medication slots, and "adding a field requires removing a
 * field". More to the point, intake is captured *as it happens* — a nutrition
 * field at 22:00 asks the operator to recall four meals, which is both slower
 * and less accurate than the thing it would replace.
 *
 * ## Bounds are per meal
 *
 * `minValue`/`maxValue` here catch a mistyped *quantity* — one observation is
 * one meal. The catalogue's `plausible` catches a mistyped *label*, per 100 g.
 * Both are needed and they are different numbers; see `nutrient.ts`.
 *
 * A bound is a fat-finger guard, never a dietary judgement. 6,000 kcal in a
 * meal is implausible as a *reading*; it is not this system's business whether
 * it would be implausible as a *dinner*.
 */

import type { MetricDefinition, MetricKey } from '../../observations/metric';
import type { NutrientDefinition } from './nutrient';
import { NUTRIENTS, PROTEIN_SOURCES, PROTEIN_SOURCE_LABELS, nutritionMetricKey, proteinSourceMetricKey } from './nutrient';

function metric(
  definition: Omit<MetricDefinition, 'key' | 'minValue' | 'maxValue' | 'allowedValues' | 'inDailyClose'> & {
    readonly key: string;
    readonly minValue?: string;
    readonly maxValue?: string;
  },
): MetricDefinition {
  return {
    ...definition,
    key: definition.key as MetricKey,
    minValue: definition.minValue ?? null,
    maxValue: definition.maxValue ?? null,
    allowedValues: null,
    inDailyClose: false,
  };
}

/**
 * Per-meal upper bounds, keyed by slug.
 *
 * Separate from the catalogue's per-100 g bounds and separate from each other
 * because they answer different questions. A table rather than a formula: there
 * is no multiple of "per 100 g" that gives a sensible per-meal ceiling for both
 * energy and vitamin B12.
 */
/**
 * Each ceiling in the nutrient's own canonical unit, rather than as a bare
 * number.
 *
 * `{ max: 500, unit: 'g' }` and not `protein: 500`, because §6.2's rule against
 * bare quantities is exactly right here: 500 what? The catalogue answers it a
 * file away, and a ceiling that has drifted out of step with a canonical unit
 * change is a guard that silently stops guarding.
 */
type PerMealCeiling = { readonly max: number; readonly unit: string };

const PER_MEAL_MAX: Readonly<Record<string, PerMealCeiling>> = Object.freeze({
  energy: { max: 10_000, unit: 'kcal' },
  protein: { max: 500, unit: 'g' },
  carbohydrate: { max: 1500, unit: 'g' },
  fat: { max: 500, unit: 'g' },
  saturated_fat: { max: 300, unit: 'g' },
  fibre: { max: 200, unit: 'g' },
  sugar: { max: 1000, unit: 'g' },
  sodium: { max: 50_000, unit: 'mg' },
  water: { max: 5000, unit: 'mL' },
  vitamin_d: { max: 2500, unit: 'mcg' },
  vitamin_b12: { max: 10_000, unit: 'mcg' },
  iron: { max: 500, unit: 'mg' },
  calcium: { max: 10_000, unit: 'mg' },
  zinc: { max: 500, unit: 'mg' },
});

function describe(nutrient: NutrientDefinition): string {
  const unit = nutrient.canonicalUnit === '' ? 'its canonical unit' : nutrient.canonicalUnit;
  const base = `${nutrient.displayName} in one meal, in ${unit}, summed from the food versions the meal was composed of. Aggregated as sum within a day; the seven-day average on the trends screen is computed over those daily sums, not by the registry.`;

  if (nutrient.slug === 'water') {
    return `${base} Written both by hydration captures — a glass of water, with no meal row at all — and by the water content of foods that carry it. Both paths sum into the same daily total, which is correct rather than double-counting.`;
  }
  if (nutrient.iuPerCanonicalUnit !== null) {
    return `${base} Labels commonly print this in international units; 1 ${unit} is ${nutrient.iuPerCanonicalUnit} IU, and the conversion is substance-specific so it lives on the nutrient rather than in the unit registry.`;
  }
  return base;
}

const FROM_CATALOGUE: readonly MetricDefinition[] = NUTRIENTS.map((nutrient) =>
  metric({
    key: nutritionMetricKey(nutrient.slug),
    domain: 'body',
    displayName: nutrient.displayName,
    description: describe(nutrient),
    valueType: 'numeric',
    canonicalUnit: nutrient.canonicalUnit,
    minValue: '0',
    maxValue: String(PER_MEAL_MAX[nutrient.slug]?.max ?? 100_000),
    aggregation: 'sum',
  }),
);

/**
 * Protein by source — five keys, hand-written.
 *
 * Not generated from the catalogue because they are not nutrients: they are one
 * nutrient apportioned by a property of the food. Five separate metrics rather
 * than one categorical metric with five allowed values, because a metric holds
 * *one number* and the question §4.2 asks — "how much whey last week" — has to
 * be answerable by summing a single key.
 */
const BY_SOURCE: readonly MetricDefinition[] = PROTEIN_SOURCES.map((source) =>
  metric({
    key: proteinSourceMetricKey(source),
    domain: 'body',
    displayName: `Protein from ${PROTEIN_SOURCE_LABELS[source].toLowerCase()}`,
    description:
      `The part of a meal's protein contributed by foods classified as ${PROTEIN_SOURCE_LABELS[source].toLowerCase()}. §4.3 asks for vegetarian-plus-eggs protein-source analysis and §4.2 has Skin reading whey intake; separate keys are what let another domain ask that question through the metric vocabulary without importing Nutrition (P3). ` +
      'Foods with no recorded source contribute to none of these keys and are reported as unclassified rather than being absorbed into one.',
    valueType: 'numeric',
    canonicalUnit: 'g',
    minValue: '0',
    maxValue: '500',
    aggregation: 'sum',
  }),
);

/** Everything Nutrition can write. */
export const NUTRITION_METRICS: readonly MetricDefinition[] = Object.freeze([...FROM_CATALOGUE, ...BY_SOURCE]);

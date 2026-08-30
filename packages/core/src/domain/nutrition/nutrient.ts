/**
 * The nutrient catalogue — §4.3's vocabulary.
 *
 * Structurally a copy of `domain/health/analyte.ts`, and deliberately so: a
 * nutrition label prints `Protein 12.5 g` the way a lab report prints
 * `Ferritin 45 ng/mL`, so the same machinery reads both — a catalogue with
 * aliases, folded-name matching, unit normalisation, and a `toCanonical` that
 * refuses rather than guesses.
 *
 * ## Fourteen nutrients, and why not forty
 *
 * Every registered metric key with no populated `food_nutrient` rows behind it
 * is a chart that reads zero and looks like a deficiency. So the list is the
 * macros that appear on every label, plus **five micronutrients chosen because
 * each one pairs with an analyte the lab catalogue already knows** — vitamin D,
 * B12, iron, calcium, zinc. That pairing is the whole point: it is what makes
 * §4.3's stated payoff ("your Vitamin D is low and your intake explains it") a
 * join rather than a rewrite, when the detector suite arrives in December.
 *
 * Adding a nutrient later is six lines here plus a re-seed. Adding one now that
 * nothing populates is a permanent zero on a chart.
 *
 * ## Two different plausibility bounds, and both are needed
 *
 * {@link NutrientDefinition.plausible} is **per 100 g of a food** — it catches a
 * mistyped label. The metric's `minValue`/`maxValue` in `metrics.ts` is **per
 * meal** — it catches a mistyped quantity. A label claiming 900 g of protein per
 * 100 g and a meal claiming 900 g of protein are different errors, and only one
 * bound would let one of them through.
 *
 * ## International units
 *
 * Labels print vitamin D in IU. `UNITS` has no IU-of-mass unit and must not get
 * one — its `iu_concentration` dimension deliberately holds a single member,
 * because IU of one substance never converts into IU of another. The conversion
 * is substance-specific (1 µg cholecalciferol = 40 IU), which is structurally
 * the same problem `analyte.ts` solved with `molarKey`. So the factor lives on
 * the nutrient, and it is `null` for every nutrient where IU is meaningless —
 * refusing rather than guessing, exactly as `convertConcentration` does.
 */

import type { UnitCode } from '../../units/quantity';
import { UNITS, convertQuantity, isUnitCode } from '../../units/quantity';
import type { Quantity } from '../../units/quantity';
import { divideDecimal, multiplyDecimal, parseDecimal } from '../../units/decimal';

/** The metric-key prefix. Permanent — a rename here is a data migration. */
export const NUTRITION_METRIC_PREFIX = 'nutrition.';

export type NutrientDefinition = {
  /** Stable slug. Appears in the metric key, so it never changes. */
  readonly slug: string;
  readonly displayName: string;
  readonly canonicalUnit: UnitCode;
  /** Lower-cased, punctuation-stripped spellings printed on real labels. */
  readonly aliases: readonly string[];
  readonly decimals: number;
  /** Per 100 g of a food. A label guard, not a dietary judgement. */
  readonly plausible: { readonly min: number; readonly max: number };
  /**
   * How many IU one canonical unit is worth, or `null` when IU is meaningless
   * for this nutrient. `null` makes the conversion refuse.
   */
  readonly iuPerCanonicalUnit: string | null;
  /** Whether this appears on the overview by default. Macros do; micros do not. */
  readonly isMacro: boolean;
};

function nutrient(definition: NutrientDefinition): NutrientDefinition {
  return Object.freeze(definition);
}

export const NUTRIENTS: readonly NutrientDefinition[] = Object.freeze([
  nutrient({
    slug: 'energy',
    displayName: 'Energy',
    /*
     * kcal, not kJ. The registry holds 1 kcal = 4.184 kJ *exactly*, so a
     * kJ-only label converts without loss — and every target the operator will
     * ever write is in kcal.
     */
    canonicalUnit: 'kcal',
    aliases: ['energy', 'calories', 'calorie', 'energy value', 'kcal', 'energy kcal'],
    decimals: 0,
    plausible: { min: 0, max: 1000 },
    iuPerCanonicalUnit: null,
    isMacro: true,
  }),
  nutrient({
    slug: 'protein',
    displayName: 'Protein',
    canonicalUnit: 'g',
    aliases: ['protein', 'proteins', 'crude protein'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: true,
  }),
  nutrient({
    slug: 'carbohydrate',
    displayName: 'Carbohydrate',
    canonicalUnit: 'g',
    aliases: ['carbohydrate', 'carbohydrates', 'carbs', 'total carbohydrate', 'carbohydrate total'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: true,
  }),
  nutrient({
    slug: 'fat',
    displayName: 'Fat',
    canonicalUnit: 'g',
    aliases: ['fat', 'total fat', 'fats', 'total lipid'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: true,
  }),
  nutrient({
    slug: 'saturated_fat',
    displayName: 'Saturated fat',
    canonicalUnit: 'g',
    aliases: ['saturated fat', 'of which saturates', 'saturates', 'saturated fatty acids'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'fibre',
    displayName: 'Fibre',
    canonicalUnit: 'g',
    aliases: ['fibre', 'fiber', 'dietary fibre', 'dietary fiber', 'crude fibre'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: true,
  }),
  nutrient({
    slug: 'sugar',
    displayName: 'Sugar',
    canonicalUnit: 'g',
    aliases: ['sugar', 'sugars', 'of which sugars', 'total sugars', 'added sugar'],
    decimals: 1,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'sodium',
    displayName: 'Sodium',
    canonicalUnit: 'mg',
    aliases: ['sodium', 'salt', 'sodium content'],
    decimals: 0,
    plausible: { min: 0, max: 40_000 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'water',
    displayName: 'Water',
    canonicalUnit: 'mL',
    aliases: ['water', 'moisture', 'hydration'],
    decimals: 0,
    plausible: { min: 0, max: 100 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),

  /* --- micronutrients: five, each pairing with a catalogued analyte ----- */
  nutrient({
    slug: 'vitamin_d',
    displayName: 'Vitamin D',
    canonicalUnit: 'mcg',
    aliases: ['vitamin d', 'vitamin d3', 'cholecalciferol', 'vit d'],
    decimals: 1,
    plausible: { min: 0, max: 2000 },
    /** 1 µg cholecalciferol = 40 IU. Substance-specific; see the header. */
    iuPerCanonicalUnit: '40',
    isMacro: false,
  }),
  nutrient({
    slug: 'vitamin_b12',
    displayName: 'Vitamin B12',
    canonicalUnit: 'mcg',
    aliases: ['vitamin b12', 'vitamin b 12', 'b12', 'cobalamin', 'cyanocobalamin'],
    decimals: 2,
    plausible: { min: 0, max: 1000 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'iron',
    displayName: 'Iron',
    canonicalUnit: 'mg',
    aliases: ['iron', 'fe'],
    decimals: 2,
    plausible: { min: 0, max: 200 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'calcium',
    displayName: 'Calcium',
    canonicalUnit: 'mg',
    aliases: ['calcium', 'ca'],
    decimals: 0,
    plausible: { min: 0, max: 5000 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
  nutrient({
    slug: 'zinc',
    displayName: 'Zinc',
    canonicalUnit: 'mg',
    aliases: ['zinc', 'zn'],
    decimals: 2,
    plausible: { min: 0, max: 200 },
    iuPerCanonicalUnit: null,
    isMacro: false,
  }),
]);

/**
 * Where a food's protein comes from. Mirrors the `protein_source` pgEnum.
 *
 * Five metric keys rather than one categorical metric, because a metric holds
 * one number and P3 requires Skin to ask "how much whey last week" without
 * importing Nutrition.
 */
export const PROTEIN_SOURCES = Object.freeze(['dairy', 'egg', 'legume', 'supplement', 'grain_other'] as const);

export type ProteinSource = (typeof PROTEIN_SOURCES)[number];

export const PROTEIN_SOURCE_LABELS: Readonly<Record<ProteinSource, string>> = Object.freeze({
  dairy: 'Dairy',
  egg: 'Egg',
  legume: 'Legumes',
  supplement: 'Supplement',
  grain_other: 'Grains and other',
});

/**
 * Nutrition metric key → the analyte it pairs with, where one exists.
 *
 * Four lines, and they are the entire hook December's micronutrient-versus-lab
 * detector needs. §4.3 calls that pairing "the payoff, since it lets 'your
 * Vitamin D is low and your intake explains it' become a computed statement
 * rather than a guess" — and it is deliberately *only* a hook here. The
 * statement itself is a detector under §10.6's controls, not a Nutrition
 * feature. See `docs/nutrition.md`.
 */
export const NUTRIENT_TO_ANALYTE: Readonly<Record<string, string>> = Object.freeze({
  vitamin_d: 'vitamin_d_25oh',
  vitamin_b12: 'vitamin_b12',
  iron: 'ferritin',
  calcium: 'calcium',
});

/* -------------------------------------------------------------------------
 * Lookup
 * ---------------------------------------------------------------------- */

/** Same folding rule as `analyte.ts`: digits kept, so B12 stays distinct. */
export function foldNutrientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

const BY_KEY: ReadonlyMap<string, NutrientDefinition> = (() => {
  const map = new Map<string, NutrientDefinition>();
  for (const definition of NUTRIENTS) {
    map.set(definition.slug, definition);
    map.set(foldNutrientName(definition.displayName), definition);
    for (const alias of definition.aliases) {
      const folded = foldNutrientName(alias);
      /* First spelling wins. Rebinding an earlier one would silently move a
       * label's numbers onto a different nutrient. */
      if (!map.has(folded)) map.set(folded, definition);
    }
  }
  return map;
})();

export function nutrientFor(name: string): NutrientDefinition | null {
  return BY_KEY.get(foldNutrientName(name)) ?? null;
}

export function nutrientByKey(slug: string): NutrientDefinition | null {
  const found = BY_KEY.get(slug);
  return found !== undefined && found.slug === slug ? found : null;
}

/** `nutrition.protein`. */
export function nutritionMetricKey(slug: string): string {
  return `${NUTRITION_METRIC_PREFIX}${slug}`;
}

/** `nutrition.protein.from_dairy`. */
export function proteinSourceMetricKey(source: ProteinSource): string {
  return `${NUTRITION_METRIC_PREFIX}protein.from_${source}`;
}

export function nutrientForMetricKey(key: string): NutrientDefinition | null {
  if (!key.startsWith(NUTRITION_METRIC_PREFIX)) return null;
  return nutrientByKey(key.slice(NUTRITION_METRIC_PREFIX.length));
}

/* -------------------------------------------------------------------------
 * Canonicalisation
 * ---------------------------------------------------------------------- */

export type NutrientCanonicalFailure = 'unknown_unit' | 'incomparable' | 'implausible';

export type NutrientCanonicalResult =
  | { readonly ok: true; readonly quantity: Quantity; readonly converted: boolean }
  | { readonly ok: false; readonly reason: NutrientCanonicalFailure };

/**
 * Put a printed nutrient amount into the catalogue's canonical unit.
 *
 * The IU branch is the interesting one and it is the reason this cannot just
 * call `convertQuantity`: `IU` is not a registered unit code, so it arrives as
 * a *marker* rather than a `Quantity`, and the caller passes it explicitly.
 */
export function toCanonicalNutrient(
  definition: NutrientDefinition,
  value: Quantity,
  options: { readonly checkPlausible?: boolean } = {},
): NutrientCanonicalResult {
  if (value.unit === definition.canonicalUnit) {
    return plausibility(definition, { ok: true, quantity: value, converted: false }, options);
  }

  const from = UNITS[value.unit];
  const to = UNITS[definition.canonicalUnit];
  if (from.dimension !== to.dimension) return { ok: false, reason: 'incomparable' };

  const converted = convertQuantity(value, definition.canonicalUnit);
  if (converted === null) return { ok: false, reason: 'incomparable' };
  return plausibility(definition, { ok: true, quantity: converted, converted: true }, options);
}

/**
 * An amount printed in international units, converted to the canonical unit.
 *
 * `null` for any nutrient with no registered IU factor, which is most of them.
 * Guessing here would produce a plausible-looking micronutrient figure, which
 * is the same failure `convertConcentration` refuses for lab analytes.
 */
export function fromInternationalUnits(definition: NutrientDefinition, iu: string): Quantity | null {
  if (definition.iuPerCanonicalUnit === null) return null;
  const amount = parseDecimal(iu);
  const factor = parseDecimal(definition.iuPerCanonicalUnit);
  if (amount === null || factor === null) return null;

  const value = divideDecimal(amount, factor, 6);
  return value === null ? null : { value, unit: definition.canonicalUnit };
}

/** The inverse, for showing a label back the way it was printed. */
export function toInternationalUnits(definition: NutrientDefinition, amount: Quantity): Quantity | null {
  if (definition.iuPerCanonicalUnit === null) return null;
  const factor = parseDecimal(definition.iuPerCanonicalUnit);
  if (factor === null) return null;
  return { value: multiplyDecimal(amount.value, factor), unit: definition.canonicalUnit };
}

function plausibility(
  definition: NutrientDefinition,
  candidate: { readonly ok: true; readonly quantity: Quantity; readonly converted: boolean },
  options: { readonly checkPlausible?: boolean },
): NutrientCanonicalResult {
  if (options.checkPlausible !== true) return candidate;

  const asNumber = Number(candidate.quantity.value.unscaled) / 10 ** candidate.quantity.value.scale;
  if (!Number.isFinite(asNumber)) return { ok: false, reason: 'implausible' };
  if (asNumber < definition.plausible.min || asNumber > definition.plausible.max) {
    return { ok: false, reason: 'implausible' };
  }
  return candidate;
}

/**
 * Parse a printed unit string into a registered code.
 *
 * `IU` deliberately returns `null` — it is not a unit this registry can hold,
 * and the label parser handles it separately through
 * {@link fromInternationalUnits}. Returning a fake code here would let an IU
 * value flow into arithmetic as though it were micrograms.
 */
export function normaliseNutrientUnit(printed: string): UnitCode | null {
  const trimmed = printed.trim();
  if (trimmed === '') return '';
  if (trimmed === '%') return 'percent';

  const cleaned = trimmed.replace(/µ|μ/gu, 'u').replace(/\s+/gu, '');
  if (/^(iu|i\.u\.)$/iu.test(cleaned)) return null;
  if (/^mcg$/iu.test(cleaned)) return 'mcg';
  if (/^ug$/iu.test(cleaned)) return 'mcg';
  if (/^kj$/iu.test(cleaned)) return 'kJ';
  if (/^k?cal(ories)?$/iu.test(cleaned)) return 'kcal';
  if (/^ml$/iu.test(cleaned)) return 'mL';

  if (isUnitCode(cleaned)) return cleaned;

  const lowered = cleaned.toLowerCase();
  for (const code of Object.keys(UNITS)) {
    if (code !== '' && code.toLowerCase() === lowered) return code as UnitCode;
  }
  return null;
}

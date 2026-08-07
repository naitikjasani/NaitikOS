/**
 * Nutrition — §4.3, §9.2. Ships in V2; the schema ships now.
 *
 * §2.1 requires the complete §9 data model in the MVP, "*all* of it, even for
 * domains not yet surfaced. The schema is the expensive thing to change later;
 * the UI is not." So these tables exist and stay empty until V2.
 *
 * ## Food versioning
 *
 * §9.2: "Foods are versioned: a nutrition-label change creates a new version,
 * and historical meals keep pointing at the version that was true when eaten."
 *
 * This is P2 applied to a mundane case. If a manufacturer reformulates in 2029,
 * silently updating the row rewrites every meal back to 2026 — the record would
 * then report an intake that never happened. `meal_item` therefore references a
 * `food_version`, never a `food`.
 *
 * ## The ten-second rule
 *
 * §4.3 inverts the usual hierarchy: recents and frequents first, meal templates
 * second, natural language third, search last. "If a generic food-database
 * search is the primary interaction, the module has failed P1 and should not
 * ship." The indexes below are built for that order — `lastEatenAt` and
 * `timesEaten` are denormalised onto `food` precisely so the recents list is a
 * single fast read rather than an aggregate over every meal ever logged.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { entityColumns, ianaZone, instant, quantity, reference } from './columns';

/**
 * A food in the personal library.
 *
 * Identity only — everything nutritional lives on {@link foodVersion}, because
 * that is the part that changes.
 */
export const food = pgTable(
  'food',
  {
    ...entityColumns,

    name: text().notNull(),
    brand: text(),
    /** Barcode, for the V2 scanning path (§4.3 future expansion). */
    gtin: text(),

    /**
     * Denormalised recency and frequency, maintained on write.
     *
     * Deliberate denormalisation on the P1 hot path: §4.3's first tier is
     * "recents and frequents — one tap, covers the large majority of real
     * intake", and computing that from `meal_item` at every keystroke would put
     * an aggregate over years of history in front of a ten-second budget.
     */
    lastEatenAt: instant(),
    timesEaten: integer().notNull().default(0),

    /** Relevant to a vegetarian-plus-eggs diet (§4.3). */
    isVegetarian: boolean(),
    isVegan: boolean(),
  },
  (t) => [
    index('food_recent_idx')
      .on(t.lastEatenAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('food_frequent_idx')
      .on(t.timesEaten.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    /* §9.6: "Fuzzy food/exercise lookup — trigram on name, for typo tolerance." */
    index('food_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    uniqueIndex('food_gtin_unique').on(t.gtin).where(sql`${t.gtin} IS NOT NULL`),
  ],
);

/**
 * A versioned nutrition label. Immutable once referenced by a meal.
 *
 * A new label means a new row, not an edit. See the file header for why.
 */
export const foodVersion = pgTable(
  'food_version',
  {
    ...entityColumns,

    foodId: reference()
      .notNull()
      .references(() => food.id),
    /** Monotonic per food. */
    versionNumber: integer().notNull(),

    /** The basis every nutrient is expressed against — usually 100 g or 100 ml. */
    basisQuantity: quantity().notNull(),
    basisUnit: text().notNull(),

    /** Common serving, so "one egg" does not require arithmetic. */
    servingQuantity: quantity(),
    servingUnit: text(),
    servingLabel: text(),

    /** When this label became true. */
    effectiveFrom: instant().notNull().default(sql`now()`),
    /** Where the numbers came from: packaging, a database, a manual estimate. */
    sourceNote: text(),
  },
  (t) => [
    uniqueIndex('food_version_unique').on(t.foodId, t.versionNumber),
    index('food_version_food_idx').on(t.foodId, t.versionNumber.desc()),
  ],
);

/**
 * Per-nutrient values for a food version.
 *
 * A row per nutrient rather than a column per nutrient. Micronutrient coverage
 * is open-ended — §4.3's payoff is comparing intake against lab results, which
 * means any analyte can become relevant — and a wide table would need a
 * migration each time. The nutrient key joins the metric registry, so a
 * nutrient is described exactly once in the system (P3).
 */
export const foodNutrient = pgTable(
  'food_nutrient',
  {
    ...entityColumns,

    foodVersionId: reference()
      .notNull()
      .references(() => foodVersion.id),

    /** Registry key — `nutrition.protein`, `nutrition.vitamin_d`. */
    nutrientKey: text().notNull(),
    /** Amount per the version's basis quantity. */
    amount: quantity().notNull(),
    unit: text().notNull(),
  },
  (t) => [uniqueIndex('food_nutrient_unique').on(t.foodVersionId, t.nutrientKey)],
);

/** A meal occasion. */
export const meal = pgTable(
  'meal',
  {
    ...entityColumns,

    eatenAt: instant().notNull(),
    zone: ianaZone().notNull(),
    /** `breakfast`, `lunch`, `dinner`, `snack` — free text, user-defined. */
    slot: text(),
    note: text(),

    /** Set when logged from a template, for the one-tap path (§4.3). */
    templateId: reference(),
  },
  (t) => [index('meal_eaten_idx').on(t.eatenAt.desc())],
);

/**
 * A food within a meal.
 *
 * References a `food_version`, never a `food`. That single choice is what makes
 * a 2026 meal still report 2026's nutrition after a 2029 reformulation.
 */
export const mealItem = pgTable(
  'meal_item',
  {
    ...entityColumns,

    mealId: reference()
      .notNull()
      .references(() => meal.id),
    foodVersionId: reference()
      .notNull()
      .references(() => foodVersion.id),

    quantity: quantity().notNull(),
    unit: text().notNull(),

    /** Set when a natural-language parse produced this item, with its confidence. */
    parsedFromText: text(),
  },
  (t) => [
    index('meal_item_meal_idx').on(t.mealId),
    index('meal_item_food_version_idx').on(t.foodVersionId),
  ],
);

/** A repeated meal — "usual breakfast", one tap (§4.3 tier two). */
export const mealTemplate = pgTable(
  'meal_template',
  {
    ...entityColumns,

    name: text().notNull(),
    slot: text(),
    /** `[{ foodId, quantity, unit }]`. Resolved to the current version on use. */
    items: jsonb().notNull().default(sql`'[]'::jsonb`),
    lastUsedAt: instant(),
    timesUsed: integer().notNull().default(0),
  },
  (t) => [index('meal_template_recent_idx').on(t.lastUsedAt.desc())],
);

/**
 * Macro and calorie targets, tied to a phase.
 *
 * Targets are time-bounded because a bulk and a cut have different ones, and
 * §4.10 needs to detect that a bulk target and a visible-abs goal are in
 * tension. A single mutable target row would erase the history that makes that
 * comparison possible.
 */
export const nutritionTarget = pgTable(
  'nutrition_target',
  {
    ...entityColumns,

    /** `bulk`, `cut`, `maintenance`. */
    phase: text(),
    effectiveFrom: instant().notNull(),
    effectiveTo: instant(),

    /** Registry key the target applies to — `nutrition.energy`, `nutrition.protein`. */
    metricKey: text().notNull(),
    targetValue: quantity().notNull(),
    unit: text().notNull(),
    /** Acceptable band around the target, so adherence is not all-or-nothing. */
    toleranceLow: quantity(),
    toleranceHigh: quantity(),
  },
  (t) => [
    index('nutrition_target_active_idx')
      .on(t.metricKey, t.effectiveFrom.desc())
      .where(sql`${t.effectiveTo} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

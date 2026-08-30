/**
 * The food library — identity, versioning, and tier 4's search.
 *
 * ## `versionAt`, and the bug it exists to prevent
 *
 * §9.2: "Foods are versioned: a nutrition-label change creates a new version,
 * and historical meals keep pointing at the version that was true when eaten."
 *
 * The subtle half of that is *writing*, not reading. Logging yesterday's dinner
 * this morning, after a reformulation was recorded overnight, must pin
 * yesterday's label — and `max(versionNumber)` would silently not. So every
 * write path resolves the version through {@link versionAt} with the meal's own
 * `eatenAt`, never with "now" and never with "latest".
 *
 * ## Search is tier 4 and is scored locally
 *
 * `scoreFoodMatch` mirrors `gym/exercise.ts`'s `scoreExerciseMatch` exactly,
 * for the same reason: the library is a few hundred rows at n=1, it is already
 * loaded for the suggestion grid, and a round trip per keystroke on the P1
 * capture path is the thing §4.3 is arguing against.
 */

import type { ProteinSource } from './nutrient';

export type Food = {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly gtin: string | null;
  readonly lastEatenAt: string | null;
  readonly timesEaten: number;
  readonly isVegetarian: boolean | null;
  readonly isVegan: boolean | null;
  readonly proteinSource: ProteinSource | null;
};

export type FoodVersion = {
  readonly id: string;
  readonly foodId: string;
  readonly versionNumber: number;
  readonly basisQuantity: string;
  readonly basisUnit: string;
  readonly servingQuantity: string | null;
  readonly servingUnit: string | null;
  readonly servingLabel: string | null;
  readonly effectiveFrom: string;
  readonly sourceNote: string | null;
};

export type FoodNutrient = {
  readonly foodVersionId: string;
  readonly nutrientKey: string;
  readonly amount: string;
  readonly unit: string;
};

/** `Amul paneer`, or just `paneer`. One spelling, used everywhere. */
export function foodLabel(food: Pick<Food, 'name' | 'brand'>): string {
  return food.brand === null || food.brand.trim() === '' ? food.name : `${food.brand} ${food.name}`;
}

/**
 * The version in force at an instant.
 *
 * The latest version whose `effectiveFrom` is at or before `at`. Falls back to
 * the *earliest* version when the meal predates every recorded label — that is
 * the closest thing to the truth available, and returning `null` would make a
 * back-dated meal unloggable for a reason the operator cannot act on.
 */
export function versionAt(versions: readonly FoodVersion[], at: string): FoodVersion | null {
  if (versions.length === 0) return null;

  const ordered = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  let chosen: FoodVersion | null = null;
  for (const version of ordered) {
    if (version.effectiveFrom <= at) chosen = version;
    else break;
  }

  return chosen ?? ordered[0] ?? null;
}

/**
 * The version to use for a meal happening now.
 *
 * Named `currentFoodVersion` rather than `currentVersion` because
 * `events/registry.ts` already owns that name for the event-schema version, and
 * two `currentVersion`s in one barrel is a collision waiting to be resolved
 * wrongly by whichever import IDE autocomplete offers first.
 */
export function currentFoodVersion(versions: readonly FoodVersion[], nowIso: string): FoodVersion | null {
  return versionAt(versions, nowIso);
}

/* -------------------------------------------------------------------------
 * Tier 4 — search
 * ---------------------------------------------------------------------- */

/**
 * Score a food against a search term. Higher is better; `0` means no match.
 *
 * The tiers mirror `scoreExerciseMatch`: exact beats prefix beats
 * brand-qualified beats substring beats all-words-in-any-order. A person typing
 * "oat" wants oats before "oat milk chocolate", and only an ordered scheme
 * gives that reliably.
 */
export function scoreFoodMatch(food: Pick<Food, 'name' | 'brand'>, term: string): number {
  const needle = term.trim().toLowerCase();
  if (needle === '') return 0;

  const name = food.name.toLowerCase();
  const full = foodLabel(food).toLowerCase();

  if (name === needle) return 100;
  if (name.startsWith(needle)) return 80;
  if (full.startsWith(needle)) return 70;
  if (name.includes(needle)) return 50;
  if (full.includes(needle)) return 40;

  const words = needle.split(/\s+/u).filter((word) => word !== '');
  if (words.length > 1 && words.every((word) => full.includes(word))) return 30;

  return 0;
}

export type FoodSearchResult = { readonly food: Food; readonly score: number };

/**
 * Search the library.
 *
 * Ties break on frequency, then on name. At n=1 that is almost always right:
 * two foods matching "dal" equally well are separated by which one the operator
 * actually eats.
 */
export function searchFoods(foods: readonly Food[], term: string, limit = 20): readonly FoodSearchResult[] {
  return foods
    .map((food) => ({ food, score: scoreFoodMatch(food, term) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.food.timesEaten - a.food.timesEaten || a.food.name.localeCompare(b.food.name),
    )
    .slice(0, limit);
}

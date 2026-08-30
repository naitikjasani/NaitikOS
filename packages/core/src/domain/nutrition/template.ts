/**
 * Meal templates — §4.3's tier 2, "usual breakfast, one tap".
 *
 * ## Templates are made by logging, never by authoring
 *
 * {@link templateFromMeal} is the only creation path, and that is the most
 * important decision in this file. An operator who has to build "usual
 * breakfast" field by field in a form will not build it — and tier 2 then never
 * exists, which pushes every meal down to tier 3 or 4 and fails the ten-second
 * rule by omission.
 *
 * So a template is made by logging a meal and tapping "save as usual". The
 * thing already exists; naming it costs one tap.
 *
 * ## The jsonb is validated defensively
 *
 * `meal_template.items` is untyped in the schema. A malformed entry drops that
 * item and is reported, rather than throwing and taking the whole log screen
 * down with it — the same treatment `exercise.repository.ts` gives its string
 * arrays. This is the P1 capture surface; it does not get to crash.
 */

import type { FoodVersion } from './food';
import { versionAt } from './food';

export type TemplateItem = {
  readonly foodId: string;
  readonly quantity: string;
  readonly unit: string;
};

export type MealTemplate = {
  readonly id: string;
  readonly name: string;
  readonly slot: string | null;
  readonly items: readonly TemplateItem[];
  readonly lastUsedAt: string | null;
  readonly timesUsed: number;
};

export type ResolvedItem = {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly quantity: string;
  readonly unit: string;
};

export type ResolvedTemplate = {
  readonly items: readonly ResolvedItem[];
  /** Foods in the template that no longer have a version. Stated, not dropped. */
  readonly missing: readonly string[];
};

/** Parse the untyped jsonb into items, dropping anything malformed. */
export function parseTemplateItems(value: unknown): readonly TemplateItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TemplateItem[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const foodId = record['foodId'];
    const quantity = record['quantity'];
    const unit = record['unit'];
    if (typeof foodId !== 'string' || typeof unit !== 'string') return [];
    if (typeof quantity !== 'string' && typeof quantity !== 'number') return [];
    return [{ foodId, quantity: String(quantity), unit }];
  });
}

/**
 * Resolve a template's foods to the versions in force at an instant.
 *
 * `at` is the meal's `eatenAt`, not "now". Applying a template to a back-dated
 * meal must pin the labels that were true then — see `food.ts`.
 */
export function resolveTemplate(
  template: MealTemplate,
  versionsByFood: ReadonlyMap<string, readonly FoodVersion[]>,
  at: string,
): ResolvedTemplate {
  const items: ResolvedItem[] = [];
  const missing: string[] = [];

  for (const item of template.items) {
    const version = versionAt(versionsByFood.get(item.foodId) ?? [], at);
    if (version === null) {
      missing.push(item.foodId);
      continue;
    }
    items.push({ foodId: item.foodId, foodVersionId: version.id, quantity: item.quantity, unit: item.unit });
  }

  return { items, missing };
}

export type LoggedItem = { readonly foodId: string; readonly quantity: string; readonly unit: string };

/** Turn a meal that was just logged into a reusable template. */
export function templateFromMeal(
  id: string,
  name: string,
  slot: string | null,
  items: readonly LoggedItem[],
): MealTemplate {
  return {
    id,
    name: name.trim(),
    slot,
    items: items.map((item) => ({ foodId: item.foodId, quantity: item.quantity, unit: item.unit })),
    lastUsedAt: null,
    timesUsed: 0,
  };
}

/**
 * How far a template has drifted from what is actually eaten under it.
 *
 * Reports the foods that appear in most meals logged from this template but not
 * in the template itself, and vice versa. Cheap, and it is what stops tier 2
 * rotting into a lie after six months — a "usual breakfast" that has not been
 * the usual breakfast since March is a template the operator stops trusting and
 * then stops using.
 *
 * A report, never an automatic update. The template is the operator's
 * declaration of what their usual breakfast *is*.
 */
export function templateDrift(
  template: MealTemplate,
  mealsLogged: readonly (readonly LoggedItem[])[],
  threshold = 0.6,
): { readonly missingFromTemplate: readonly string[]; readonly unusedInPractice: readonly string[] } {
  if (mealsLogged.length < MIN_MEALS_FOR_DRIFT) return { missingFromTemplate: [], unusedInPractice: [] };

  const inTemplate = new Set(template.items.map((item) => item.foodId));
  const appearances = new Map<string, number>();

  for (const meal of mealsLogged) {
    for (const foodId of new Set(meal.map((item) => item.foodId))) {
      appearances.set(foodId, (appearances.get(foodId) ?? 0) + 1);
    }
  }

  const usually = (foodId: string): boolean =>
    (appearances.get(foodId) ?? 0) / mealsLogged.length >= threshold;

  return {
    missingFromTemplate: [...appearances.keys()].filter((foodId) => !inTemplate.has(foodId) && usually(foodId)),
    unusedInPractice: [...inTemplate].filter((foodId) => !usually(foodId)),
  };
}

/**
 * Below this, drift is noise.
 *
 * Four meals. Two deviations out of three is a fortnight of coincidence, not a
 * change of habit, and a template that suggests rewriting itself after one
 * unusual morning is a template that nags.
 */
export const MIN_MEALS_FOR_DRIFT = 4;

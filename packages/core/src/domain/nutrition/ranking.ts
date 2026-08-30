/**
 * Tiers 1 and 2 — recents, frequents, and templates.
 *
 * This is the module the ten-second rule actually rests on. §2.2 makes it a
 * ship gate:
 *
 *   "**If a generic food-database search is the primary interaction, the module
 *    has failed P1 and should not ship.**"
 *
 * §4.3's first tier is "recents and frequents — one tap, covers the large
 * majority of real intake for a person who eats broadly the same things". This
 * file decides what those twelve tiles are, and getting it wrong is how the
 * operator ends up searching — which is the failure condition, stated.
 *
 * ## Recency-decayed frequency, not either one alone
 *
 *   score = timesEaten × 0.5 ^ (daysSince / HALF_LIFE_DAYS)
 *
 * Pure recency puts one restaurant dessert above the daily oats. Pure frequency
 * freezes the grid after a diet change and never surfaces the new staple — six
 * months of old habits outvote three weeks of current ones. A half-life makes
 * the grid track what is *currently* true without forgetting what is *usually*
 * true, and fourteen days is roughly how long a change of routine takes to
 * become the routine.
 *
 * ## The slot bonus, and why it is a bonus rather than a filter
 *
 * Breakfast foods should lead at breakfast. But filtering to foods eaten at this
 * slot would hide a food the operator is about to eat at an unusual time — and
 * an empty grid at 03:00 sends them to search, which is the thing being
 * prevented. So the slot lifts, it does not exclude.
 */

import { parseInstant } from '../../temporal/instant';
import type { ProteinSource } from './nutrient';

/** How long it takes for a food's frequency to count half as much. */
export const HALF_LIFE_DAYS = 14;

/**
 * How many tiles the grid holds.
 *
 * Enough to cover the majority of intake at n=1, small enough to be a grid you
 * scan rather than a list you read. A longer grid is a menu, and §3.3(4) is
 * clear that a menu is navigation.
 */
export const MAX_SUGGESTIONS = 12;

/** How many template tiles sit above the grid. */
export const MAX_TEMPLATE_SUGGESTIONS = 3;

/** Multiplier applied when a food is usually eaten at this slot. */
const SLOT_BONUS = 1.5;

export type MealSlot = string;

export type FoodUsage = {
  readonly foodId: string;
  readonly timesEaten: number;
  readonly lastEatenAt: string | null;
  /** How many times this food has been eaten at each slot. */
  readonly slotCounts: Readonly<Record<string, number>>;
  /** The quantity last logged, which becomes the tile's default. */
  readonly lastQuantity: string | null;
  readonly lastUnit: string | null;
};

export type Suggestion = {
  readonly foodId: string;
  readonly score: number;
  readonly defaultQuantity: string | null;
  readonly defaultUnit: string | null;
};

export type SuggestOptions = {
  readonly nowIso: string;
  readonly slot: MealSlot | null;
  readonly limit?: number;
};

/**
 * Rank the library for the current slot.
 *
 * A food never eaten scores zero and sorts last but is **not excluded** — the
 * grid is a view of the library, and a food added five minutes ago that has not
 * been eaten yet should still be reachable without searching for it.
 */
export function suggestFoods(usage: readonly FoodUsage[], options: SuggestOptions): readonly Suggestion[] {
  /* §11.3's sanctioned parse point. A bare `Date.parse` here would be the
   * rule's whole subject, and this file runs on the P1 capture path. */
  const now = parseInstant(options.nowIso)?.getTime() ?? null;
  const limit = options.limit ?? MAX_SUGGESTIONS;

  const scored = usage.map((entry) => {
    const days = daysSince(entry.lastEatenAt, now);
    const decay = days === null ? 0 : 0.5 ** (days / HALF_LIFE_DAYS);
    const base = entry.timesEaten * decay;

    const slotShare = slotShareFor(entry, options.slot);
    const score = base * (1 + (SLOT_BONUS - 1) * slotShare);

    return {
      foodId: entry.foodId,
      score,
      defaultQuantity: entry.lastQuantity,
      defaultUnit: entry.lastUnit,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.foodId.localeCompare(b.foodId))
    .slice(0, limit);
}

/**
 * What fraction of this food's history happened at this slot.
 *
 * A share rather than a boolean, so a food eaten at breakfast nine times out of
 * ten is lifted more than one eaten at breakfast half the time. `0` when there
 * is no slot, no history, or the food has never been eaten at it.
 */
function slotShareFor(entry: FoodUsage, slot: MealSlot | null): number {
  if (slot === null || entry.timesEaten === 0) return 0;
  const atSlot = entry.slotCounts[slot] ?? 0;
  return Math.min(1, atSlot / entry.timesEaten);
}

function daysSince(lastEatenAt: string | null, nowMillis: number | null): number | null {
  if (lastEatenAt === null || nowMillis === null) return null;
  const then = parseInstant(lastEatenAt);
  if (then === null) return null;
  return Math.max(0, (nowMillis - then.getTime()) / 86_400_000);
}

/* -------------------------------------------------------------------------
 * Templates
 * ---------------------------------------------------------------------- */

export type TemplateUsage = {
  readonly templateId: string;
  readonly slot: string | null;
  readonly timesUsed: number;
  readonly lastUsedAt: string | null;
};

/**
 * Rank templates for the current slot. Same decay, and the slot is a filter
 * here rather than a bonus.
 *
 * The asymmetry with {@link suggestFoods} is deliberate. A template *names* a
 * meal — "usual breakfast" — so showing it at dinner is showing the wrong
 * object, not merely a lower-ranked one. A food, by contrast, is just a food.
 * Templates with no slot are always eligible.
 */
export function rankTemplates(
  templates: readonly TemplateUsage[],
  slot: MealSlot | null,
  nowIso: string,
  limit = MAX_TEMPLATE_SUGGESTIONS,
): readonly string[] {
  const now = parseInstant(nowIso)?.getTime() ?? null;

  return templates
    .filter((template) => slot === null || template.slot === null || template.slot === slot)
    .map((template) => {
      const days = daysSince(template.lastUsedAt, now);
      const decay = days === null ? 0 : 0.5 ** (days / HALF_LIFE_DAYS);
      /* `+ 1` so a template defined but never used still ranks above nothing —
       * a template nobody can find is a template that never gets its second
       * use, and tier 2 dies quietly. */
      return { templateId: template.templateId, score: (template.timesUsed + 1) * Math.max(decay, 0.05) };
    })
    .sort((a, b) => b.score - a.score || a.templateId.localeCompare(b.templateId))
    .slice(0, limit)
    .map((entry) => entry.templateId);
}

/* -------------------------------------------------------------------------
 * Slots
 * ---------------------------------------------------------------------- */

/**
 * The default slot vocabulary.
 *
 * `meal.slot` is free text in the schema and stays that way — a person who eats
 * five times a day should not be told they have four meals. These are the
 * defaults the picker offers, not a closed set.
 */
export const DEFAULT_SLOTS: readonly string[] = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * Guess the slot from the local wall clock.
 *
 * A heuristic, and it is overridable on the screen in one tap. A heuristic that
 * cannot be corrected is a heuristic that is simply wrong for the operator who
 * eats at 03:00 — and being wrong here costs the ten seconds this whole module
 * is trying to save.
 */
export function slotForLocalTime(hhmm: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(hhmm.trim());
  if (match === null) return 'snack';
  const hour = Number(match[1]);

  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 18 && hour < 23) return 'dinner';
  return 'snack';
}

/** Food classification, re-exported so the picker and the split agree. */
export type { ProteinSource };

/**
 * Two deterministic parsers — §4.3's tier 3, and the thing that actually fixes
 * cold start.
 *
 * Both are regular expressions over text the operator supplies. No model, no
 * network. §10.0: "The model never computes, discovers, or asserts", and §12
 * puts the AI layer in December regardless — so this is the same machinery
 * `domain/document/lab-parser.ts` uses, pointed at a different kind of page.
 *
 * ## `parseNutritionLabel` is the one that pays for itself
 *
 * The ten-second rule is a **steady-state** budget over a fed library. On day
 * one, tiers 1–3 are all empty and every meal costs a minute per new food. That
 * is the real risk, and a meal-text parser does nothing about it — it can only
 * resolve names to foods that already exist.
 *
 * A nutrition panel prints `Protein 12.5 g` exactly the way a lab report prints
 * `Ferritin 45 ng/mL`. Pasting one turns a two-minute add-a-food into twenty
 * seconds, forever, for every food ever added.
 *
 * ## `parseMealText` is narrow on purpose, and is not on the critical path
 *
 * It resolves names **only against the operator's own library**, never an
 * external database, and refuses rather than guesses.
 *
 * Worth stating plainly: **tier 3 is slower than tier 1 for the case it was
 * introduced to serve.** Typing "3 eggs, 100g oats, scoop whey" on a phone is
 * about fifteen seconds before the confirmation step; tapping three tiles is
 * about five. It wins on a desktop keyboard for a long unusual meal. Its real
 * value is as the deterministic pre-filter December's model path sits behind —
 * routing only the fragments this refuses is cheaper, more auditable, and makes
 * §10.0 far easier to honour, because the model's job shrinks to "map this one
 * fragment to one of these two hundred foods".
 */

import type { Food } from './food';
import { foodLabel, scoreFoodMatch } from './food';
import type { NutrientDefinition } from './nutrient';
import { foldNutrientName, fromInternationalUnits, normaliseNutrientUnit, nutrientFor } from './nutrient';
import { isPseudoUnit } from './nutrients';
import type { FoodUsage } from './ranking';

export const PARSER_ENGINE = 'naitikos/nutrition-parser';
export const PARSER_VERSION = '1';

/** Below this, a parsed field arrives unticked and has to be accepted. */
export const LABEL_REVIEW_FLOOR = 0.7;

/** No parse is certain — it scores a pattern match, not a number's truth. */
export const MAX_PARSE_CONFIDENCE = 0.95;

/* =========================================================================
 * The nutrition label
 * ====================================================================== */

export type LabelField = {
  readonly nutrientKey: string;
  readonly displayName: string;
  readonly printedName: string;
  /** In the nutrient's canonical unit, as a decimal string. */
  readonly amount: string;
  readonly canonicalUnit: string;
  readonly printedUnit: string | null;
  /** True when the label printed IU and it was converted. */
  readonly fromIU: boolean;
  readonly confidence: number;
  readonly line: number;
  readonly sourceLine: string;
};

export type ParsedLabel = {
  readonly fields: readonly LabelField[];
  /** Lines that looked like a nutrient row and matched no catalogued nutrient. */
  readonly unmatchedLines: number;
  /** The basis the panel is stated per, when it says. `100 g` usually. */
  readonly basis: { readonly quantity: string; readonly unit: string } | null;
};

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const NUMBER_TOKEN = /^[<>]?\d+(?:[.,]\d+)?$/u;
const UNIT_AFTER = new RegExp(String.raw`^\s*([A-Za-zµμ%][A-Za-zµμ%/.]*)`, 'u');
const LOOKS_LIKE_ROW = new RegExp(String.raw`[A-Za-z].*\s${NUMBER}`, 'u');
const BASIS = new RegExp(String.raw`per\s+(${NUMBER})\s*(g|ml|mL|G|ML)\b`, 'u');

/**
 * Read a nutrition panel.
 *
 * Same shape as the lab parser: split at the first *bare* number token, because
 * "Omega-3" and "Vitamin B12" have digits inside their names and a digit-scan
 * reads a B12 line as 12 µg.
 */
export function parseNutritionLabel(text: string): ParsedLabel {
  const lines = text.split(/\r?\n/u);
  const fields: LabelField[] = [];
  const claimed = new Set<string>();
  let unmatchedLines = 0;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length < 3) continue;

    const tokens = line.split(/\s+/u);
    const valueIndex = tokens.findIndex((token) => NUMBER_TOKEN.test(token));
    if (valueIndex <= 0) {
      if (LOOKS_LIKE_ROW.test(line)) unmatchedLines += 1;
      continue;
    }

    const printedName = tokens.slice(0, valueIndex).join(' ');
    const definition = matchNutrientLabel(printedName);
    if (definition === null) {
      if (LOOKS_LIKE_ROW.test(line)) unmatchedLines += 1;
      continue;
    }

    /* One field per nutrient. A panel prints "of which sugars" under
     * carbohydrate and sometimes repeats the total in a summary. */
    if (claimed.has(definition.slug)) continue;

    const printedValue = (tokens[valueIndex] as string).replace(/^[<>]/u, '').replace(',', '.');
    const afterValue = tokens.slice(valueIndex + 1).join(' ');
    const unitMatch = UNIT_AFTER.exec(afterValue);
    const printedUnit = unitMatch === null ? null : (unitMatch[1] as string);

    const converted = convertPrinted(definition, printedValue, printedUnit);
    if (converted === null) {
      unmatchedLines += 1;
      continue;
    }

    claimed.add(definition.slug);
    fields.push({
      nutrientKey: definition.slug,
      displayName: definition.displayName,
      printedName,
      amount: converted.amount,
      canonicalUnit: definition.canonicalUnit,
      printedUnit,
      fromIU: converted.fromIU,
      /*
       * Scores the *parse*, not the number. A row whose unit was printed and
       * understood was read; a bare `Protein 16.9` might be a nutrient row or
       * might be a serving count, so it lands below the review floor and has to
       * be ticked deliberately. `convertPrinted` has already refused anything
       * whose unit was printed and not understood, so there are two cases here
       * rather than three.
       */
      confidence: Math.min(MAX_PARSE_CONFIDENCE, printedUnit === null ? 0.5 : 0.9),
      line: index + 1,
      sourceLine: line,
    });
  }

  return { fields, unmatchedLines, basis: findBasis(text) };
}

/**
 * Resolve a printed nutrient name.
 *
 * Looser than the lab parser's analyte matcher, and deliberately: a panel's
 * vocabulary is tiny and fixed, and the operator is already looking at the form
 * they are about to submit — so a false match is corrected in the second it
 * takes to read it, whereas a miss is a field they retype by hand.
 */
export function matchNutrientLabel(printed: string): NutrientDefinition | null {
  const folded = foldNutrientName(printed);
  if (folded === '') return null;

  const direct = nutrientFor(folded);
  if (direct !== null) return direct;

  /* "of which saturates" and "total fat" both trail or lead their nutrient. */
  const stripped = folded
    .replace(/^of which\s+/u, '')
    .replace(/^total\s+/u, '')
    .replace(/\s+content$/u, '')
    .trim();

  return stripped === folded ? null : nutrientFor(stripped);
}

function convertPrinted(
  definition: NutrientDefinition,
  value: string,
  printedUnit: string | null,
): { readonly amount: string; readonly fromIU: boolean } | null {
  /* IU is not a registered unit and must never be treated as one. The factor
   * is substance-specific and lives on the nutrient; `null` refuses. */
  if (printedUnit !== null && /^i\.?u\.?$/iu.test(printedUnit.trim())) {
    const converted = fromInternationalUnits(definition, value);
    return converted === null ? null : { amount: formatDecimalString(converted.value), fromIU: true };
  }

  if (printedUnit === null) return { amount: value, fromIU: false };

  const unit = normaliseNutrientUnit(printedUnit);
  if (unit === null) return null;
  if (unit === definition.canonicalUnit) return { amount: value, fromIU: false };

  /* Left to `toCanonicalNutrient` at the write boundary rather than converted
   * here: this parser's job is to read the page, and the conversion has one
   * home. The printed unit travels with the field so the caller can do it. */
  return { amount: value, fromIU: false };
}

function formatDecimalString(value: { readonly unscaled: bigint; readonly scale: number }): string {
  const negative = value.unscaled < 0n;
  const digits = (negative ? -value.unscaled : value.unscaled).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = value.scale === 0 ? '' : `.${digits.slice(digits.length - value.scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`.replace(/\.?0+$/u, '');
}

function findBasis(text: string): { readonly quantity: string; readonly unit: string } | null {
  const match = BASIS.exec(text);
  if (match === null) return null;
  return { quantity: (match[1] as string).replace(',', '.'), unit: (match[2] as string).toLowerCase() === 'ml' ? 'mL' : 'g' };
}

/* =========================================================================
 * The meal line
 * ====================================================================== */

export type ParsedMealItem = {
  /** Stable within one parse, so a partly reviewed list does not shuffle. */
  readonly key: string;
  readonly foodId: string;
  readonly foodLabel: string;
  readonly quantity: string;
  readonly unit: string;
  readonly confidence: number;
  /** The fragment verbatim. Stored on `meal_item.parsedFromText` (§9.2). */
  readonly fragment: string;
};

export type ParsedMeal = {
  readonly items: readonly ParsedMealItem[];
  /** Fragments that matched no food in the library. Reported, never guessed. */
  readonly unresolved: readonly string[];
};

/** `a`, `one`, `half` — what people actually type instead of a digit. */
const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  a: '1',
  an: '1',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  half: '0.5',
  couple: '2',
});

const FRAGMENT_SPLIT = /[,+\n;]+/u;

/**
 * How well a name must match before it is offered at all.
 *
 * 40 is `full.includes(needle)` in `scoreFoodMatch`. Below that the match is
 * "all these words appear somewhere", which at n=1 resolves "oil" to "olive oil
 * spray" as readily as to olive oil — and an item the operator has to notice and
 * correct is worse than a fragment reported as unresolved.
 */
export const MIN_FOOD_MATCH_SCORE = 40;

/**
 * Parse a typed meal against the operator's own library.
 *
 * The tie-break on ranking is what makes this work at n=1: "whey" means the one
 * whey the operator owns, and frequency decides it rather than alphabetical
 * order.
 */
export function parseMealText(
  text: string,
  library: readonly Food[],
  usage: readonly FoodUsage[],
): ParsedMeal {
  const timesEaten = new Map(usage.map((entry) => [entry.foodId, entry.timesEaten]));
  const items: ParsedMealItem[] = [];
  const unresolved: string[] = [];

  for (const [index, raw] of text.split(FRAGMENT_SPLIT).entries()) {
    const fragment = raw.trim();
    if (fragment === '') continue;

    const parsed = splitFragment(fragment);
    if (parsed === null) {
      unresolved.push(fragment);
      continue;
    }

    const best = bestMatch(parsed.name, library, timesEaten);
    if (best === null) {
      unresolved.push(fragment);
      continue;
    }

    items.push({
      key: `fragment:${String(index + 1)}`,
      foodId: best.food.id,
      foodLabel: foodLabel(best.food),
      quantity: parsed.quantity,
      unit: parsed.unit,
      confidence: Math.min(
        MAX_PARSE_CONFIDENCE,
        /* Scored on how much of the expected shape was found, exactly as the
         * lab parser's `scoreCandidate` does. An exact name with an explicit
         * unit is the only thing that reaches the top of the range. */
        0.4 + (best.score >= 80 ? 0.3 : best.score >= 50 ? 0.2 : 0.1) + (parsed.explicitUnit ? 0.2 : 0.05),
      ),
      fragment,
    });
  }

  return { items, unresolved };
}

/**
 * Split `[quantity] [unit] [name]` out of a fragment.
 *
 * Token-wise rather than by one regex, because the three interesting cases all
 * involve a token that is *both* a unit and part of a name:
 *
 * - `3 eggs` — "eggs" is a pseudo-unit **and** the food. If a unit consumes it
 *   the name is empty and nothing resolves.
 * - `scoop whey` — no leading number at all; the unit leads.
 * - `100g oats` — the unit is glued to the number.
 *
 * A single expression can be made to handle any two of those and not the third.
 */
function splitFragment(
  fragment: string,
): { readonly quantity: string; readonly unit: string; readonly name: string; readonly explicitUnit: boolean } | null {
  const tokens = fragment.trim().split(/\s+/u).filter((token) => token !== '');
  if (tokens.length === 0) return null;

  const first = tokens[0] as string;

  /* `100g` — the unit glued to the number. */
  const glued = /^(\d+(?:[.,]\d+)?)([a-zA-Z]+)$/u.exec(first);
  if (glued !== null && tokens.length > 1) {
    const unit = glued[2] as string;
    if (normaliseNutrientUnit(unit) !== null || isPseudoUnit(unit)) {
      return {
        quantity: (glued[1] as string).replace(',', '.'),
        unit,
        name: tokens.slice(1).join(' '),
        explicitUnit: true,
      };
    }
  }

  const leadingQuantity = /^\d+(?:[.,]\d+)?$/u.test(first)
    ? first.replace(',', '.')
    : (NUMBER_WORDS[first.toLowerCase()] ?? null);

  if (leadingQuantity !== null) {
    const rest = tokens.slice(1);
    if (rest.length === 0) return null;

    const maybeUnit = rest[0] as string;
    const isUnit = normaliseNutrientUnit(maybeUnit) !== null || isPseudoUnit(maybeUnit);

    /*
     * The unit only consumes the token when something is left to be the food.
     * `3 eggs` keeps "eggs" as the name and takes `serving` as the unit, which
     * then resolves against the egg's own serving row — exactly the indirection
     * pseudo-units exist for.
     */
    if (isUnit && rest.length > 1) {
      return { quantity: leadingQuantity, unit: maybeUnit, name: rest.slice(1).join(' '), explicitUnit: true };
    }
    return { quantity: leadingQuantity, unit: 'serving', name: rest.join(' '), explicitUnit: false };
  }

  /* `scoop whey` — the unit leads and the quantity is implied. */
  if (isPseudoUnit(first) && tokens.length > 1) {
    return { quantity: '1', unit: first, name: tokens.slice(1).join(' '), explicitUnit: true };
  }

  /* A bare name — "oats". One serving is the only reading, and it is scored
   * low rather than refused, because it is what a person types when they mean
   * their usual amount. */
  return { quantity: '1', unit: 'serving', name: tokens.join(' '), explicitUnit: false };
}

/**
 * Match a name against the library, tolerating a plural.
 *
 * "3 eggs" names a food called "Egg". Stripping a trailing `s` on a failed
 * match is the whole of the tolerance — a stemmer would start matching "oat" to
 * "oats" *and* "oat milk", and at n=1 the cheap rule is the correct one.
 */
function bestMatch(
  name: string,
  library: readonly Food[],
  timesEaten: ReadonlyMap<string, number>,
): { readonly food: Food; readonly score: number } | null {
  for (const candidate of [name, name.replace(/s$/iu, '')]) {
    if (candidate.trim() === '') continue;
    const ranked = library
      .map((food) => ({ food, score: scoreFoodMatch(food, candidate) }))
      .filter((entry) => entry.score >= MIN_FOOD_MATCH_SCORE)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (timesEaten.get(b.food.id) ?? 0) - (timesEaten.get(a.food.id) ?? 0) ||
          a.food.name.localeCompare(b.food.name),
      );
    const best = ranked[0];
    if (best !== undefined) return best;
  }
  return null;
}

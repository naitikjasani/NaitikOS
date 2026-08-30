import { describe, expect, it } from 'vitest';

import type { Food } from './food';
import { LABEL_REVIEW_FLOOR, matchNutrientLabel, parseMealText, parseNutritionLabel } from './parser';
import type { FoodUsage } from './ranking';

/** A nutrition panel as one comes off the back of an Indian pack. */
const PANEL = `
  NUTRITION INFORMATION
  Approximate values per 100 g

  Energy                 389 kcal
  Protein                16.9 g
  Carbohydrate           66.3 g
    of which sugars      0.99 g
  Total Fat              6.9 g
    of which saturates   1.2 g
  Dietary Fibre          10.6 g
  Sodium                 2 mg
  Vitamin D              400 IU
  Selenium               34 mcg
`;

describe('the nutrition label parser', () => {
  const parsed = parseNutritionLabel(PANEL);

  it('reads the macros, in their canonical units', () => {
    const byKey = new Map(parsed.fields.map((field) => [field.nutrientKey, field]));
    expect(byKey.get('energy')?.amount).toBe('389');
    expect(byKey.get('protein')?.amount).toBe('16.9');
    expect(byKey.get('carbohydrate')?.amount).toBe('66.3');
    expect(byKey.get('fibre')?.amount).toBe('10.6');
  });

  it('reads "of which" rows as their own nutrients', () => {
    const byKey = new Map(parsed.fields.map((field) => [field.nutrientKey, field]));
    expect(byKey.get('sugar')?.amount).toBe('0.99');
    expect(byKey.get('saturated_fat')?.amount).toBe('1.2');
  });

  /**
   * IU is not a unit this registry can hold. The factor is substance-specific,
   * lives on the nutrient, and the conversion is marked so the form can say so.
   */
  it('converts vitamin D from international units and flags that it did', () => {
    const vitaminD = parsed.fields.find((field) => field.nutrientKey === 'vitamin_d');
    // 400 IU ÷ 40 = 10 µg.
    expect(vitaminD?.amount).toBe('10');
    expect(vitaminD?.canonicalUnit).toBe('mcg');
    expect(vitaminD?.fromIU).toBe(true);
  });

  it('counts a nutrient the catalogue does not know rather than dropping it silently', () => {
    expect(parsed.fields.some((field) => field.printedName.includes('Selenium'))).toBe(false);
    expect(parsed.unmatchedLines).toBeGreaterThan(0);
  });

  it('reads the basis the panel is stated per', () => {
    expect(parsed.basis).toEqual({ quantity: '100', unit: 'g' });
  });

  /**
   * "Vitamin B12" has a digit inside its name. A digit-scan reads that line as
   * 12 µg; tokenising and splitting at the first *bare* number does not.
   */
  it('does not read a digit inside the nutrient name as the value', () => {
    const b12 = parseNutritionLabel('Vitamin B12   2.4 mcg').fields[0];
    expect(b12?.nutrientKey).toBe('vitamin_b12');
    expect(b12?.amount).toBe('2.4');
  });

  it('accepts a decimal comma, which European packs print', () => {
    expect(parseNutritionLabel('Protein 16,9 g').fields[0]?.amount).toBe('16.9');
  });

  it('scores a full row above the review floor and a bare one below it', () => {
    const full = parseNutritionLabel('Protein 16.9 g').fields[0];
    const bare = parseNutritionLabel('Protein 16.9').fields[0];
    expect(full?.confidence).toBeGreaterThanOrEqual(LABEL_REVIEW_FLOOR);
    expect(bare?.confidence).toBeLessThan(LABEL_REVIEW_FLOOR);
  });

  it('never reaches certainty, because it scores a pattern match', () => {
    for (const field of parsed.fields) {
      expect(field.confidence).toBeLessThan(1);
    }
  });

  it('emits one field per nutrient, even when a panel repeats it', () => {
    const twice = parseNutritionLabel('Protein 16.9 g\nProtein 16.9 g');
    expect(twice.fields).toHaveLength(1);
  });
});

describe('nutrient label matching', () => {
  it('strips the qualifiers panels put in front', () => {
    expect(matchNutrientLabel('Total Fat')?.slug).toBe('fat');
    expect(matchNutrientLabel('of which sugars')?.slug).toBe('sugar');
    expect(matchNutrientLabel('Sodium content')?.slug).toBe('sodium');
  });

  it('returns null for a nutrient this system does not register', () => {
    expect(matchNutrientLabel('Selenium')).toBeNull();
    expect(matchNutrientLabel('')).toBeNull();
  });
});

/* =========================================================================
 * The meal line
 * ====================================================================== */

const LIBRARY: readonly Food[] = [
  food('f-egg', 'Egg', 12),
  food('f-oats', 'Oats', 40),
  food('f-whey', 'Whey isolate', 30),
  food('f-oatmilk', 'Oat milk', 2),
];

const USAGE: readonly FoodUsage[] = LIBRARY.map((entry) => ({
  foodId: entry.id,
  timesEaten: entry.timesEaten,
  lastEatenAt: '2026-11-19T08:00:00.000Z',
  slotCounts: {},
  lastQuantity: null,
  lastUnit: null,
}));

function food(id: string, name: string, timesEaten: number): Food {
  return {
    id,
    name,
    brand: null,
    gtin: null,
    lastEatenAt: '2026-11-19T08:00:00.000Z',
    timesEaten,
    isVegetarian: true,
    isVegan: false,
    proteinSource: null,
  };
}

describe('the meal text parser', () => {
  it('parses §4.3’s own example', () => {
    const parsed = parseMealText('3 eggs, 100g oats, scoop whey', LIBRARY, USAGE);

    expect(parsed.unresolved).toEqual([]);
    expect(parsed.items).toHaveLength(3);

    expect(parsed.items[0]?.foodId).toBe('f-egg');
    expect(parsed.items[0]?.quantity).toBe('3');

    expect(parsed.items[1]?.foodId).toBe('f-oats');
    expect(parsed.items[1]?.quantity).toBe('100');
    expect(parsed.items[1]?.unit).toBe('g');

    expect(parsed.items[2]?.foodId).toBe('f-whey');
  });

  /** At n=1, "whey" means the one whey the operator owns. */
  it('breaks a tie on how often the food is actually eaten', () => {
    const parsed = parseMealText('oat', LIBRARY, USAGE);
    expect(parsed.items[0]?.foodId).toBe('f-oats');
  });

  /**
   * The boundary that makes this safe: the library, and nothing else. A
   * fragment naming a food that does not exist is reported, never invented.
   */
  it('refuses a food that is not in the library', () => {
    const parsed = parseMealText('200g quinoa', LIBRARY, USAGE);
    expect(parsed.items).toEqual([]);
    expect(parsed.unresolved).toEqual(['200g quinoa']);
  });

  it('reads a number word', () => {
    const parsed = parseMealText('two eggs', LIBRARY, USAGE);
    expect(parsed.items[0]?.quantity).toBe('2');
  });

  it('defaults a bare name to one serving, at low confidence', () => {
    const parsed = parseMealText('oats', LIBRARY, USAGE);
    expect(parsed.items[0]?.quantity).toBe('1');
    expect(parsed.items[0]?.unit).toBe('serving');
    expect(parsed.items[0]?.confidence).toBeLessThan(0.8);
  });

  it('splits on commas, plus signs and newlines', () => {
    expect(parseMealText('oats + whey', LIBRARY, USAGE).items).toHaveLength(2);
    expect(parseMealText('oats\nwhey', LIBRARY, USAGE).items).toHaveLength(2);
  });

  /** §9.2's `parsedFromText` column: a wrong resolution stays auditable. */
  it('keeps every fragment verbatim', () => {
    const parsed = parseMealText('100g oats', LIBRARY, USAGE);
    expect(parsed.items[0]?.fragment).toBe('100g oats');
  });

  it('produces stable keys across runs', () => {
    const first = parseMealText('100g oats', LIBRARY, USAGE);
    const second = parseMealText('100g oats', LIBRARY, USAGE);
    expect(first.items[0]?.key).toBe(second.items[0]?.key);
  });

  it('handles an empty string without throwing', () => {
    expect(parseMealText('', LIBRARY, USAGE)).toEqual({ items: [], unresolved: [] });
  });
});

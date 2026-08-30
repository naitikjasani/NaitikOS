/**
 * The seeded food library — the highest-leverage decision in the Nutrition
 * module, and worth more than either parser.
 *
 * ## Why this exists
 *
 * §2.2 makes the ten-second rule a ship gate: "If a generic food-database
 * search is the primary interaction, the module has failed P1 and should not
 * ship." §4.3's tier 1 is "recents and frequents — one tap".
 *
 * But on day one, tiers 1, 2 and 3 are all empty. Every meal costs a minute per
 * new food, and the operator gives up in week two — which is §13.1's *fatal*
 * risk, arriving through the module most likely to trigger it.
 *
 * This library is what turns day one into day thirty for the majority of
 * intake. Same argument the exercise seed makes: "an empty library turns the
 * first session into forty minutes of data entry, which is exactly the friction
 * the whole module is arranged to remove."
 *
 * ## What is in it
 *
 * The actual staples of a vegetarian-plus-eggs Indian bulking diet. Not a
 * catalogue — §3.1's warning about a search box where "row" returns thirty
 * variants applies here too, and a grid of twelve tiles cannot be fed by a
 * thousand near-duplicates.
 *
 * ## Where the numbers come from, and the licensing constraint
 *
 * USDA FoodData Central is public domain and safe to use. **IFCT 2017 is not
 * freely redistributable**, so nothing is copied from it. These values are
 * hand-entered typical figures for the food as commonly prepared, and every
 * version records that in `sourceNote` — which is what that column is for.
 *
 * They are estimates and the record says so. A person weighing their oats to
 * the gram against a label that is itself ±10% is measuring their own
 * precision, not their intake.
 *
 * ## Idempotent on the name
 *
 * Re-seeding must not create a second "Paneer". The repository upserts on the
 * folded name, which is also why nothing here has a client-generated id.
 */

import type { ProteinSource } from '@naitikos/core';

export type SeedNutrient = {
  readonly key: string;
  readonly amount: string;
  readonly unit: string;
};

export type SeedFood = {
  readonly name: string;
  readonly brand: string | null;
  readonly isVegetarian: boolean;
  readonly isVegan: boolean;
  readonly proteinSource: ProteinSource | null;
  /** Per 100 g unless stated. */
  readonly basisQuantity: string;
  readonly basisUnit: string;
  /** What one of this food is, where "one" is a real thing. */
  readonly servingQuantity: string | null;
  readonly servingUnit: string | null;
  readonly servingLabel: string | null;
  readonly nutrients: readonly SeedNutrient[];
};

/** Shorthand so a row reads as a label rather than as a data structure. */
function macros(
  energy: number,
  protein: number,
  carbohydrate: number,
  fat: number,
  extra: readonly SeedNutrient[] = [],
): readonly SeedNutrient[] {
  return [
    { key: 'energy', amount: String(energy), unit: 'kcal' },
    { key: 'protein', amount: String(protein), unit: 'g' },
    { key: 'carbohydrate', amount: String(carbohydrate), unit: 'g' },
    { key: 'fat', amount: String(fat), unit: 'g' },
    ...extra,
  ];
}

const g = (amount: number, key: string): SeedNutrient => ({ key, amount: String(amount), unit: 'g' });
const mg = (amount: number, key: string): SeedNutrient => ({ key, amount: String(amount), unit: 'mg' });
const mcg = (amount: number, key: string): SeedNutrient => ({ key, amount: String(amount), unit: 'mcg' });

export const SEED_FOODS: readonly SeedFood[] = [
  /* --- eggs and dairy -------------------------------------------------- */
  {
    name: 'Egg, whole',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'egg',
    basisQuantity: '100',
    basisUnit: 'g',
    /* One large egg without shell. The serving row is what makes "3 eggs"
     * resolvable — without it a pseudo-unit is refused, by design. */
    servingQuantity: '50',
    servingUnit: 'g',
    servingLabel: '1 egg',
    nutrients: macros(143, 12.6, 0.7, 9.5, [mcg(2, 'vitamin_d'), mcg(0.9, 'vitamin_b12'), mg(1.8, 'iron'), mg(56, 'calcium'), mg(1.3, 'zinc')]),
  },
  {
    name: 'Egg white',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'egg',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '33',
    servingUnit: 'g',
    servingLabel: '1 white',
    nutrients: macros(52, 10.9, 0.7, 0.2),
  },
  {
    name: 'Paneer',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    nutrients: macros(296, 18.9, 3.6, 23, [mg(208, 'calcium'), mcg(1.1, 'vitamin_b12'), mg(1.1, 'zinc')]),
  },
  {
    name: 'Milk, toned',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '200',
    servingUnit: 'mL',
    servingLabel: '1 glass',
    nutrients: macros(58, 3.1, 4.7, 3, [mg(120, 'calcium'), mcg(0.4, 'vitamin_b12'), { key: 'water', amount: '88', unit: 'mL' }]),
  },
  {
    name: 'Milk, full fat',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '200',
    servingUnit: 'mL',
    servingLabel: '1 glass',
    nutrients: macros(67, 3.2, 4.7, 4.1, [mg(120, 'calcium'), mcg(0.4, 'vitamin_b12'), { key: 'water', amount: '87', unit: 'mL' }]),
  },
  {
    name: 'Curd',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(60, 3.1, 4.4, 3.3, [mg(149, 'calcium'), mcg(0.4, 'vitamin_b12')]),
  },
  {
    name: 'Greek yoghurt',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 pot',
    nutrients: macros(59, 10, 3.6, 0.4, [mg(110, 'calcium'), mcg(0.8, 'vitamin_b12')]),
  },
  {
    name: 'Cheese, processed',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '20',
    servingUnit: 'g',
    servingLabel: '1 slice',
    nutrients: macros(310, 20, 2, 25, [mg(600, 'calcium')]),
  },

  /* --- supplements ----------------------------------------------------- */
  {
    name: 'Whey protein isolate',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'supplement',
    basisQuantity: '100',
    basisUnit: 'g',
    /* One scoop. §4.2 names whey specifically as a skin-relevant intake, so
     * this is the row that makes "how much whey last week" answerable. */
    servingQuantity: '30',
    servingUnit: 'g',
    servingLabel: '1 scoop',
    nutrients: macros(373, 80, 6.7, 3.3, [mg(400, 'calcium')]),
  },
  {
    name: 'Whey protein concentrate',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'supplement',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '33',
    servingUnit: 'g',
    servingLabel: '1 scoop',
    nutrients: macros(400, 73, 10, 6, [mg(350, 'calcium')]),
  },

  /* --- grains and staples ---------------------------------------------- */
  {
    name: 'Oats, rolled',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '40',
    servingUnit: 'g',
    servingLabel: '1 serving',
    nutrients: macros(389, 16.9, 66.3, 6.9, [g(10.6, 'fibre'), mg(4.7, 'iron'), mg(4, 'zinc')]),
  },
  {
    name: 'Roti, wheat',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '40',
    servingUnit: 'g',
    servingLabel: '1 roti',
    nutrients: macros(297, 9.6, 55, 4.2, [g(5, 'fibre'), mg(3, 'iron')]),
  },
  {
    name: 'Rice, cooked white',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(130, 2.7, 28, 0.3, [g(0.4, 'fibre')]),
  },
  {
    name: 'Poha',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '60',
    servingUnit: 'g',
    servingLabel: '1 serving',
    nutrients: macros(346, 6.6, 77, 1.2, [mg(20, 'iron')]),
  },
  {
    name: 'Bread, whole wheat',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '30',
    servingUnit: 'g',
    servingLabel: '1 slice',
    nutrients: macros(247, 13, 41, 3.4, [g(7, 'fibre')]),
  },
  {
    name: 'Idli',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '40',
    servingUnit: 'g',
    servingLabel: '1 idli',
    nutrients: macros(139, 4.5, 28, 0.7),
  },

  /* --- legumes --------------------------------------------------------- */
  {
    name: 'Toor dal, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(121, 7.5, 20, 0.6, [g(5, 'fibre'), mg(1.6, 'iron')]),
  },
  {
    name: 'Moong dal, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(105, 7, 19, 0.4, [g(7.6, 'fibre'), mg(1.4, 'iron')]),
  },
  {
    name: 'Chana dal, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(164, 8.9, 27, 2.6, [g(7.6, 'fibre'), mg(2.9, 'iron'), mg(1.5, 'zinc')]),
  },
  {
    name: 'Rajma, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(127, 8.7, 22.8, 0.5, [g(6.4, 'fibre'), mg(2.9, 'iron'), mg(1, 'zinc')]),
  },
  {
    name: 'Chole, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(164, 8.9, 27.4, 2.6, [g(7.6, 'fibre'), mg(2.9, 'iron'), mg(1.5, 'zinc')]),
  },
  {
    name: 'Soya chunks, dry',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '30',
    servingUnit: 'g',
    servingLabel: '1 serving',
    nutrients: macros(345, 52, 33, 0.5, [g(13, 'fibre'), mg(20, 'iron'), mg(5, 'zinc')]),
  },
  {
    name: 'Tofu',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'legume',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    nutrients: macros(76, 8, 1.9, 4.8, [mg(350, 'calcium'), mg(5.4, 'iron')]),
  },
  {
    name: 'Peanut butter',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '32',
    servingUnit: 'g',
    servingLabel: '2 tbsp',
    nutrients: macros(588, 25, 20, 50, [g(6, 'fibre'), mg(2.3, 'zinc')]),
  },

  /* --- fats, nuts, fruit ------------------------------------------------ */
  {
    name: 'Ghee',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '5',
    servingUnit: 'g',
    servingLabel: '1 tsp',
    nutrients: macros(900, 0, 0, 100, [g(62, 'saturated_fat')]),
  },
  {
    name: 'Mustard oil',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '5',
    servingUnit: 'mL',
    servingLabel: '1 tsp',
    nutrients: macros(884, 0, 0, 100),
  },
  {
    name: 'Almonds',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '14',
    servingUnit: 'g',
    servingLabel: '10 almonds',
    nutrients: macros(579, 21, 22, 50, [g(12.5, 'fibre'), mg(269, 'calcium'), mg(3.7, 'iron'), mg(3.1, 'zinc')]),
  },
  {
    name: 'Walnuts',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: 'grain_other',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '30',
    servingUnit: 'g',
    servingLabel: '1 handful',
    nutrients: macros(654, 15, 14, 65, [g(6.7, 'fibre'), mg(3.1, 'zinc')]),
  },
  {
    name: 'Banana',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '118',
    servingUnit: 'g',
    servingLabel: '1 banana',
    nutrients: macros(89, 1.1, 22.8, 0.3, [g(2.6, 'fibre')]),
  },
  {
    name: 'Apple',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '180',
    servingUnit: 'g',
    servingLabel: '1 apple',
    nutrients: macros(52, 0.3, 14, 0.2, [g(2.4, 'fibre')]),
  },

  /* --- vegetables and prepared dishes ---------------------------------- */
  {
    name: 'Mixed vegetable sabzi',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '150',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    /* A prepared dish, estimated. §4.3's recipe decomposition is out of scope
     * and this is the honest approximation — see docs/nutrition.md. */
    nutrients: macros(95, 2.5, 10, 5, [g(3, 'fibre')]),
  },
  {
    name: 'Palak paneer',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: '200',
    servingUnit: 'g',
    servingLabel: '1 bowl',
    nutrients: macros(140, 7, 6, 10, [mg(180, 'calcium'), mg(2, 'iron')]),
  },
  {
    name: 'Spinach, cooked',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    nutrients: macros(23, 2.9, 3.6, 0.4, [g(2.2, 'fibre'), mg(99, 'calcium'), mg(2.7, 'iron')]),
  },
  {
    name: 'Potato, boiled',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'g',
    servingQuantity: null,
    servingUnit: null,
    servingLabel: null,
    nutrients: macros(87, 1.9, 20, 0.1, [g(1.8, 'fibre')]),
  },

  /* --- drinks ----------------------------------------------------------- */
  {
    name: 'Water',
    brand: null,
    isVegetarian: true,
    isVegan: true,
    proteinSource: null,
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '250',
    servingUnit: 'mL',
    servingLabel: '1 glass',
    nutrients: [{ key: 'water', amount: '100', unit: 'mL' }],
  },
  {
    name: 'Tea with milk',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '150',
    servingUnit: 'mL',
    servingLabel: '1 cup',
    nutrients: macros(43, 1.3, 5.5, 1.6, [{ key: 'water', amount: '90', unit: 'mL' }]),
  },
  {
    name: 'Coffee with milk',
    brand: null,
    isVegetarian: true,
    isVegan: false,
    proteinSource: 'dairy',
    basisQuantity: '100',
    basisUnit: 'mL',
    servingQuantity: '150',
    servingUnit: 'mL',
    servingLabel: '1 cup',
    nutrients: macros(35, 1.5, 3.5, 1.5, [{ key: 'water', amount: '92', unit: 'mL' }]),
  },
];

/** The note recorded on every seeded version, per the header. */
export const SEED_SOURCE_NOTE =
  'Seeded reference value — typical figures for the food as commonly prepared, hand-entered. Not from a redistributable database. Treat as an estimate, and replace with the pack label where one exists.';

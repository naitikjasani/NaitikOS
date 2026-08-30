/**
 * Nutrition contracts — §4.3.
 *
 * ## Nothing here accepts a computed nutrient total
 *
 * A meal is a list of `(foodVersionId, quantity, unit)`. The macros are derived
 * server-side from the versions the items point at, because those numbers go
 * into an append-only log and a client-computed total is a UI bug that becomes
 * a permanent record. Same rule the Health contracts follow for lab flags.
 *
 * ## A meal item names a **version**, not a food
 *
 * §9.2: "historical meals keep pointing at the version that was true when
 * eaten". Accepting a `foodId` here would push the resolution to the server's
 * clock, which is wrong for a back-dated meal — the version has to be resolved
 * against the meal's own `eatenAt`, and the client already did that when it
 * built the list.
 *
 * ## The parse endpoints are POSTs that read
 *
 * `/api/nutrition/parse` returns candidates and writes nothing. A GET with a
 * body is not a thing, and a page of pasted label text does not belong in a
 * query string — or in an access log.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema, zoneSchema } from './timeline';
import { offlineEnvelopeSchema } from './observations';

/** A decimal string. §5.3 keeps floats off the path a measured quantity travels. */
const decimalSchema = z.string().regex(/^\d+(\.\d+)?$/u, 'A decimal number.');

/**
 * §4.3's capture tiers, and the reason the ten-second rule is checkable.
 *
 * The client is the only thing that knows which path a meal took — the server
 * sees the same insert either way. Trusting a client-declared tier is fine
 * here: it is instrumentation about the *interface*, not a fact about the
 * operator's body, and nothing downstream is derived from it.
 */
export const mealCaptureTierSchema = z.enum(['template', 'suggestion', 'parsed', 'manual']);

export const proteinSourceSchema = z.enum(['dairy', 'egg', 'legume', 'supplement', 'grain_other']);

/* =========================================================================
 * Meals
 * ====================================================================== */

export const mealItemRequestSchema = z.object({
  id: uuidSchema,
  foodVersionId: uuidSchema,
  quantity: decimalSchema,
  /** A registered unit code, or one of the nutrition pseudo-units. */
  unit: z.string().min(1).max(20),
  /** The fragment a parse produced this from, kept verbatim for audit (§9.2). */
  parsedFromText: z.string().max(200).nullish(),
});

export const logMealRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  eatenAt: instantSchema,
  zone: zoneSchema,
  /** Free text. A person who eats five times a day has five slots, not four. */
  slot: z.string().max(40).nullish(),
  note: z.string().max(1000).nullish(),
  templateId: uuidSchema.nullish(),
  captureTier: mealCaptureTierSchema.nullish(),
  /**
   * Capped at thirty. A meal with more items than that is a day, and the cap is
   * what stops one malformed request writing three hundred observations.
   */
  items: z.array(mealItemRequestSchema).min(1).max(30),
});

export const deleteMealRequestSchema = z.object({ id: uuidSchema });

/* =========================================================================
 * Foods
 * ====================================================================== */

export const foodNutrientRequestSchema = z.object({
  /** A catalogue slug — `protein`, `vitamin_d`. Unknown keys are stored, not trended. */
  key: z.string().min(1).max(60),
  amount: decimalSchema,
  unit: z.string().max(20),
});

export const foodVersionRequestSchema = z.object({
  id: uuidSchema,
  basisQuantity: decimalSchema,
  basisUnit: z.string().min(1).max(20),
  /** What one serving of this food is. Required for pseudo-units to resolve. */
  servingQuantity: decimalSchema.nullish(),
  servingUnit: z.string().max(20).nullish(),
  servingLabel: z.string().max(60).nullish(),
  effectiveFrom: instantSchema,
  /** Where the numbers came from. §9.9's provenance argument, for a label. */
  sourceNote: z.string().max(500).nullish(),
  nutrients: z.array(foodNutrientRequestSchema).max(40),
});

export const createFoodRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(160),
  brand: z.string().max(120).nullish(),
  isVegetarian: z.boolean().nullish(),
  isVegan: z.boolean().nullish(),
  proteinSource: proteinSourceSchema.nullish(),
  version: foodVersionRequestSchema,
});

export const addFoodVersionRequestSchema = foodVersionRequestSchema.extend({ foodId: uuidSchema });

/* =========================================================================
 * Templates and targets
 * ====================================================================== */

export const saveTemplateRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  slot: z.string().max(40).nullish(),
  items: z
    .array(z.object({ foodId: uuidSchema, quantity: decimalSchema, unit: z.string().min(1).max(20) }))
    .min(1)
    .max(30),
});

export const setTargetRequestSchema = z.object({
  id: uuidSchema,
  /** `bulk`, `cut`, `maintenance` — free text, and it stays free. */
  phase: z.string().max(40).nullish(),
  effectiveFrom: instantSchema,
  metricKey: z.string().min(1).max(120),
  targetValue: decimalSchema,
  unit: z.string().max(20),
  /**
   * A band, or nothing. There is deliberately no default — an invented ±10%
   * reading "within" is a claim the operator never made (P5).
   */
  toleranceLow: decimalSchema.nullish(),
  toleranceHigh: decimalSchema.nullish(),
});

/* =========================================================================
 * The write union, and the parse read
 * ====================================================================== */

export const nutritionWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('meal'), meal: logMealRequestSchema }),
  z.object({ kind: z.literal('meal_delete'), meal: deleteMealRequestSchema }),
  z.object({ kind: z.literal('food'), food: createFoodRequestSchema }),
  z.object({ kind: z.literal('food_version'), version: addFoodVersionRequestSchema }),
  z.object({ kind: z.literal('template'), template: saveTemplateRequestSchema }),
  z.object({ kind: z.literal('target'), target: setTargetRequestSchema }),
]);

/** Roughly a page. A nutrition panel is twenty lines; this is generous. */
export const MAX_PARSE_CHARACTERS = 20_000;

export const parseRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('label'), text: z.string().min(1).max(MAX_PARSE_CHARACTERS) }),
  z.object({ kind: z.literal('meal'), text: z.string().min(1).max(2000) }),
]);

export type NutritionWriteRequest = z.infer<typeof nutritionWriteSchema>;
export type LogMealRequest = z.infer<typeof logMealRequestSchema>;
export type ParseRequest = z.infer<typeof parseRequestSchema>;

'use client';

/**
 * The Nutrition feature's client service (§7.3).
 *
 * ## The meal write queues; everything else does not
 *
 * A meal is a capture. It happens at a table, on a phone, sometimes without
 * signal, and §5.7's outbox is what makes that work — this is the P1 path the
 * ten-second rule is measured on, and it must not wait on a network.
 *
 * A food, a version, a template and a target change the *shape* of the record.
 * The outbox replays in queue order rather than causal order, so a food created
 * behind three meals that reference it would be applied after them — and the
 * meals would have failed on a foreign key. Same reasoning
 * `registerClient.ts` records for routine definitions.
 *
 * ## The parse endpoints are reads
 *
 * They return candidates and write nothing, so they go straight to the network
 * and are allowed to fail — the fallback is typing, which is where the operator
 * already was.
 */

import type {
  Food,
  FoodVersion,
  MealTemplate,
  MealTier,
  NutritionTarget,
  ParsedLabel,
  ParsedMeal,
  ProteinSource,
} from '@naitikos/core';

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------
 * The capture — this queues
 * ---------------------------------------------------------------------- */

export type MealItemDraft = {
  readonly id: string;
  readonly foodVersionId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly parsedFromText: string | null;
};

export type MealDraft = {
  readonly id: string;
  readonly eatenAt: string;
  readonly zone: string;
  readonly slot: string | null;
  readonly note: string | null;
  readonly templateId: string | null;
  /** How this meal was captured. §2.2's ship gate cannot be checked without it. */
  readonly captureTier: MealTier;
  readonly items: readonly MealItemDraft[];
};

export async function logMeal(draft: MealDraft): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/nutrition',
    method: 'POST',
    body: { kind: 'meal', meal: { ...draft, ...offlineEnvelope() } },
    label: draft.slot === null ? 'Meal' : `Meal · ${draft.slot}`,
  });
}

export async function deleteMeal(id: string): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/nutrition',
    method: 'POST',
    body: { kind: 'meal_delete', meal: { id } },
    label: 'Meal removed',
  });
}

/* -------------------------------------------------------------------------
 * Register changes — these do not
 * ---------------------------------------------------------------------- */

export type FoodDraft = {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly isVegetarian: boolean | null;
  readonly isVegan: boolean | null;
  readonly proteinSource: ProteinSource | null;
  readonly version: {
    readonly id: string;
    readonly basisQuantity: string;
    readonly basisUnit: string;
    readonly servingQuantity: string | null;
    readonly servingUnit: string | null;
    readonly servingLabel: string | null;
    readonly effectiveFrom: string;
    readonly sourceNote: string | null;
    readonly nutrients: readonly { readonly key: string; readonly amount: string; readonly unit: string }[];
  };
};

export async function createFood(draft: FoodDraft): Promise<{ readonly food: Food }> {
  return post('/api/nutrition', { kind: 'food', food: draft });
}

export async function addFoodVersion(
  draft: FoodDraft['version'] & { readonly foodId: string },
): Promise<{ readonly version: FoodVersion }> {
  return post('/api/nutrition', { kind: 'food_version', version: draft });
}

export async function saveTemplate(draft: {
  readonly id: string;
  readonly name: string;
  readonly slot: string | null;
  readonly items: readonly { readonly foodId: string; readonly quantity: string; readonly unit: string }[];
}): Promise<{ readonly template: MealTemplate }> {
  return post('/api/nutrition', { kind: 'template', template: draft });
}

export async function setTarget(draft: {
  readonly id: string;
  readonly phase: string | null;
  readonly effectiveFrom: string;
  readonly metricKey: string;
  readonly targetValue: string;
  readonly unit: string;
  readonly toleranceLow: string | null;
  readonly toleranceHigh: string | null;
}): Promise<{ readonly target: NutritionTarget }> {
  return post('/api/nutrition', { kind: 'target', target: draft });
}

/* -------------------------------------------------------------------------
 * Parsing — reads
 * ---------------------------------------------------------------------- */

export async function parseLabelText(text: string): Promise<ParsedLabel> {
  return post('/api/nutrition/parse', { kind: 'label', text });
}

export async function parseMealLine(text: string): Promise<ParsedMeal> {
  return post('/api/nutrition/parse', { kind: 'meal', text });
}

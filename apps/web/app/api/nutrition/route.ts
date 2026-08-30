/**
 * `/api/nutrition` — every Nutrition write.
 *
 * ## Two permissions
 *
 * A meal is an observation — `observation:write`. A food, a food version, a
 * template and a target change the *shape* of what gets recorded: a food's
 * label determines every future meal's macros, and a target changes what every
 * day is measured against. Those take `settings:write`, the same split
 * `/api/health` makes.
 *
 * ## The meal write is the P1 hot path
 *
 * It queues through the outbox on the client, so this handler is also the
 * replay target. `logMeal` is idempotent on the meal's client-minted id, and
 * the interesting part of that is the *counters*: `ON CONFLICT` protects the
 * rows, and only an explicit replay check protects `food.timesEaten` from being
 * incremented twice.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { nutritionWriteSchema } from '@naitikos/api';
import { isoFromMillis, systemClock } from '@naitikos/core';
import {
  createFoodRepository,
  createMealRepository,
  createMetricRepository,
  createNutritionTargetRepository,
} from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { nutritionWriteContext } from '@/lib/platform/nutrition';

export const dynamic = 'force-dynamic';

/** The kinds that change the shape of the record rather than adding to it. */
const REGISTER_KINDS = new Set(['food', 'food_version', 'template', 'target']);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.clone().json().catch(() => null);
  const kind = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['kind'] : null;
  const permission = REGISTER_KINDS.has(String(kind)) ? 'settings:write' : 'observation:write';

  const guarded = await guard(request, permission);
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, nutritionWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'meal': {
        const input = parsed.data.meal;
        const registry = await createMetricRepository(platform.db).registry();
        if (!registry.ok) return errorResponse(registry.error, traceId);

        const logged = await createMealRepository(platform.db).logMeal(
          {
            id: input.id,
            eatenAt: input.eatenAt,
            zone: input.zone,
            slot: input.slot ?? null,
            note: input.note ?? null,
            templateId: input.templateId ?? null,
            captureTier: input.captureTier ?? null,
            items: input.items.map((item) => ({
              id: item.id,
              foodVersionId: item.foodVersionId,
              quantity: item.quantity,
              unit: item.unit,
              parsedFromText: item.parsedFromText ?? null,
            })),
          },
          nutritionWriteContext(registry.value, {
            deviceId: input.deviceId,
            ...(input.clientHlc === undefined ? {} : { clientHlc: input.clientHlc }),
          }),
        );
        if (!logged.ok) return errorResponse(logged.error, traceId);
        return NextResponse.json(logged.value, { status: 201 });
      }

      case 'meal_delete': {
        const removed = await createMealRepository(platform.db).deleteMeal(parsed.data.meal.id, nowIso);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: removed.value });
      }

      case 'food': {
        const input = parsed.data.food;
        const created = await createFoodRepository(platform.db).create({
          id: input.id,
          name: input.name,
          brand: input.brand ?? null,
          isVegetarian: input.isVegetarian ?? null,
          isVegan: input.isVegan ?? null,
          proteinSource: input.proteinSource ?? null,
          version: {
            id: input.version.id,
            basisQuantity: input.version.basisQuantity,
            basisUnit: input.version.basisUnit,
            servingQuantity: input.version.servingQuantity ?? null,
            servingUnit: input.version.servingUnit ?? null,
            servingLabel: input.version.servingLabel ?? null,
            effectiveFrom: input.version.effectiveFrom,
            sourceNote: input.version.sourceNote ?? null,
            nutrients: input.version.nutrients,
          },
        });
        if (!created.ok) return errorResponse(created.error, traceId);
        return NextResponse.json({ food: created.value }, { status: 201 });
      }

      case 'food_version': {
        const input = parsed.data.version;
        const added = await createFoodRepository(platform.db).addVersion({
          foodId: input.foodId,
          id: input.id,
          basisQuantity: input.basisQuantity,
          basisUnit: input.basisUnit,
          servingQuantity: input.servingQuantity ?? null,
          servingUnit: input.servingUnit ?? null,
          servingLabel: input.servingLabel ?? null,
          effectiveFrom: input.effectiveFrom,
          sourceNote: input.sourceNote ?? null,
          nutrients: input.nutrients,
        });
        if (!added.ok) return errorResponse(added.error, traceId);
        return NextResponse.json({ version: added.value }, { status: 201 });
      }

      case 'template': {
        const input = parsed.data.template;
        const saved = await createMealRepository(platform.db).saveTemplate({
          id: input.id,
          name: input.name,
          slot: input.slot ?? null,
          items: input.items,
          lastUsedAt: null,
          timesUsed: 0,
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ template: saved.value }, { status: 201 });
      }

      default: {
        const input = parsed.data.target;
        const saved = await createNutritionTargetRepository(platform.db).setTarget({
          id: input.id,
          phase: input.phase ?? null,
          effectiveFrom: input.effectiveFrom,
          metricKey: input.metricKey,
          targetValue: input.targetValue,
          unit: input.unit,
          toleranceLow: input.toleranceLow ?? null,
          toleranceHigh: input.toleranceHigh ?? null,
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ target: saved.value }, { status: 201 });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in nutrition.post', {
      traceId,
      component: 'nutrition.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

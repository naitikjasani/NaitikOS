/**
 * The Nutrition service — §4.3's orchestration, and the ten-second surface's
 * data.
 *
 * ## The log screen is one round trip
 *
 * `loadLogSurface` fetches today's meals, the suggestion ranking, the templates
 * and the active targets in one `Promise.all`, for the reason `health.ts` gives:
 * "five round trips on a page load is five chances to be slow". Here it is
 * sharper than usual — this page *is* the ten-second budget, and a waterfall on
 * it is the difference between the module working and failing its ship gate.
 *
 * ## The ranking is `core`'s; the counters are the database's
 *
 * `suggestFoods` decays frequency by recency and knows nothing about SQL.
 * `food.repository.usage()` reads the denormalised counters `food_recent_idx`
 * and `food_frequent_idx` were built for. Neither half computes an aggregate
 * over `meal_item`, which is the thing the whole tier-1 design exists to avoid.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  Decimal,
  DomainError,
  Food,
  FoodNutrient,
  FoodVersion,
  Hlc,
  MealTemplate,
  MetricRegistry,
  NutritionTarget,
  ParsedLabel,
  ParsedMeal,
  Suggestion,
  TargetEvaluation,
} from '@naitikos/core';
import {
  DECIMAL_ZERO,
  addDecimal,
  currentFoodVersion,
  dailyRollup,
  dayKeyInZone,
  evaluateTargets,
  activeTargets,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  nutritionMetricKey,
  parseDecimal,
  parseInstant,
  parseMealText,
  parseNutritionLabel,
  phaseFor,
  rankTemplates,
  resolveTemplate,
  slotForLocalTime,
  suggestFoods,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database, MealRow } from '@naitikos/db';
import {
  createFoodRepository,
  createMealRepository,
  createMetricRepository,
  createNutritionTargetRepository,
  createObservationRepository,
} from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

/** How far back the trends screen reads. */
export const NUTRITION_TREND_DAYS = 90;

/** Which metrics the log surface shows against target, in order. */
export const HEADLINE_METRICS: readonly string[] = Object.freeze([
  nutritionMetricKey('protein'),
  nutritionMetricKey('energy'),
  nutritionMetricKey('carbohydrate'),
  nutritionMetricKey('fat'),
]);

export type SuggestionView = Suggestion & { readonly food: Food; readonly versionId: string | null };

export type TemplateView = {
  readonly template: MealTemplate;
  readonly resolvable: boolean;
};

export type LogSurface = {
  readonly todayDayKey: string;
  readonly nowIso: string;
  readonly slot: string;
  readonly meals: readonly MealRow[];
  readonly suggestions: readonly SuggestionView[];
  readonly templates: readonly TemplateView[];
  readonly evaluations: readonly TargetEvaluation[];
  readonly phase: string | null;
  readonly libraryIsEmpty: boolean;
};

export async function loadLogSurface(db: Database, zone: string): Promise<Result<LogSurface, DomainError>> {
  const foods = createFoodRepository(db);
  const meals = createMealRepository(db);
  const targets = createNutritionTargetRepository(db);

  const nowMillis = systemClock.nowMillis();
  const nowIso = isoFromMillis(nowMillis);
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const bounds = zonedDayBounds(todayDayKey, zone);

  const [library, usage, templates, targetHistory, today] = await Promise.all([
    foods.all(),
    foods.usage(),
    meals.templates(),
    targets.history(),
    meals.mealsBetween(bounds?.start ?? nowIso, bounds?.end ?? nowIso),
  ]);

  if (!library.ok) return library;
  if (!usage.ok) return usage;
  if (!templates.ok) return templates;
  if (!targetHistory.ok) return targetHistory;
  if (!today.ok) return today;

  const versions = await foods.versionsFor(library.value.map((entry) => entry.id));
  if (!versions.ok) return versions;

  const byFood = groupVersions(versions.value);
  const slot = slotForLocalTime(localTime(nowIso, zone));

  const ranked = suggestFoods([...usage.value], { nowIso, slot });
  const foodById = new Map(library.value.map((entry) => [entry.id, entry]));

  const suggestions: SuggestionView[] = ranked.flatMap((entry) => {
    const food = foodById.get(entry.foodId);
    if (food === undefined) return [];
    return [{ ...entry, food, versionId: currentFoodVersion(byFood.get(entry.foodId) ?? [], nowIso)?.id ?? null }];
  });

  const rankedTemplateIds = rankTemplates(
    templates.value.map((template) => ({
      templateId: template.id,
      slot: template.slot,
      timesUsed: template.timesUsed,
      lastUsedAt: template.lastUsedAt,
    })),
    slot,
    nowIso,
  );

  const templateViews: TemplateView[] = rankedTemplateIds.flatMap((id) => {
    const template = templates.value.find((entry) => entry.id === id);
    if (template === undefined) return [];
    const resolved = resolveTemplate(template, byFood, nowIso);
    return [{ template, resolvable: resolved.missing.length === 0 && resolved.items.length > 0 }];
  });

  const totals = await dayTotals(db, todayDayKey, zone);
  if (!totals.ok) return totals;

  return ok({
    todayDayKey,
    nowIso,
    slot,
    meals: today.value,
    suggestions,
    templates: templateViews,
    evaluations: evaluateTargets(totals.value, activeTargets(targetHistory.value, nowIso)),
    phase: phaseFor(targetHistory.value, nowIso),
    libraryIsEmpty: library.value.length === 0,
  });
}

/* -------------------------------------------------------------------------
 * The overview and the trends
 * ---------------------------------------------------------------------- */

export type NutritionOverview = {
  readonly todayDayKey: string;
  readonly evaluations: readonly TargetEvaluation[];
  readonly phase: string | null;
  readonly mealsToday: number;
  readonly proteinBySource: readonly { readonly metricKey: string; readonly grams: number }[];
  readonly waterMl: number;
};

export async function loadNutritionOverview(db: Database, zone: string): Promise<Result<NutritionOverview, DomainError>> {
  const nowMillis = systemClock.nowMillis();
  const nowIso = isoFromMillis(nowMillis);
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const bounds = zonedDayBounds(todayDayKey, zone);

  const [targetHistory, today, totals] = await Promise.all([
    createNutritionTargetRepository(db).history(),
    createMealRepository(db).mealsBetween(bounds?.start ?? nowIso, bounds?.end ?? nowIso),
    dayTotals(db, todayDayKey, zone),
  ]);

  if (!targetHistory.ok) return targetHistory;
  if (!today.ok) return today;
  if (!totals.ok) return totals;

  const bySource = [...totals.value.entries()]
    .filter(([key]) => key.startsWith('nutrition.protein.from_'))
    .map(([metricKey, amount]) => ({ metricKey, grams: toNumber(amount) }));

  return ok({
    todayDayKey,
    evaluations: evaluateTargets(totals.value, activeTargets(targetHistory.value, nowIso)),
    phase: phaseFor(targetHistory.value, nowIso),
    mealsToday: today.value.length,
    proteinBySource: bySource,
    waterMl: toNumber(totals.value.get(nutritionMetricKey('water')) ?? DECIMAL_ZERO),
  });
}

export type TrendSeries = {
  readonly metricKey: string;
  readonly points: readonly { readonly dayKey: string; readonly value: number }[];
  readonly target: number | null;
  readonly unit: string;
};

export async function loadNutritionTrends(
  db: Database,
  zone: string,
): Promise<Result<{ readonly series: readonly TrendSeries[]; readonly phase: string | null }, DomainError>> {
  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const nowMillis = systemClock.nowMillis();
  const nowIso = isoFromMillis(nowMillis);

  const observations = await createObservationRepository(db).query({
    metricKeys: [...HEADLINE_METRICS],
    from: isoFromMillis(nowMillis - NUTRITION_TREND_DAYS * 86_400_000),
    until: isoFromMillis(nowMillis + 86_400_000),
    currentOnly: true,
  });
  if (!observations.ok) return observations;

  const targetHistory = await createNutritionTargetRepository(db).history();
  if (!targetHistory.ok) return targetHistory;
  const active = activeTargets(targetHistory.value, nowIso);

  const series: TrendSeries[] = [];
  for (const metricKey of HEADLINE_METRICS) {
    const definition = registry.value.get(metricKey);
    if (definition === null) continue;

    const rows = observations.value.filter((observation) => observation.metricKey === metricKey);
    const target = active.find((entry) => entry.metricKey === metricKey);

    series.push({
      metricKey,
      /* `dailyRollup` with the metric's own `sum` aggregation. The seven-day
       * average the chart draws is computed on top of these daily sums, exactly
       * as §4.6 does for bodyweight — the registry's aggregation is the
       * within-day rule and nothing more. */
      points: dailyRollup(rows, definition, { zone }).map((point) => ({ dayKey: point.dayKey, value: point.value })),
      target: target === undefined ? null : Number(target.targetValue),
      unit: definition.canonicalUnit,
    });
  }

  return ok({ series, phase: phaseFor(targetHistory.value, nowIso) });
}

/* -------------------------------------------------------------------------
 * The library
 * ---------------------------------------------------------------------- */

export type FoodDetail = {
  readonly food: Food;
  readonly versions: readonly FoodVersion[];
  readonly nutrients: readonly FoodNutrient[];
};

export async function loadFoodLibrary(db: Database): Promise<Result<readonly Food[], DomainError>> {
  return createFoodRepository(db).all();
}

export async function loadFoodDetail(db: Database, id: string): Promise<Result<FoodDetail | null, DomainError>> {
  const foods = createFoodRepository(db);

  const found = await foods.byId(id);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);

  const versions = await foods.versionsFor([id]);
  if (!versions.ok) return versions;

  const nutrients = await foods.nutrientsFor(versions.value.map((entry) => entry.id));
  if (!nutrients.ok) return nutrients;

  return ok({ food: found.value, versions: versions.value, nutrients: nutrients.value });
}

export async function loadTemplates(db: Database): Promise<Result<readonly MealTemplate[], DomainError>> {
  return createMealRepository(db).templates();
}

export async function loadTargets(db: Database): Promise<Result<readonly NutritionTarget[], DomainError>> {
  return createNutritionTargetRepository(db).history();
}

/* -------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------- */

export async function parseLabel(text: string): Promise<ParsedLabel> {
  return parseNutritionLabel(text);
}

export async function parseMeal(db: Database, text: string): Promise<Result<ParsedMeal, DomainError>> {
  const foods = createFoodRepository(db);
  const [library, usage] = await Promise.all([foods.all(), foods.usage()]);
  if (!library.ok) return library;
  if (!usage.ok) return usage;
  return ok(parseMealText(text, library.value, usage.value));
}

/* -------------------------------------------------------------------------
 * Shared
 * ---------------------------------------------------------------------- */

export function nutritionWriteContext(registry: MetricRegistry, envelope: OfflineEnvelope) {
  const physicalMillis = systemClock.nowMillis();
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  const state =
    envelope.clientHlc === undefined ? seed : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis).state;

  return {
    registry,
    hlcState: state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId: () => crypto.randomUUID(),
  };
}

/**
 * A day's totals per nutrition metric.
 *
 * Read from the observation log rather than recomputed from `meal_item`. The
 * log is the system of record (§9.1) and the totals were written there when the
 * meal was; recomputing would be a second implementation of `mealTotals` that
 * could disagree with the first.
 */
async function dayTotals(
  db: Database,
  dayKey: string,
  zone: string,
): Promise<Result<ReadonlyMap<string, Decimal>, DomainError>> {
  const bounds = zonedDayBounds(dayKey, zone);
  if (bounds === null) return ok(new Map());

  const rows = await createObservationRepository(db).query({
    from: bounds.start,
    until: bounds.end,
    currentOnly: true,
  });
  if (!rows.ok) return rows;

  const totals = new Map<string, Decimal>();
  for (const observation of rows.value) {
    if (!observation.metricKey.startsWith('nutrition.')) continue;
    const value = parseDecimal(observation.value);
    if (value === null) continue;
    totals.set(observation.metricKey, addDecimal(totals.get(observation.metricKey) ?? DECIMAL_ZERO, value));
  }

  return ok(totals);
}

function groupVersions(versions: readonly FoodVersion[]): ReadonlyMap<string, readonly FoodVersion[]> {
  const byFood = new Map<string, FoodVersion[]>();
  for (const version of versions) {
    const bucket = byFood.get(version.foodId) ?? [];
    bucket.push(version);
    byFood.set(version.foodId, bucket);
  }
  return byFood;
}

function toNumber(value: Decimal): number {
  return Number(value.unscaled) / 10 ** value.scale;
}

/** `HH:MM` in the operator's zone, for the slot heuristic. */
function localTime(nowIso: string, zone: string): string {
  const dayKey = dayKeyInZone(nowIso, zone);
  const bounds = zonedDayBounds(dayKey, zone);
  if (bounds === null) return '12:00';

  /* §11.3's sanctioned parse point, not a bare `Date.parse`. */
  const start = parseInstant(bounds.start);
  const now = parseInstant(nowIso);
  if (start === null || now === null) return '12:00';

  const minutes = Math.floor((now.getTime() - start.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export type { MealRow };

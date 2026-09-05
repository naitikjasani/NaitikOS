/**
 * The Library service — §3.2's `/library` block, assembled.
 *
 * ## Nothing here is a new domain
 *
 * Every registry this file reads already existed and is already written to by
 * the module that owns it: exercises by Gym, foods by Nutrition, products and
 * protocols by Skin and the routine engine, metrics by the seed. §9.2 calls the
 * `metric` table "the most important table in the system" and the same sentence
 * explains what this pillar is for — the vocabulary the record is written in
 * had no place to be *looked at*. This is that place, and it is a read surface
 * over data that is authored elsewhere.
 *
 * That is why there is no write path in this file and no `/api/library`. §2.1's
 * "no manual database intervention" is already satisfied by the register
 * editors each owning module ships; a second editor here would be a second way
 * to write the same row, which is the duplication §9.3(4) exists to prevent.
 *
 * ## What could not be reached
 *
 * The tag vocabulary. `tag` and `entity_tag` are declared in
 * `packages/db/src/schema/substrate.ts` and no repository reads them — there is
 * no `TagRepository`, and `apps/web` has no Drizzle dependency and no precedent
 * for issuing its own SQL. {@link loadTagVocabulary} therefore returns an
 * unreachable board rather than a fabricated one, and the screen says so.
 * Recorded in `docs/library.md`.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Exercise,
  Food,
  MetricDefinition,
  MetricDomain,
  Routine,
  RoutineStep,
  SkincareProduct,
} from '@naitikos/core';
import {
  METRIC_DOMAINS,
  dayKeyInZone,
  isoFromMillis,
  productLabel,
  shiftDayKey,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createExerciseRepository,
  createFoodRepository,
  createMetricRepository,
  createRoutineRepository,
  createSkinRepository,
  createWorkoutRepository,
} from '@naitikos/db';

/**
 * How far back "recently used" reaches on the exercise page.
 *
 * A quarter. The exercise registry has no usage counter of its own — nothing
 * increments a column the way `food.times_eaten` is incremented — so the number
 * has to come from a scan of `workout_set`. Bounded to ninety days it is one
 * indexed range scan whose cost is flat over twenty years; an all-time count
 * would grow without limit for a figure nobody reads as a lifetime total
 * anyway.
 */
export const EXERCISE_USAGE_DAYS = 90;

/* =========================================================================
 * The overview
 * ====================================================================== */

/**
 * How large each registry is.
 *
 * `null` means unreachable, not zero. An empty tag vocabulary and a tag
 * vocabulary nobody can read are different facts, and §10.9's "insufficient
 * data" rather than a guess applies to a count as much as to a trend.
 */
export type LibraryCounts = {
  readonly exercises: number;
  readonly foods: number;
  readonly products: number;
  readonly protocols: number;
  readonly metrics: number;
  readonly tags: number | null;
};

export type LibraryOverviewBoard = {
  readonly counts: LibraryCounts;
};

export async function loadLibraryOverview(db: Database): Promise<Result<LibraryOverviewBoard, DomainError>> {
  const [exerciseCount, foods, products, protocols, registry] = await Promise.all([
    createExerciseRepository(db).count(),
    createFoodRepository(db).all(),
    createSkinRepository(db).products(),
    createRoutineRepository(db).activeRoutines(),
    createMetricRepository(db).registry(),
  ]);

  if (!foods.ok) return foods;
  if (!products.ok) return products;
  if (!protocols.ok) return protocols;
  if (!registry.ok) return registry;

  return ok({
    counts: {
      exercises: exerciseCount,
      foods: foods.value.length,
      products: products.value.length,
      protocols: protocols.value.length,
      metrics: registry.value.all().length,
      // See the file header. No reader exists for `tag`.
      tags: null,
    },
  });
}

/* =========================================================================
 * Exercises
 * ====================================================================== */

export type ExerciseLibraryBoard = {
  readonly exercises: readonly Exercise[];
  /**
   * Sets logged per exercise id over the last {@link EXERCISE_USAGE_DAYS}.
   *
   * A record rather than a `Map` because this board crosses the server/client
   * boundary and a plain object is the shape every serialiser agrees on.
   */
  readonly recentSets: Readonly<Record<string, number>>;
  readonly usageDays: number;
  /** False when the window could not be resolved; the counts are then absent. */
  readonly usageResolved: boolean;
};

export async function loadExerciseLibrary(
  db: Database,
  zone: string,
): Promise<Result<ExerciseLibraryBoard, DomainError>> {
  const exercises = await createExerciseRepository(db).all();
  if (!exercises.ok) return exercises;

  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const fromDayKey = shiftDayKey(todayDayKey, -(EXERCISE_USAGE_DAYS - 1)) ?? todayDayKey;
  const start = zonedDayBounds(fromDayKey, zone);
  const end = zonedDayBounds(todayDayKey, zone);

  /*
   * An unresolvable window degrades to "no usage figures", not to an error.
   *
   * The catalogue is the point of this page and it is already loaded. Failing
   * the whole read because a decoration could not be computed would take the
   * reference data away over a number that is annotation.
   */
  if (start === null || end === null) {
    return ok({ exercises: exercises.value, recentSets: {}, usageDays: EXERCISE_USAGE_DAYS, usageResolved: false });
  }

  const sets = await createWorkoutRepository(db).setsBetween(start.start, end.end);
  if (!sets.ok) return sets;

  const recentSets: Record<string, number> = {};
  for (const set of sets.value) {
    recentSets[set.exerciseId] = (recentSets[set.exerciseId] ?? 0) + 1;
  }

  return ok({
    exercises: exercises.value,
    recentSets,
    usageDays: EXERCISE_USAGE_DAYS,
    usageResolved: true,
  });
}

/* =========================================================================
 * Foods
 * ====================================================================== */

export type FoodEntry = {
  readonly food: Food;
  /**
   * The basis the current version's nutrition is stated per — `100 g`.
   *
   * The identifying fact about a food entry after its name: two rows called
   * "Greek yoghurt" stated per 100 g and per pot are not the same registry
   * entry. `null` when the food has no version yet.
   */
  readonly basis: string | null;
  readonly versionCount: number;
};

export type FoodLibraryBoard = {
  readonly foods: readonly FoodEntry[];
};

export async function loadFoodLibrary(db: Database): Promise<Result<FoodLibraryBoard, DomainError>> {
  const repository = createFoodRepository(db);

  const foods = await repository.all();
  if (!foods.ok) return foods;

  const versions = await repository.versionsFor(foods.value.map((food) => food.id));
  if (!versions.ok) return versions;

  /*
   * `versionsFor` returns ascending by `effectiveFrom`, so the last one seen
   * for a food is the current one. Relying on the documented order rather than
   * re-sorting keeps one definition of "current version" in the repository
   * instead of two that can disagree.
   */
  const current = new Map<string, { basis: string; count: number }>();
  for (const version of versions.value) {
    const previous = current.get(version.foodId);
    current.set(version.foodId, {
      basis: `${version.basisQuantity} ${version.basisUnit}`,
      count: (previous?.count ?? 0) + 1,
    });
  }

  return ok({
    foods: foods.value.map((food) => {
      const entry = current.get(food.id);
      return {
        food,
        basis: entry?.basis ?? null,
        versionCount: entry?.count ?? 0,
      };
    }),
  });
}

/* =========================================================================
 * Products
 * ====================================================================== */

export type ProductEntry = {
  readonly product: SkincareProduct;
  /** When it first entered the routine, as an instant. `null` if never. */
  readonly introducedAt: string | null;
  readonly eventCount: number;
  /**
   * Recorded reactions. Counted, never attributed.
   *
   * §4.2's payoff question is "my chest acne worsened three weeks after
   * starting that moisturiser", and P5 forbids this system answering it. A
   * count is the fact; the causal claim is not made anywhere.
   */
  readonly reactionCount: number;
};

export type ProductLibraryBoard = {
  readonly products: readonly ProductEntry[];
};

export async function loadProductLibrary(db: Database): Promise<Result<ProductLibraryBoard, DomainError>> {
  const skin = createSkinRepository(db);

  const [products, events] = await Promise.all([skin.products(), skin.productEvents()]);
  if (!products.ok) return products;
  if (!events.ok) return events;

  return ok({
    products: products.value.map((product) => {
      const own = events.value.filter((event) => event.productId === product.id);
      const introductions = own
        .filter((event) => event.kind === 'introduced')
        .map((event) => event.occurredAt)
        .sort();

      return {
        product,
        introducedAt: introductions[0] ?? null,
        eventCount: own.length,
        reactionCount: own.filter((event) => event.kind === 'reaction').length,
      };
    }),
  });
}

/* =========================================================================
 * Protocols
 * ====================================================================== */

export type ProtocolEntry = {
  readonly routine: Routine;
  readonly steps: readonly RoutineStep[];
};

export type ProtocolLibraryBoard = {
  readonly protocols: readonly ProtocolEntry[];
  /** Registered product names by id, for steps that apply one. */
  readonly productNames: Readonly<Record<string, string>>;
};

/**
 * §3.2's "personal protocols & SOPs" is the routine engine, not a new table.
 *
 * §9.2: "a generic routine engine reused by skincare, dental hygiene, and
 * supplements. One implementation, three consumers." A protocol is an ordered
 * list of steps that is expected at a time of day and logged against — which is
 * `routine` exactly. Adding a second table for the same shape would produce the
 * three near-identical adherence systems §9.2 exists to refuse.
 *
 * **Gap:** `RoutineRepository.activeRoutines` filters on `is_active`, so a
 * retired protocol is unreachable from here and the screen says so.
 */
export async function loadProtocolLibrary(db: Database): Promise<Result<ProtocolLibraryBoard, DomainError>> {
  const routines = createRoutineRepository(db);

  const protocols = await routines.activeRoutines();
  if (!protocols.ok) return protocols;

  const [steps, products] = await Promise.all([
    routines.stepsFor(protocols.value.map((routine) => routine.id)),
    createSkinRepository(db).products(),
  ]);
  if (!steps.ok) return steps;
  if (!products.ok) return products;

  const productNames: Record<string, string> = {};
  for (const product of products.value) {
    // `productLabel` rather than a local join, so a step's product reads the
    // same here as it does on `/body/skin/products`.
    productNames[product.id] = productLabel(product);
  }

  return ok({
    protocols: protocols.value.map((routine) => ({
      routine,
      steps: steps.value.filter((step) => step.routineId === routine.id),
    })),
    productNames,
  });
}

/* =========================================================================
 * The metric registry
 * ====================================================================== */

export type MetricDomainGroup = {
  readonly domain: MetricDomain;
  readonly metrics: readonly MetricDefinition[];
};

export type MetricRegistryBoard = {
  readonly groups: readonly MetricDomainGroup[];
  readonly total: number;
  readonly inDailyClose: number;
};

/**
 * The registry, grouped by domain.
 *
 * Grouped here rather than in the screen because the grouping is the domain's,
 * not the layout's: §3.2's pillars are what `metric.domain` names, and a screen
 * that invented its own ordering would be a second opinion about which pillar a
 * metric belongs to.
 */
export async function loadMetricRegistry(db: Database): Promise<Result<MetricRegistryBoard, DomainError>> {
  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const all = registry.value.all();

  // `METRIC_DOMAINS` order, not alphabetical — `system` belongs last because it
  // is the one domain that measures the app rather than the person.
  const groups = METRIC_DOMAINS.map((domain) => ({
    domain,
    metrics: all.filter((definition) => definition.domain === domain),
  })).filter((group) => group.metrics.length > 0);

  return ok({
    groups,
    total: all.length,
    inDailyClose: registry.value.dailyClose().length,
  });
}

/* =========================================================================
 * The tag vocabulary
 * ====================================================================== */

export type TagEntry = {
  readonly slug: string;
  readonly label: string;
  readonly description: string | null;
  /** How many entities carry it, or `null` when it was not computed. */
  readonly appliedTo: number | null;
};

export type TagVocabularyBoard = {
  readonly tags: readonly TagEntry[];
  /**
   * Whether the vocabulary could be read at all.
   *
   * False today. The board still exists so the route, the screen and the
   * caveat have one shape, and so that landing a `TagRepository` later is a
   * change to this function rather than to the page and the screen as well.
   */
  readonly reachable: boolean;
};

/**
 * §9.2's controlled vocabulary, which nothing can currently read.
 *
 * `tag` and `entity_tag` exist in the schema and have no repository. This
 * function takes no database handle because there is nothing it could ask it —
 * writing raw SQL here instead would put a query outside the repository layer
 * §6.2 exists to keep it in, in the one place where the missing repository is
 * the finding rather than an inconvenience.
 */
export function loadTagVocabulary(): Result<TagVocabularyBoard, DomainError> {
  return ok({ tags: [], reachable: false });
}

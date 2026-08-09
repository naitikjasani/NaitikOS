/**
 * The exercise library, persisted.
 *
 * Reference data, not a record — the one part of Gym that is a *library*. It is
 * read on every session screen and written approximately never, which shapes
 * both halves of this file: the whole thing is cached in memory after first
 * read, and the write path exists only for the seed and for user-authored
 * additions.
 *
 * ## Two search paths, deliberately
 *
 * {@link ExerciseRepository.search} runs in Postgres against the trigram index
 * §9.6 asks for. `core`'s `searchExercises` runs the same *ranking* over an
 * already-loaded library, with no round trip.
 *
 * That is not duplication for its own sake. §4.1's design note governs the
 * logger — "under fatigue, mid-session, an exact-match search box is a P1
 * violation" — and a gym basement has no signal, so the picker must rank
 * locally or not work at all. The database path serves the library screen,
 * where the full catalogue may eventually outgrow a client-side cache.
 */

import { and, asc, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Exercise, MuscleGroup } from '@naitikos/core';

import type { Executor } from '../client';
import { exercise } from '../schema/body';

/** Row → domain exercise. The jsonb columns are the only interesting part. */
function toExercise(row: typeof exercise.$inferSelect): Exercise {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    aliases: asStringArray(row.aliases),
    primaryMuscle: row.primaryMuscle,
    secondaryMuscles: asStringArray(row.secondaryMuscles) as readonly MuscleGroup[],
    mechanic: row.mechanic ?? null,
    equipment: row.equipment ?? null,
    isBodyweight: row.isBodyweight,
    isUnilateral: row.isUnilateral,
    instructions: row.instructions,
    formNotes: row.formNotes,
  };
}

/**
 * A `jsonb` column read defensively.
 *
 * The column has a default of `'[]'` and a hand-edited row, an older shape, or
 * a partially migrated import can still hold something else. A session screen
 * that throws because one exercise has a malformed alias list is a worse
 * outcome than one that treats it as having no aliases.
 */
function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export type ExerciseRepository = {
  /** The whole library, alphabetical. Cached after the first read. */
  all(): Promise<Result<readonly Exercise[], DomainError>>;
  byId(id: string): Promise<Result<Exercise | null, DomainError>>;
  bySlug(slug: string): Promise<Result<Exercise | null, DomainError>>;
  /** Several at once, for a session's worth of sets. Order is not preserved. */
  byIds(ids: readonly string[]): Promise<Result<ReadonlyMap<string, Exercise>, DomainError>>;
  /** Fuzzy search in Postgres, against the trigram index (§9.6). */
  search(term: string, limit?: number): Promise<Result<readonly Exercise[], DomainError>>;
  /** Insert or update by slug. The seed's entry point, and idempotent. */
  upsert(definitions: readonly ExerciseDefinition[]): Promise<Result<number, DomainError>>;
  count(): Promise<number>;
};

export type ExerciseDefinition = Omit<Exercise, 'id'> & { readonly id?: string };

export function createExerciseRepository(db: Executor): ExerciseRepository {
  /*
   * Cached, with in-flight coalescing — the same shape `metric.repository.ts`
   * uses and for the same reason. A page that renders four charts would
   * otherwise issue four identical library reads before any of them resolved.
   */
  let cached: readonly Exercise[] | null = null;
  let inFlight: Promise<readonly Exercise[]> | null = null;

  async function load(): Promise<readonly Exercise[]> {
    if (cached !== null) return cached;
    inFlight ??= (async () => {
      const rows = await db
        .select()
        .from(exercise)
        .where(isNull(exercise.deletedAt))
        .orderBy(asc(exercise.name));
      cached = rows.map(toExercise);
      inFlight = null;
      return cached;
    })();
    return inFlight;
  }

  return {
    async all() {
      return ok(await load());
    },

    async byId(id) {
      return ok((await load()).find((item) => item.id === id) ?? null);
    },

    async bySlug(slug) {
      return ok((await load()).find((item) => item.slug === slug) ?? null);
    },

    async byIds(ids) {
      const wanted = new Set(ids);
      const found = new Map<string, Exercise>();
      for (const item of await load()) {
        if (wanted.has(item.id)) found.set(item.id, item);
      }
      return ok(found);
    },

    async search(term, limit = 20) {
      const needle = term.trim();
      if (needle === '') return ok((await load()).slice(0, limit));

      /*
       * `%` is pg_trgm's similarity operator and it is what uses the GIN index;
       * `similarity()` alone would work but would scan. The `ILIKE` arm catches
       * substrings that fall below the trigram threshold — "row" inside
       * "Barbell Row" is only three characters, which is one trigram.
       *
       * Ordered by similarity so a typo still lands on the right movement,
       * which is the entire point of §9.6's "fuzzy exercise lookup".
       */
      const rows = await db
        .select()
        .from(exercise)
        .where(
          and(
            isNull(exercise.deletedAt),
            sql`(${exercise.name} % ${needle} OR ${exercise.name} ILIKE ${`%${needle}%`})`,
          ),
        )
        .orderBy(sql`similarity(${exercise.name}, ${needle}) DESC`, asc(exercise.name))
        .limit(limit);

      return ok(rows.map(toExercise));
    },

    async upsert(definitions) {
      if (definitions.length === 0) return ok(0);

      /*
       * Conflict target is the slug, not the id.
       *
       * The slug is derived from the name by `core`'s `exerciseSlug`, so it is
       * stable across re-seeds while a generated id is not. Upserting on the id
       * would mean a second seed run inserted the whole library again under new
       * ids — and every historical set would still point at the originals,
       * silently splitting each exercise's history in two.
       */
      const rows = await db
        .insert(exercise)
        .values(
          definitions.map((definition) => ({
            /*
             * `gen_random_uuid()` rather than a generated UUIDv7.
             *
             * §5.7 wants client-generated v7 ids for anything created *offline*,
             * so that a record has its identity from the moment it exists. A
             * seeded exercise is not created offline and has no moment before
             * this insert — and letting Postgres mint it keeps the whole upsert
             * one statement, which is what makes a re-seed atomic.
             */
            id: definition.id ?? sql`gen_random_uuid()`,
            name: definition.name,
            slug: definition.slug,
            aliases: [...definition.aliases],
            primaryMuscle: definition.primaryMuscle,
            secondaryMuscles: [...definition.secondaryMuscles],
            mechanic: definition.mechanic,
            equipment: definition.equipment,
            isBodyweight: definition.isBodyweight,
            isUnilateral: definition.isUnilateral,
            instructions: definition.instructions,
            formNotes: definition.formNotes,
          })),
        )
        .onConflictDoUpdate({
          target: exercise.slug,
          set: {
            name: sql`excluded.name`,
            aliases: sql`excluded.aliases`,
            primaryMuscle: sql`excluded.primary_muscle`,
            secondaryMuscles: sql`excluded.secondary_muscles`,
            mechanic: sql`excluded.mechanic`,
            equipment: sql`excluded.equipment`,
            isBodyweight: sql`excluded.is_bodyweight`,
            isUnilateral: sql`excluded.is_unilateral`,
            instructions: sql`excluded.instructions`,
            /*
             * `form_notes` is deliberately absent from this list.
             *
             * §4.1 calls it "user-authored cues that actually work for them" —
             * the one column on this table the operator writes. A re-seed that
             * overwrote it would silently destroy the only original content in
             * the library.
             */
            updatedAt: sql`now()`,
            version: sql`${exercise.version} + 1`,
          },
        })
        .returning({ id: exercise.id });

      // The library changed; the next read must go to the database.
      cached = null;
      inFlight = null;
      return ok(rows.length);
    },

    async count() {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(exercise)
        .where(isNull(exercise.deletedAt));
      return rows[0]?.total ?? 0;
    },
  };
}

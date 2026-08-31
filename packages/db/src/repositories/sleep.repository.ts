/**
 * Sleep, persisted — §4.6.
 *
 * ## The write is idempotent twice over, for two different reasons
 *
 * **On the id**, because §5.7 gives every record a client-minted UUIDv7 the
 * moment it exists, and a write that arrives twice through the offline outbox
 * is the same write rather than a correction.
 *
 * **On the day key**, because a second night for the same morning is a
 * duplicate rather than a nap. The schema says so with a partial unique index,
 * and the consequence of not honouring it is invisible: two rows for one
 * morning weight that morning twice in every consistency figure, and nothing
 * ever surfaces the discrepancy.
 *
 * The partial index is the interesting half. `ON CONFLICT (day_key)` alone does
 * not match `sleep_night_day_unique` — Postgres will not infer a *partial*
 * index without being handed its predicate too, and raises 42P10 instead. So
 * `targetWhere` repeats `deleted_at IS NULL`, exactly as the graph and calendar
 * repositories had to.
 *
 * ## Deleting frees the morning
 *
 * §9.4 soft-deletes everything, and because the unique index is partial on
 * `deleted_at IS NULL` a tombstoned night stops occupying its day key. That is
 * the correct behaviour and it is not obvious, so `sleep.repository.test.ts`
 * asserts it: recording a fresh night for a morning whose previous record was
 * deleted must succeed rather than collide with a row nobody can see.
 */

import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, SleepDisturbance, SleepNight, SleepNightInput } from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { sleepNight } from '../schema/sleep';

const ENTITY = 'sleep_night';

function toNight(row: typeof sleepNight.$inferSelect): SleepNight {
  return {
    id: row.id,
    dayKey: row.dayKey,
    zone: row.zone,
    bedAt: row.bedAt,
    wokeAt: row.wokeAt,
    durationHours: row.durationHours,
    quality: row.quality,
    latencyMinutes: row.latencyMinutes,
    wakings: row.wakings,
    disturbance: row.disturbance as SleepDisturbance | null,
    disturbanceNote: row.disturbanceNote,
    note: row.note,
  };
}

export type SleepRepository = {
  /** Nights in a day-key window, oldest first — the order every consistency figure wants. */
  nightsBetween(fromDayKey: string, toDayKey: string): Promise<Result<readonly SleepNight[], DomainError>>;
  nightForDay(dayKey: string): Promise<Result<SleepNight | null, DomainError>>;
  /** Idempotent on the id (§5.7), and an upsert on the morning (§4.6). */
  recordNight(input: SleepNightInput): Promise<Result<SleepNight, DomainError>>;
  /** Soft delete (§9.4). The day key becomes available again. */
  /*
   * The reason is nullable, matching the drop-a-task path. §9.4's "a tombstone
   * without a reason is a mystery in year six" is an argument for *asking*, not
   * for refusing the write — an honest blank beats an invented reason, and a
   * required field produces the second.
   */
  deleteNight(id: string, at: string, reason: string | null): Promise<Result<SleepNight, DomainError>>;
};

export function createSleepRepository(db: Database): SleepRepository {
  return {
    async nightsBetween(fromDayKey, toDayKey) {
      const rows = await db
        .select()
        .from(sleepNight)
        .where(
          and(
            isNull(sleepNight.deletedAt),
            gte(sleepNight.dayKey, fromDayKey),
            lte(sleepNight.dayKey, toDayKey),
          ),
        )
        /*
         * Day keys, not instants. A night is filed under the morning it ended
         * and `YYYY-MM-DD` sorts chronologically as text, so this rides the
         * partial index rather than truncating a timestamp per row.
         */
        .orderBy(asc(sleepNight.dayKey));
      return ok(rows.map(toNight));
    },

    async nightForDay(dayKey) {
      const rows = await db
        .select()
        .from(sleepNight)
        .where(and(eq(sleepNight.dayKey, dayKey), isNull(sleepNight.deletedAt)))
        /* At most one row can match — the unique index guarantees it — but the
         * ordering makes the intent explicit if the index is ever relaxed. */
        .orderBy(desc(sleepNight.createdAt))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toNight(row));
    },

    async recordNight(input) {
      /*
       * The replay check comes first, and it has to.
       *
       * `ON CONFLICT` names one arbiter, and this statement's arbiter is the
       * day key. A resent write carrying an id that is already stored would
       * therefore collide on the primary key instead — an unhandled 23505
       * rather than the no-op §5.7 requires. Looking the id up costs one round
       * trip and buys the guarantee.
       */
      const existing = await db.select().from(sleepNight).where(eq(sleepNight.id, input.id)).limit(1);
      const replayed = existing[0];
      if (replayed !== undefined) return ok(toNight(replayed));

      const rows = await db
        .insert(sleepNight)
        .values({
          id: input.id,
          dayKey: input.dayKey,
          zone: input.zone,
          bedAt: input.bedAt ?? null,
          wokeAt: input.wokeAt ?? null,
          durationHours: input.durationHours ?? null,
          quality: input.quality ?? null,
          latencyMinutes: input.latencyMinutes ?? null,
          wakings: input.wakings ?? null,
          disturbance: input.disturbance ?? null,
          disturbanceNote: input.disturbanceNote ?? null,
          note: input.note ?? null,
        })
        .onConflictDoUpdate({
          target: sleepNight.dayKey,
          /* The partial index's predicate, repeated so Postgres can infer it.
           * Without this the statement raises 42P10 — see the file header. */
          targetWhere: sql`${sleepNight.deletedAt} IS NULL`,
          set: {
            zone: sql`excluded.zone`,
            bedAt: sql`excluded.bed_at`,
            wokeAt: sql`excluded.woke_at`,
            durationHours: sql`excluded.duration_hours`,
            quality: sql`excluded.quality`,
            latencyMinutes: sql`excluded.latency_minutes`,
            wakings: sql`excluded.wakings`,
            disturbance: sql`excluded.disturbance`,
            disturbanceNote: sql`excluded.disturbance_note`,
            note: sql`excluded.note`,
            /*
             * The whole night is replaced, nulls included. Re-recording a
             * morning is the operator saying what that night was, and a merge
             * that kept the old endpoints because the new capture omitted them
             * would make a correction impossible to express. The id and
             * `created_at` are the exceptions: the row keeps the identity it
             * has had since the first write.
             */
            updatedAt: sql`now()`,
            version: sql`${sleepNight.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      /* Unreachable: `DO UPDATE` always returns its row, unlike `DO NOTHING`.
       * Reported rather than asserted, because §5.12 reserves exceptions for
       * genuine bugs and this would be one. */
      return row === undefined ? { ok: false, error: notFoundError(ENTITY, input.id) } : ok(toNight(row));
    },

    async deleteNight(id, at, reason) {
      const rows = await db
        .update(sleepNight)
        /* A tombstone without a reason is a mystery in year six (§9.4), so the
         * reason is a required argument rather than an optional one. */
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(sleepNight.id, id), isNull(sleepNight.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError(ENTITY, id) } : ok(toNight(row));
    },
  };
}

/**
 * Telemetry reads — §5.11's dashboard, and §12's V1 instrumentation.
 *
 * ## The schema is the privacy guarantee, not a policy
 *
 * §5.11: "Event names and numeric measurements only. **No payloads, ever.** The
 * schema cannot represent user content, which makes leakage impossible rather
 * than prohibited."
 *
 * `app_event` has `name`, `value`, `route`, `occurred_at`, `zone`,
 * `device_class`, `schema_version`. There is nowhere to put a mood score, a
 * journal word, or a medication name. This file only reads it, and it could not
 * leak content if it tried — which is the shape §5.11 asked for.
 *
 * ## Ninety-day retention
 *
 * §5.11: "Ninety-day retention, then aggregate and discard." {@link pruneEvents}
 * is that, and it is called by the nightly job rather than by a cron on the
 * database, so the deletion appears in `job_run` like every other scheduled
 * effect.
 */

import { and, count, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, TimedEvent } from '@naitikos/core';
import { dayKeyInZone, isoFromMillis, parseInstant } from '@naitikos/core';

import type { Database } from '../client';
import { appEvent } from '../schema/operations';
import { observation, observationSource } from '../schema/substrate';

/** §5.11's retention. */
export const TELEMETRY_RETENTION_DAYS = 90;

export type EventCounts = Readonly<Record<string, number>>;

export type TelemetryRepository = {
  /** Every recorded value for one event name in a window. Latencies, mostly. */
  valuesFor(name: string, from: string, until: string): Promise<Result<readonly number[], DomainError>>;
  /** How many times each named event occurred. */
  countsByName(from: string, until: string): Promise<Result<EventCounts, DomainError>>;
  /** Route transitions as day-keyed instants, for the foreground approximation. */
  transitions(from: string, until: string, zone: string): Promise<Result<readonly TimedEvent[], DomainError>>;
  /** Observations written in a window, grouped by their source kind (§1.4). */
  observationsBySource(from: string, until: string): Promise<Result<EventCounts, DomainError>>;
  /** Facts recorded, and facts later superseded — §1.4's correction rate. */
  correctionCounts(
    from: string,
    until: string,
  ): Promise<Result<{ readonly total: number; readonly corrected: number }, DomainError>>;
  /** §5.11's retention sweep. Returns rows removed. */
  pruneEvents(before: string): Promise<Result<number, DomainError>>;
};

export function createTelemetryRepository(db: Database): TelemetryRepository {
  return {
    async valuesFor(name, from, until) {
      const rows = await db
        .select({ value: appEvent.value })
        .from(appEvent)
        .where(
          and(
            eq(appEvent.name, name),
            gte(appEvent.occurredAt, from),
            lt(appEvent.occurredAt, until),
            isNotNull(appEvent.value),
          ),
        );

      return ok(rows.flatMap((row) => (row.value === null ? [] : [row.value])));
    },

    async countsByName(from, until) {
      const rows = await db
        .select({ name: appEvent.name, total: count() })
        .from(appEvent)
        .where(and(gte(appEvent.occurredAt, from), lt(appEvent.occurredAt, until)))
        .groupBy(appEvent.name);

      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.name] = Number(row.total);
      return ok(counts);
    },

    async transitions(from, until, zone) {
      const rows = await db
        .select({ occurredAt: appEvent.occurredAt, zone: appEvent.zone })
        .from(appEvent)
        .where(
          and(
            eq(appEvent.name, 'route.transition'),
            gte(appEvent.occurredAt, from),
            lt(appEvent.occurredAt, until),
          ),
        )
        .orderBy(desc(appEvent.occurredAt));

      /*
       * The day key is resolved in the event's own zone where it has one (§5.3),
       * falling back to the profile's. A transition at 23:40 in Kolkata belongs
       * to that day, not to the following UTC one — and the counter-metric is a
       * *per-day median*, so getting this wrong splits one evening across two
       * days and halves the figure.
       */
      return ok(
        rows.flatMap((row) => {
          // `parseInstant` is §11.3's sanctioned parse point; a bare
          // `Date.parse` here would be the rule's whole subject.
          const parsed = parseInstant(row.occurredAt);
          if (parsed === null) return [];
          return [
            { dayKey: dayKeyInZone(row.occurredAt, row.zone ?? zone), atMillis: parsed.getTime() },
          ];
        }),
      );
    },

    async observationsBySource(from, until) {
      const rows = await db
        .select({ kind: observationSource.kind, total: count() })
        .from(observation)
        .innerJoin(observationSource, eq(observation.sourceId, observationSource.id))
        .where(and(gte(observation.recordedAt, from), lt(observation.recordedAt, until)))
        .groupBy(observationSource.kind);

      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.kind] = Number(row.total);
      return ok(counts);
    },

    async correctionCounts(from, until) {
      /*
       * The numerator is observations that have been *superseded*, which §9.1
       * makes the only way a fact is corrected. Counting edits would be
       * impossible — there are none — and that is the point of the append-only
       * log: the correction rate is exactly countable rather than estimated.
       */
      const [totals, corrected] = await Promise.all([
        db
          .select({ total: count() })
          .from(observation)
          .where(and(gte(observation.recordedAt, from), lt(observation.recordedAt, until))),
        db
          .select({ total: count() })
          .from(observation)
          .where(
            and(
              gte(observation.recordedAt, from),
              lt(observation.recordedAt, until),
              isNotNull(observation.supersededById),
            ),
          ),
      ]);

      return ok({
        total: Number(totals[0]?.total ?? 0),
        corrected: Number(corrected[0]?.total ?? 0),
      });
    },

    async pruneEvents(before) {
      const deleted = await db
        .delete(appEvent)
        .where(lt(appEvent.occurredAt, before))
        .returning({ id: appEvent.id });
      return ok(deleted.length);
    },
  };
}

/**
 * Days with a completed Daily Close, inside a window.
 *
 * A thin wrapper over the same `system.daily_close.completed` marker the
 * Compounding Days query uses, restricted to a day-key range so the V1 gate can
 * ask about its own thirty-one days rather than the trailing ninety.
 */
export async function closedDaysBetween(
  db: Database,
  fromInstant: string,
  untilInstant: string,
  zone: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ observedAt: observation.observedAt, observedZone: observation.observedZone })
    .from(observation)
    .where(
      and(
        eq(observation.metricKey, 'system.daily_close.completed'),
        gte(observation.observedAt, fromInstant),
        lt(observation.observedAt, untilInstant),
        isNull(observation.supersededById),
      ),
    );

  /*
   * Distinct *local* days, computed here rather than in SQL — the same decision
   * `observation.repository.ts` records: `date_trunc(text, timestamptz)` is
   * STABLE rather than IMMUTABLE so Postgres will not index it, and
   * `AT TIME ZONE 'UTC'` would file every Indian evening under the next date.
   */
  return [...new Set(rows.map((row) => dayKeyInZone(row.observedAt, row.observedZone ?? zone)))].sort();
}

/** The cut-off instant for §5.11's retention sweep. */
export function retentionCutoff(nowMillis: number, days = TELEMETRY_RETENTION_DAYS): string {
  return isoFromMillis(nowMillis - days * 86_400_000);
}

/** Kept so the count query has one spelling across the repository. */
export const TELEMETRY_TOTAL = sql<number>`count(*)::int`;

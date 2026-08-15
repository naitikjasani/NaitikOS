/**
 * The observation log — appending to it, and reading it back.
 *
 * §9.1 makes this table append-only and enforces it with a `BEFORE UPDATE OR
 * DELETE` trigger, so this file has no `update` and no `delete`. The one
 * mutation it performs is {@link ObservationRepository.append}'s supersession
 * write, which sets three columns on an existing row and is the single
 * exception the trigger permits.
 *
 * Everything here takes a {@link Executor}, so it may be a transaction. The Daily
 * Close writes observations, a supersession, a medication event and a note as
 * one unit, and a repository that opened its own connection would make that
 * atomicity impossible to express.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DomainError, Observation, Supersession } from '@naitikos/core';
import { conflictError, zonedDayBounds } from '@naitikos/core';

import type { Executor } from '../client';
import { observation, observationSource } from '../schema/substrate';

/** Row → domain observation. */
function toObservation(row: typeof observation.$inferSelect): Observation {
  return {
    id: row.id as Observation['id'],
    metricKey: row.metricKey as Observation['metricKey'],
    value: row.value,
    valueText: row.valueText,
    unit: row.unit,
    observedAt: row.observedAt,
    observedZone: row.observedZone,
    recordedAt: row.recordedAt,
    sourceId: row.sourceId as Observation['sourceId'],
    confidence: row.confidence,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    context: (row.context ?? null) as Observation['context'],
    supersededById: row.supersededById as Observation['supersededById'],
    supersededAt: row.supersededAt,
    supersedeReason: row.supersedeReason,
    hlc: row.hlc as Observation['hlc'],
  };
}

export type ObservationQuery = {
  readonly metricKeys?: readonly string[];
  /** Inclusive lower bound, ISO instant. */
  readonly from?: string;
  /** Exclusive upper bound, ISO instant. */
  readonly until?: string;
  /** Omit rows a later observation has replaced. Defaults to `true`. */
  readonly currentOnly?: boolean;
  readonly limit?: number;
};

export type ObservationRepository = {
  /**
   * Append a batch and apply its corrections, atomically.
   *
   * Both halves in one statement pair rather than one call per row: the Daily
   * Close writes up to seven observations, and seven round trips on the P1 hot
   * path is the difference between a ritual and a wait.
   */
  append(
    observations: readonly Observation[],
    supersessions?: readonly Supersession[],
  ): Promise<Result<number, DomainError>>;

  /** Everything observed on one local day, in the given zone (§5.3). */
  forDay(dayKey: string, zone: string, metricKeys?: readonly string[]): Promise<Result<readonly Observation[], DomainError>>;

  query(query: ObservationQuery): Promise<Result<readonly Observation[], DomainError>>;

  /** The most recent current value of each named metric. */
  latestPerMetric(metricKeys: readonly string[]): Promise<Result<ReadonlyMap<string, Observation>, DomainError>>;

  /** Resolve or create the provenance row for a manual capture (§9.2). */
  manualSourceId(): Promise<Result<string, DomainError>>;

  /** Resolve or create the provenance row for a document extraction (§9.9). */
  extractionSourceId(
    documentId: string,
    engine: string,
    engineVersion: string,
  ): Promise<Result<string, DomainError>>;

  count(): Promise<number>;
};

/** §9.2's provenance row for "the user typed it". Stable across the process. */
const MANUAL_SOURCE = { kind: 'manual', identifier: 'manual', version: null } as const;

export function createObservationRepository(db: Executor): ObservationRepository {
  let manualSource: string | null = null;

  return {
    async append(observations, supersessions = []) {
      if (observations.length === 0 && supersessions.length === 0) return ok(0);

      if (observations.length > 0) {
        /*
         * `onConflictDoNothing`, and it is the whole offline story.
         *
         * §5.7 gives every record a client-generated UUIDv7 "from the moment it
         * exists", so a replayed outbox entry arrives with the *same* primary
         * key. Doing nothing on conflict makes the replay a no-op instead of a
         * 23505 the client would have to interpret. The idempotency record
         * (§5.7) is the belt; this is the braces, and at the layer where a
         * partial replay actually lands.
         */
        await db
          .insert(observation)
          .values(
            observations.map((o) => ({
              id: o.id,
              metricKey: o.metricKey,
              value: o.value,
              valueText: o.valueText,
              unit: o.unit,
              observedAt: o.observedAt,
              observedZone: o.observedZone,
              recordedAt: o.recordedAt,
              sourceId: o.sourceId,
              confidence: o.confidence,
              subjectType: o.subjectType,
              subjectId: o.subjectId,
              context: o.context,
              hlc: o.hlc,
            })),
          )
          .onConflictDoNothing({ target: observation.id });
      }

      for (const supersession of supersessions) {
        /*
         * Guarded by `IS NULL`, so a row can be superseded once and only once.
         *
         * Without the guard, two devices correcting the same observation while
         * offline would both succeed and the second would overwrite the first's
         * pointer — losing a link in the correction chain that §9.1 promises
         * survives forever. With it, the second write matches nothing and the
         * conflict is reported rather than absorbed.
         */
        const updated = await db
          .update(observation)
          .set({
            supersededById: supersession.supersededById,
            supersededAt: supersession.supersededAt,
            supersedeReason: supersession.supersedeReason,
          })
          .where(and(eq(observation.id, supersession.observationId), isNull(observation.supersededById)))
          .returning({ id: observation.id });

        if (updated.length === 0) {
          return err(
            conflictError('observation', 'invalid_state', {
              code: 'observation_already_superseded',
              message:
                'That observation has already been corrected, or does not exist. Refetch before correcting again.',
            }),
          );
        }
      }

      return ok(observations.length);
    },

    async forDay(dayKey, zone, metricKeys) {
      const bounds = zonedDayBounds(dayKey, zone);
      if (bounds === null) {
        return err(
          conflictError('observation', 'invalid_state', {
            code: 'observation_day_unresolvable',
            message: 'Could not resolve that day in that time zone.',
          }),
        );
      }

      /*
       * A half-open range scan, not `date_trunc`.
       *
       * The schema records why at length: `date_trunc(text, timestamptz)` is
       * STABLE rather than IMMUTABLE so Postgres refuses it in an index, and
       * forcing `AT TIME ZONE 'UTC'` would file every Indian evening under the
       * following date. The bounds are computed in the zone by `core/temporal`
       * and the scan uses `observation_observed_at_idx` as it stands.
       */
      const filters = [gte(observation.observedAt, bounds.start), lt(observation.observedAt, bounds.end)];
      if (metricKeys !== undefined && metricKeys.length > 0) {
        filters.push(inArray(observation.metricKey, [...metricKeys]));
      }
      filters.push(isNull(observation.supersededById));

      const rows = await db
        .select()
        .from(observation)
        .where(and(...filters))
        .orderBy(asc(observation.observedAt), asc(observation.hlc));

      return ok(rows.map(toObservation));
    },

    async query(query) {
      const filters = [];
      if (query.metricKeys !== undefined && query.metricKeys.length > 0) {
        filters.push(inArray(observation.metricKey, [...query.metricKeys]));
      }
      if (query.from !== undefined) filters.push(gte(observation.observedAt, query.from));
      if (query.until !== undefined) filters.push(lt(observation.observedAt, query.until));
      if (query.currentOnly !== false) filters.push(isNull(observation.supersededById));

      const rows = await db
        .select()
        .from(observation)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(observation.observedAt), desc(observation.hlc))
        .limit(Math.min(query.limit ?? 500, 5000));

      return ok(rows.map(toObservation));
    },

    async latestPerMetric(metricKeys) {
      if (metricKeys.length === 0) return ok(new Map());

      /*
       * `DISTINCT ON`, which is Postgres-specific and deliberately so.
       *
       * The portable alternative is a window function or a correlated
       * subquery; both are slower here because `observation_current_idx` is
       * already ordered `(metric_key, observed_at DESC)` and `DISTINCT ON`
       * reads the first row of each group straight off it. §5.3 commits to
       * Postgres 17 (§9), so trading portability for an index-only scan on the
       * dashboard's hot query is a trade already made.
       */
      const rows = await db
        .selectDistinctOn([observation.metricKey])
        .from(observation)
        .where(and(inArray(observation.metricKey, [...metricKeys]), isNull(observation.supersededById)))
        .orderBy(observation.metricKey, desc(observation.observedAt), desc(observation.hlc));

      const latest = new Map<string, Observation>();
      for (const row of rows) latest.set(row.metricKey, toObservation(row));
      return ok(latest);
    },

    async manualSourceId() {
      if (manualSource !== null) return ok(manualSource);

      const existing = await db
        .select({ id: observationSource.id })
        .from(observationSource)
        .where(
          and(
            eq(observationSource.kind, MANUAL_SOURCE.kind),
            eq(observationSource.identifier, MANUAL_SOURCE.identifier),
            isNull(observationSource.version),
          ),
        )
        .limit(1);

      const found = existing[0];
      if (found !== undefined) {
        manualSource = found.id;
        return ok(found.id);
      }

      /*
       * Created on demand rather than seeded.
       *
       * The unique index is on `(kind, identifier, version)` and `version` is
       * NULL here — and in Postgres, NULLs are distinct in a unique index, so
       * `ON CONFLICT` on that target would not fire and two concurrent first
       * writes would both insert. The `WHERE NOT EXISTS` closes it inside one
       * statement; the re-select afterwards is what makes the loser of the race
       * return the winner's row rather than nothing.
       */
      await db.execute(sql`
        insert into observation_source (id, kind, identifier, version)
        select gen_random_uuid(), 'manual', 'manual', null
        where not exists (
          select 1 from observation_source
          where kind = 'manual' and identifier = 'manual' and version is null
        )
      `);

      const settled = await db
        .select({ id: observationSource.id })
        .from(observationSource)
        .where(
          and(
            eq(observationSource.kind, MANUAL_SOURCE.kind),
            eq(observationSource.identifier, MANUAL_SOURCE.identifier),
            isNull(observationSource.version),
          ),
        )
        .limit(1);

      const row = settled[0];
      if (row === undefined) {
        return err(
          conflictError('observation_source', 'invalid_state', {
            code: 'observation_source_unavailable',
            message: 'Could not resolve the manual observation source.',
          }),
        );
      }

      manualSource = row.id;
      return ok(row.id);
    },

    /**
     * §9.2's provenance row for "this number came off a document".
     *
     * One source per document, not one shared by every extraction.
     * `observation_source` carries `documentId` precisely so a number can be
     * traced back to the page it came from (§9.9), and a shared row would break
     * that link the moment a second report was imported.
     *
     * `version` is the parser's and is never NULL, which means the unique index
     * on `(kind, identifier, version)` actually fires — so this can be a plain
     * `ON CONFLICT` rather than the `WHERE NOT EXISTS` dance `manualSourceId`
     * needs for its null version.
     */
    async extractionSourceId(documentId, engine, engineVersion) {
      const identifier = `${engine}:document:${documentId}`;

      await db
        .insert(observationSource)
        .values({
          id: randomUUID(),
          kind: 'document_extraction',
          identifier,
          version: engineVersion,
          documentId,
        })
        .onConflictDoNothing({
          target: [observationSource.kind, observationSource.identifier, observationSource.version],
        });

      const rows = await db
        .select({ id: observationSource.id })
        .from(observationSource)
        .where(
          and(
            eq(observationSource.kind, 'document_extraction'),
            eq(observationSource.identifier, identifier),
            eq(observationSource.version, engineVersion),
          ),
        )
        .limit(1);

      const found = rows[0];
      if (found === undefined) {
        return err(
          conflictError('observation_source', 'invalid_state', {
            code: 'observation_source_unavailable',
            message: 'Could not resolve the extraction observation source.',
          }),
        );
      }
      return ok(found.id);
    },

    async count() {
      const rows = await db.select({ total: sql<number>`count(*)::int` }).from(observation);
      return rows[0]?.total ?? 0;
    },
  };
}

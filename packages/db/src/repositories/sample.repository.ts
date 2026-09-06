/**
 * Device samples — ingest, read, and the retention policy that keeps this table
 * from being the reason the database needs a bigger machine.
 *
 * §9.7 sizes the problem: "continuous heart rate at one-minute resolution is
 * over half a million rows per year on its own, and a wearable emitting several
 * such streams reaches tens of millions over twenty years." Everything unusual
 * about this file follows from that number.
 *
 * ## Deduplication is the natural key, not the primary key
 *
 * `sample` is partitioned by `observed_at`, and Postgres requires the partition
 * key in every unique constraint — so the primary key is `(id, observed_at)`,
 * and it guarantees nothing useful, because a re-import mints fresh ids. The
 * index that matters is `sample_source_metric_observed_unique` on
 * `(source_id, metric_key, observed_at)`: one device cannot have produced two
 * readings of one metric at one instant.
 *
 * That is what makes {@link SampleRepository.importSamples} idempotent, and it
 * has to be, because §2.3 makes import "pull-based, batch" — the operator will
 * export a file that overlaps the last one, and they should not have to know
 * that. A doubled month of heart rate would not announce itself; it would just
 * quietly halve every average.
 *
 * ## The downsampler aggregates in Postgres and never streams raw rows
 *
 * `GROUP BY date_trunc('hour', ...)` happens in the database; only the
 * *aggregates* come back to Node, and there are at most 24 of those per metric
 * per day by construction. Streaming ninety days of raw samples across the wire
 * to average them would move gigabytes to compute a number the database
 * computes in place, in a nightly job §5.2 requires stay boring.
 *
 * The aggregate each metric collapses to comes from `core` — `aggregateFor` —
 * so which one is a domain decision and only its spelling is SQL's business.
 * A metric whose aggregation has no honest hourly form keeps its raw rows.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, MetricRegistry, NormalisedSample, WearablePlatform } from '@naitikos/core';
import { aggregateFor, conflictError } from '@naitikos/core';

import type { Database } from '../client';
import { metric, observationSource, sample } from '../schema/substrate';

/** A stored sample, as a reader sees it. */
export type Sample = {
  readonly id: string;
  readonly metricKey: string;
  readonly value: string;
  readonly unit: string;
  readonly observedAt: string;
  readonly observedZone: string;
  /** True when this row is an hourly aggregate and not a reading (§9.7). */
  readonly isDownsampled: boolean;
};

/** What one import did. Every number here is shown to the operator (§8.9). */
export type SampleImportOutcome = {
  readonly inserted: number;
  /** Rows the unique index already had — a re-import, working as intended. */
  readonly duplicates: number;
  readonly sourceId: string;
};

/** One metric's presence in the table, for the import screen's summary. */
export type SampleCoverage = {
  readonly metricKey: string;
  readonly displayName: string;
  readonly samples: number;
  readonly earliest: string;
  readonly latest: string;
  /** How many of those rows are hourly aggregates rather than readings. */
  readonly aggregates: number;
};

export type DownsampleOutcome = {
  /** Hourly aggregate rows written. */
  readonly written: number;
  /** Raw rows dropped, which is always ≥ `written` or the collapse did nothing. */
  readonly dropped: number;
  /** Metrics left at full resolution because they have no honest collapse. */
  readonly preserved: readonly string[];
};

function toSample(row: typeof sample.$inferSelect): Sample {
  return {
    id: row.id,
    metricKey: row.metricKey,
    value: row.value,
    unit: row.unit,
    observedAt: row.observedAt,
    observedZone: row.observedZone,
    isDownsampled: row.isDownsampled,
  };
}

export type SampleRepository = {
  /**
   * The provenance row for a platform's importer, created on first use.
   *
   * One source per `(platform, importer version)`, which is what makes the
   * dedup key work: re-importing through the same importer hits the same
   * `source_id` and conflicts, while a future importer version gets its own
   * source and its rows are distinguishable from the old ones forever (§9.2).
   */
  sourceFor(platform: WearablePlatform, importerVersion: string): Promise<Result<string, DomainError>>;

  /** Idempotent by the natural key. Re-importing an overlapping export is a no-op. */
  importSamples(sourceId: string, rows: readonly NormalisedSample[]): Promise<Result<SampleImportOutcome, DomainError>>;

  /** Samples for one metric in a half-open instant range, oldest first. */
  range(metricKey: string, from: string, to: string): Promise<Result<readonly Sample[], DomainError>>;

  /** What this table holds, per metric. Empty when nothing has been imported. */
  coverage(): Promise<Result<readonly SampleCoverage[], DomainError>>;

  /**
   * Collapse raw rows older than `cutoff` into hourly aggregates (§9.7).
   *
   * Irreversible, and deliberately so — see the note on `downsample.ts`.
   */
  downsample(cutoff: string, registry: MetricRegistry): Promise<Result<DownsampleOutcome, DomainError>>;

  /**
   * Make sure a month has somewhere to land.
   *
   * Calls `ensure_sample_partition`, which migration 0015 defined as idempotent
   * — a partition that exists costs one catalogue lookup. Run nightly for the
   * month ahead, so an import at 00:01 on the first never lands in DEFAULT.
   */
  ensurePartition(monthStart: string): Promise<Result<string, DomainError>>;

  /** How many rows are sitting in the DEFAULT partition, which should be none. */
  strandedCount(): Promise<Result<number, DomainError>>;
};

export function createSampleRepository(db: Database): SampleRepository {
  return {
    async sourceFor(platform, importerVersion) {
      const identifier = platform;

      /*
       * `version` is never NULL here, so the unique index on
       * `(kind, identifier, version)` actually fires and a plain
       * `ON CONFLICT` is enough — unlike the manual source, whose null version
       * needs a `WHERE NOT EXISTS` because Postgres treats NULLs as distinct.
       */
      await db
        .insert(observationSource)
        .values({
          id: randomUUID(),
          kind: 'device_import',
          identifier,
          version: importerVersion,
        })
        .onConflictDoNothing({
          target: [observationSource.kind, observationSource.identifier, observationSource.version],
        });

      const rows = await db
        .select({ id: observationSource.id })
        .from(observationSource)
        .where(
          and(
            eq(observationSource.kind, 'device_import'),
            eq(observationSource.identifier, identifier),
            eq(observationSource.version, importerVersion),
          ),
        )
        .limit(1);

      const found = rows[0];
      if (found === undefined) {
        return {
          ok: false,
          error: conflictError('observation_source', 'invalid_state', {
            code: 'device_source_unavailable',
            message: `Could not resolve the import source for ${platform}.`,
          }),
        };
      }

      return ok(found.id);
    },

    async importSamples(sourceId, rows) {
      if (rows.length === 0) return ok({ inserted: 0, duplicates: 0, sourceId });

      /*
       * `returning` on a `DO NOTHING` insert returns only the rows that were
       * actually written, which is how the duplicate count is obtained without
       * a second query. Counting the input and subtracting is the whole trick,
       * and it is exact rather than an estimate.
       */
      const inserted = await db
        .insert(sample)
        .values(
          rows.map((row) => ({
            id: row.id,
            metricKey: row.metricKey,
            value: row.value,
            unit: row.unit,
            observedAt: row.observedAt,
            observedZone: row.observedZone,
            sourceId,
            isDownsampled: false,
          })),
        )
        .onConflictDoNothing({
          /*
           * The arbiter is the natural key, not the primary key. Naming the
           * columns rather than the index lets Postgres infer it, and it will
           * only infer `sample_source_metric_observed_unique` — the primary key
           * `(id, observed_at)` cannot match, because `id` is not in this list.
           */
          target: [sample.sourceId, sample.metricKey, sample.observedAt],
        })
        .returning({ id: sample.id });

      return ok({
        inserted: inserted.length,
        duplicates: rows.length - inserted.length,
        sourceId,
      });
    },

    async range(metricKey, from, to) {
      const rows = await db
        .select()
        .from(sample)
        .where(and(eq(sample.metricKey, metricKey), gte(sample.observedAt, from), lt(sample.observedAt, to)))
        .orderBy(asc(sample.observedAt));

      return ok(rows.map(toSample));
    },

    async coverage() {
      const rows = await db
        .select({
          metricKey: sample.metricKey,
          displayName: metric.displayName,
          samples: count(),
          earliest: sql<string>`min(${sample.observedAt})`,
          latest: sql<string>`max(${sample.observedAt})`,
          aggregates: sql<number>`count(*) filter (where ${sample.isDownsampled})::int`,
        })
        .from(sample)
        .innerJoin(metric, eq(metric.key, sample.metricKey))
        .groupBy(sample.metricKey, metric.displayName)
        .orderBy(desc(count()));

      return ok(
        rows.map((row) => ({
          metricKey: row.metricKey,
          displayName: row.displayName,
          samples: Number(row.samples),
          earliest: row.earliest,
          latest: row.latest,
          aggregates: Number(row.aggregates),
        })),
      );
    },

    async downsample(cutoff, registry) {
      /*
       * Only metrics that actually have old raw rows. Without this the loop
       * runs one no-op statement per registered metric every night — harmless
       * today and a hundred wasted round trips once the registry has grown.
       */
      const present = await db
        .selectDistinct({ metricKey: sample.metricKey })
        .from(sample)
        .where(and(lt(sample.observedAt, cutoff), eq(sample.isDownsampled, false)));

      let written = 0;
      let dropped = 0;
      const preserved: string[] = [];

      for (const { metricKey } of present) {
        const definition = registry.get(metricKey);
        const aggregate = definition === null ? null : aggregateFor(definition.aggregation);

        if (aggregate === null) {
          /* No honest hourly form. The rows stay, and the table grows — which
           * is the visible failure rather than the silent one. */
          preserved.push(metricKey);
          continue;
        }

        /*
         * Aggregate, delete, then insert — in that order, in one transaction.
         *
         * The tempting version is a single statement: a data-modifying CTE that
         * `DELETE ... RETURNING`s the raw rows, groups them, and inserts the
         * aggregates. It is wrong in a way that only shows up on the hour
         * boundary. Every statement in a `WITH` sees the same snapshot, and
         * `ON CONFLICT` checks uniqueness against a dirty snapshot in which a
         * row deleted by *this same command* is still present — so an aggregate
         * landing exactly on an hour that already had a raw reading at
         * `HH:00:00` would conflict with the row being deleted beside it, do
         * nothing, and leave the hour with neither the readings nor their mean.
         *
         * Three ordered statements avoid it entirely: by the time the insert
         * runs, the delete is visible to it. They share a transaction, so a
         * crash between them rolls back to full resolution rather than to an
         * hour that has been counted and not yet stored — the direction §5.2's
         * idempotency requirement demands, since re-running from raw rows is
         * free and re-deriving from deleted ones is impossible.
         *
         * `observed_zone` and `source_id` are taken with `min()` rather than
         * grouped on. An hour's readings could in principle come from two
         * devices; collapsing them loses that, and the alternative — one
         * aggregate per source per hour — preserves a distinction nobody will
         * query at the cost of the row count this exercise exists to reduce.
         * Keeping a device source rather than minting a derivation source is
         * also what keeps the aggregate covered by the natural unique key, so a
         * second run cannot write a second mean for the same hour.
         */
        const collapsed = await db.transaction(async (tx) => {
          const buckets = await tx.execute(sql`
            select date_trunc('hour', observed_at) as bucket,
                   round(${sql.raw(aggregate)}(value), 6)::text as value,
                   min(unit) as unit,
                   min(observed_zone) as observed_zone,
                   min(source_id::text) as source_id,
                   count(*)::int as raw_rows
              from sample
             where metric_key = ${metricKey}
               and observed_at < ${cutoff}
               and is_downsampled = false
             group by 1
          `);

          const rows = buckets as unknown as readonly {
            bucket: string | Date;
            value: string;
            unit: string;
            observed_zone: string;
            source_id: string;
            raw_rows: number;
          }[];

          if (rows.length === 0) return { written: 0, dropped: 0 };

          await tx
            .delete(sample)
            .where(
              and(eq(sample.metricKey, metricKey), lt(sample.observedAt, cutoff), eq(sample.isDownsampled, false)),
            );

          const put = await tx
            .insert(sample)
            .values(
              rows.map((row) => ({
                id: randomUUID(),
                metricKey,
                value: row.value,
                unit: row.unit,
                observedAt: row.bucket instanceof Date ? row.bucket.toISOString() : row.bucket,
                observedZone: row.observed_zone,
                sourceId: row.source_id,
                isDownsampled: true,
              })),
            )
            .onConflictDoNothing({
              target: [sample.sourceId, sample.metricKey, sample.observedAt],
            })
            .returning({ id: sample.id });

          return {
            written: put.length,
            dropped: rows.reduce((total, row) => total + Number(row.raw_rows), 0),
          };
        });

        written += collapsed.written;
        dropped += collapsed.dropped;
      }

      return ok({ written, dropped, preserved: preserved.sort() });
    },

    async ensurePartition(monthStart) {
      const rows = await db.execute(sql`select ensure_sample_partition(${monthStart}::date) as name`);
      const row = rows[0] as { name?: string } | undefined;
      return ok(row?.name ?? '');
    },

    async strandedCount() {
      /*
       * The DEFAULT partition exists so a malformed timestamp does not fail a
       * whole batch (migration 0015). A row landing there is not an error, but
       * it is a signal — and an unread signal is not one, so the nightly
       * partition step reports this number.
       */
      const rows = await db.execute(sql`select count(*)::int as count from sample_default`);
      const row = rows[0] as { count?: number } | undefined;
      return ok(Number(row?.count ?? 0));
    },
  };
}

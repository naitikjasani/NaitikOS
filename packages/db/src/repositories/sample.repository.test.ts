/**
 * Device samples — integration, against real Postgres.
 *
 * The core tests cover the normalisation. This covers the two things only a
 * database can prove, and both of them are the difference between an importer
 * that works and one that quietly ruins a longitudinal record:
 *
 *   1. **A re-import is a no-op.** §2.3 makes ingestion "pull-based, batch",
 *      which means the operator will hand this the same month twice. The
 *      unique index on `(source_id, metric_key, observed_at)` is what makes
 *      that safe, and a doubled month of heart rate would not announce itself
 *      — it would just halve every average from then on.
 *   2. **The collapse loses no hour.** §9.7 drops the raw rows, so a
 *      downsampler that skipped a bucket would destroy the only copy. The test
 *      that matters is the one where an aggregate lands exactly on an hour
 *      boundary that already had a reading.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';
import { createMetricRegistry, WEARABLE_METRICS, WEARABLE_METRIC_DEFINITIONS } from '@naitikos/core';
import type { NormalisedSample } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createSampleRepository } from './sample.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const registry = createMetricRegistry([...WEARABLE_METRIC_DEFINITIONS]);

function beat(observedAt: string, value: string): NormalisedSample {
  return {
    id: newId(),
    metricKey: WEARABLE_METRICS.heartRate,
    value,
    unit: 'bpm',
    observedAt,
    observedZone: 'Asia/Kolkata',
  };
}

suite('sample repository (§2.3, §9.7)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createSampleRepository(database);

  let sourceId = '';

  beforeEach(async () => {
    await resetDomainTables(database.$client);
    sourceId = unwrap(await repo.sourceFor('apple_health', '1'));
  });

  describe('provenance', () => {
    it('reuses one source per platform and importer version', async () => {
      const again = unwrap(await repo.sourceFor('apple_health', '1'));

      expect(again).toBe(sourceId);
    });

    it('gives a new importer version its own source', async () => {
      // §9.2's point: rows written by a fixed importer must stay
      // distinguishable from rows written by the one that had the bug.
      const next = unwrap(await repo.sourceFor('apple_health', '2'));

      expect(next).not.toBe(sourceId);
    });

    it('keeps the platforms apart', async () => {
      const google = unwrap(await repo.sourceFor('google_fit', '1'));

      expect(google).not.toBe(sourceId);
    });
  });

  describe('importSamples', () => {
    it('stores a batch', async () => {
      const outcome = unwrap(
        await repo.importSamples(sourceId, [
          beat('2026-09-06T04:00:00.000Z', '62'),
          beat('2026-09-06T04:01:00.000Z', '64'),
        ]),
      );

      expect(outcome).toEqual({ inserted: 2, duplicates: 0, sourceId });
    });

    it('makes a re-import a no-op', async () => {
      const rows = [beat('2026-09-06T04:00:00.000Z', '62'), beat('2026-09-06T04:01:00.000Z', '64')];
      await repo.importSamples(sourceId, rows);

      // Fresh ids, same instants — exactly what a second export produces.
      const second = unwrap(
        await repo.importSamples(sourceId, [
          beat('2026-09-06T04:00:00.000Z', '62'),
          beat('2026-09-06T04:01:00.000Z', '64'),
        ]),
      );

      expect(second).toEqual({ inserted: 0, duplicates: 2, sourceId });

      const stored = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'));
      expect(stored).toHaveLength(2);
    });

    it('keeps the first value when the second import disagrees', async () => {
      // DO NOTHING, not DO UPDATE. A device that re-reports an instant with a
      // different number has changed its mind about the past, and §9.1's
      // append-only principle says the first record stands.
      await repo.importSamples(sourceId, [beat('2026-09-06T04:00:00.000Z', '62')]);
      await repo.importSamples(sourceId, [beat('2026-09-06T04:00:00.000Z', '99')]);

      const stored = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'));
      expect(stored[0]?.value).toBe('62.000000');
    });

    it('lets two sources hold the same instant', async () => {
      // The key includes the source. A watch and a chest strap disagreeing at
      // one instant is two facts, not a conflict.
      const other = unwrap(await repo.sourceFor('google_fit', '1'));
      await repo.importSamples(sourceId, [beat('2026-09-06T04:00:00.000Z', '62')]);
      const second = unwrap(await repo.importSamples(other, [beat('2026-09-06T04:00:00.000Z', '71')]));

      expect(second.inserted).toBe(1);
    });

    it('accepts an empty batch without a round trip', async () => {
      expect(unwrap(await repo.importSamples(sourceId, []))).toEqual({ inserted: 0, duplicates: 0, sourceId });
    });
  });

  describe('range and coverage', () => {
    beforeEach(async () => {
      await repo.importSamples(sourceId, [
        beat('2026-09-06T04:00:00.000Z', '62'),
        beat('2026-09-06T05:00:00.000Z', '70'),
        beat('2026-09-07T04:00:00.000Z', '58'),
      ]);
    });

    it('reads a half-open range, oldest first', async () => {
      const rows = unwrap(
        await repo.range(WEARABLE_METRICS.heartRate, '2026-09-06T00:00:00Z', '2026-09-07T00:00:00Z'),
      );

      expect(rows.map((row) => row.value)).toEqual(['62.000000', '70.000000']);
    });

    it('excludes the upper bound', async () => {
      const rows = unwrap(
        await repo.range(WEARABLE_METRICS.heartRate, '2026-09-06T04:00:00Z', '2026-09-06T05:00:00Z'),
      );

      expect(rows).toHaveLength(1);
    });

    it('reports what the table holds', async () => {
      const [entry] = unwrap(await repo.coverage());

      expect(entry?.metricKey).toBe(WEARABLE_METRICS.heartRate);
      expect(entry?.displayName).toBe('Heart rate');
      expect(entry?.samples).toBe(3);
      expect(entry?.aggregates).toBe(0);
    });

    it('reports nothing before anything is imported', async () => {
      await resetDomainTables(database.$client);

      expect(unwrap(await repo.coverage())).toEqual([]);
    });
  });

  describe('downsample (§9.7)', () => {
    it('collapses an hour of readings into their mean', async () => {
      await repo.importSamples(sourceId, [
        beat('2026-01-05T04:05:00.000Z', '60'),
        beat('2026-01-05T04:25:00.000Z', '70'),
        beat('2026-01-05T04:45:00.000Z', '80'),
      ]);

      const outcome = unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      expect(outcome.written).toBe(1);
      expect(outcome.dropped).toBe(3);

      const rows = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.observedAt).toContain('04:00:00');
      expect(Number(rows[0]?.value)).toBe(70);
      expect(rows[0]?.isDownsampled).toBe(true);
    });

    it('does not lose the hour when a reading sits exactly on the boundary', async () => {
      /*
       * The failure a single data-modifying CTE would have had. The aggregate's
       * instant is the hour start, which is also this reading's instant — so
       * a DELETE and an INSERT sharing one snapshot would see the doomed row as
       * a live conflict, do nothing, and leave the hour with neither the
       * readings nor their mean.
       */
      await repo.importSamples(sourceId, [
        beat('2026-01-05T04:00:00.000Z', '60'),
        beat('2026-01-05T04:30:00.000Z', '80'),
      ]);

      const outcome = unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      expect(outcome.written).toBe(1);

      const rows = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.value)).toBe(70);
    });

    it('sums a cumulative metric rather than averaging it', async () => {
      // Getting this backwards under-reports a day sixtyfold, and it is
      // invisible once the raw rows are gone.
      await repo.importSamples(sourceId, [
        { ...beat('2026-01-05T04:05:00.000Z', '100'), metricKey: WEARABLE_METRICS.steps, unit: 'count' },
        { ...beat('2026-01-05T04:35:00.000Z', '150'), metricKey: WEARABLE_METRICS.steps, unit: 'count' },
      ]);

      unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      const rows = unwrap(await repo.range(WEARABLE_METRICS.steps, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(Number(rows[0]?.value)).toBe(250);
    });

    it('leaves rows newer than the cutoff at full resolution', async () => {
      await repo.importSamples(sourceId, [
        beat('2026-01-05T04:05:00.000Z', '60'),
        beat('2026-09-05T04:05:00.000Z', '61'),
        beat('2026-09-05T04:35:00.000Z', '63'),
      ]);

      unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      const recent = unwrap(
        await repo.range(WEARABLE_METRICS.heartRate, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      );
      expect(recent).toHaveLength(2);
      expect(recent.every((row) => !row.isDownsampled)).toBe(true);
    });

    it('is idempotent, because an aggregate is not collapsed again', async () => {
      // §5.2: "idempotent, safe to re-run". The `is_downsampled = false` filter
      // is what stops the second run averaging the averages.
      await repo.importSamples(sourceId, [
        beat('2026-01-05T04:05:00.000Z', '60'),
        beat('2026-01-05T04:25:00.000Z', '80'),
      ]);

      unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));
      const second = unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      expect(second).toEqual({ written: 0, dropped: 0, preserved: [] });

      const rows = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.value)).toBe(70);
    });

    it('preserves a metric whose aggregation has no honest hourly form', async () => {
      // A registry that says `last`. The rows must survive: the table growing
      // is a visible failure, a wrong collapse is not.
      const lastOnly = createMetricRegistry(
        WEARABLE_METRIC_DEFINITIONS.map((definition) => ({ ...definition, aggregation: 'last' as const })),
      );
      await repo.importSamples(sourceId, [beat('2026-01-05T04:05:00.000Z', '60')]);

      const outcome = unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', lastOnly));

      expect(outcome.written).toBe(0);
      expect(outcome.preserved).toEqual([WEARABLE_METRICS.heartRate]);

      const rows = unwrap(await repo.range(WEARABLE_METRICS.heartRate, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isDownsampled).toBe(false);
    });

    it('does nothing when there is nothing old enough', async () => {
      await repo.importSamples(sourceId, [beat('2026-09-06T04:00:00.000Z', '62')]);

      expect(unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry))).toEqual({
        written: 0,
        dropped: 0,
        preserved: [],
      });
    });

    it('marks the aggregate so nothing renders it as a reading', async () => {
      await repo.importSamples(sourceId, [beat('2026-01-05T04:05:00.000Z', '60')]);
      unwrap(await repo.downsample('2026-06-01T00:00:00.000Z', registry));

      const [entry] = unwrap(await repo.coverage());
      expect(entry?.aggregates).toBe(1);
      expect(entry?.samples).toBe(1);
    });
  });

  describe('partitions (migration 0015)', () => {
    it('creates a month idempotently and returns its name', async () => {
      const first = unwrap(await repo.ensurePartition('2027-03-01'));
      const second = unwrap(await repo.ensurePartition('2027-03-14'));

      expect(first).toBe('sample_2027_03');
      // Any day in the month resolves to the same partition.
      expect(second).toBe(first);
    });

    it(`applies §5.4 RLS posture to a partition made after the migration`, async () => {
      await repo.ensurePartition('2027-04-01');

      const [row] = await database.$client<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = 'sample_2027_04'`;

      expect(row?.enabled).toBe(true);
      expect(row?.forced).toBe(true);
    });

    it('reports how many rows landed in DEFAULT', async () => {
      // A row here is not an error — the DEFAULT partition exists so one bad
      // timestamp does not fail a batch — but it is a signal, and an unread
      // signal is not one.
      expect(unwrap(await repo.strandedCount())).toBe(0);

      await repo.importSamples(sourceId, [beat('1970-01-01T00:00:00.000Z', '62')]);

      expect(unwrap(await repo.strandedCount())).toBe(1);
    });
  });
});

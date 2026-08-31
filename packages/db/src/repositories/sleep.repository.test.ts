/**
 * Sleep — integration, against real Postgres.
 *
 * The core tests cover the arithmetic, including the circular midpoint. This
 * covers the three things only the database can answer, and the third is the
 * one that would be easy to get wrong twice:
 *
 *   1. Recording a second time for the same morning **updates** rather than
 *      duplicating. §4.6's consistency figures are computed over one row per
 *      night, and a silent duplicate makes every one of them wrong by an amount
 *      nobody can see.
 *   2. The CHECK constraints reject what the repository would otherwise pass
 *      through — an inverted pair of endpoints, a quality off the Daily Close
 *      scale, a thirty-hour night.
 *   3. A soft-deleted night **frees its morning**. The unique index is partial
 *      on `deleted_at IS NULL`, so a tombstone must not block the correction
 *      that replaces it — which is the whole point of soft-deleting rather than
 *      updating in place.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createSleepRepository } from './sleep.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

suite('sleep repository (§4.6)', () => {
  /* `describe.skipIf` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createSleepRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  it('is idempotent on a replayed client-minted id', async () => {
    const id = newId();
    const first = unwrap(await repo.recordNight({ id, dayKey: '2026-08-30', zone: ZONE, durationHours: '7.5' }));
    const second = unwrap(
      await repo.recordNight({ id, dayKey: '2026-08-30', zone: ZONE, durationHours: '9.0' }),
    );

    /* The replay returns the stored row, not the resent one. §5.7: the write
     * that arrives second is the same write, not a correction. */
    expect(second.durationHours).toBe(first.durationHours);
  });

  it('updates rather than duplicating when the same morning is recorded again', async () => {
    await repo.recordNight({ id: newId(), dayKey: '2026-08-30', zone: ZONE, durationHours: '7.5', quality: 3 });
    const corrected = unwrap(
      await repo.recordNight({ id: newId(), dayKey: '2026-08-30', zone: ZONE, durationHours: '6.0', quality: 2 }),
    );

    expect(corrected.quality).toBe(2);
    expect(unwrap(await repo.nightsBetween('2026-08-01', '2026-08-31'))).toHaveLength(1);
  });

  it('returns nights oldest first, which is the order every consistency figure wants', async () => {
    await repo.recordNight({ id: newId(), dayKey: '2026-08-30', zone: ZONE, durationHours: '7' });
    await repo.recordNight({ id: newId(), dayKey: '2026-08-28', zone: ZONE, durationHours: '8' });
    await repo.recordNight({ id: newId(), dayKey: '2026-08-29', zone: ZONE, durationHours: '6' });

    const nights = unwrap(await repo.nightsBetween('2026-08-01', '2026-08-31'));
    expect(nights.map((night) => night.dayKey)).toEqual(['2026-08-28', '2026-08-29', '2026-08-30']);
  });

  it('finds a single morning, and reports null for one with no record', async () => {
    await repo.recordNight({ id: newId(), dayKey: '2026-08-30', zone: ZONE, durationHours: '7' });
    expect(unwrap(await repo.nightForDay('2026-08-30'))?.dayKey).toBe('2026-08-30');
    /* Null, not an empty night. A morning with no record is unrecorded, and a
     * zero-hour night is a claim the operator did not make. */
    expect(unwrap(await repo.nightForDay('2026-08-29'))).toBeNull();
  });

  it('frees the morning when a night is soft-deleted', async () => {
    const first = newId();
    await repo.recordNight({ id: first, dayKey: '2026-08-30', zone: ZONE, durationHours: '7' });
    unwrap(await repo.deleteNight(first, '2026-08-31T06:00:00.000Z', 'Logged against the wrong morning'));

    /* The tombstone must not block the correction that replaces it — the unique
     * index is partial on `deleted_at IS NULL` for exactly this. */
    const replacement = unwrap(
      await repo.recordNight({ id: newId(), dayKey: '2026-08-30', zone: ZONE, durationHours: '8' }),
    );
    expect(replacement.durationHours).not.toBeNull();
    expect(unwrap(await repo.nightsBetween('2026-08-01', '2026-08-31'))).toHaveLength(1);
  });

  describe('constraints the database enforces', () => {
    it('rejects endpoints in the wrong order', async () => {
      await expect(
        database.$client`
          INSERT INTO sleep_night (id, day_key, zone, bed_at, woke_at)
          VALUES (${newId()}, '2026-08-30', ${ZONE}, '2026-08-30T07:00:00Z', '2026-08-29T23:00:00Z')`,
      ).rejects.toThrow(/sleep_night_ordered/u);
    });

    it('rejects a quality off the Daily Close scale', async () => {
      await expect(
        database.$client`
          INSERT INTO sleep_night (id, day_key, zone, quality)
          VALUES (${newId()}, '2026-08-30', ${ZONE}, 9)`,
      ).rejects.toThrow(/sleep_night_quality_range/u);
    });

    it('rejects a night longer than a day', async () => {
      await expect(
        database.$client`
          INSERT INTO sleep_night (id, day_key, zone, duration_hours)
          VALUES (${newId()}, '2026-08-30', ${ZONE}, 30)`,
      ).rejects.toThrow(/sleep_night_duration_range/u);
    });

    it('rejects a negative waking count', async () => {
      await expect(
        database.$client`
          INSERT INTO sleep_night (id, day_key, zone, wakings)
          VALUES (${newId()}, '2026-08-30', ${ZONE}, -1)`,
      ).rejects.toThrow(/sleep_night_wakings_range/u);
    });
  });
});

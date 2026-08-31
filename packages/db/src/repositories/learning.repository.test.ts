/**
 * Learning, the calendar import, and focus sessions — integration.
 *
 * The core tests cover the parsing and the arithmetic. This covers what only
 * the database can answer, and the interesting one is the third:
 *
 *   1. A re-import updates in place rather than accumulating a copy per read.
 *   2. `importEvents` reports inserts and updates separately, which `ON
 *      CONFLICT` cannot do on its own.
 *   3. **A re-import does not revert the operator's travel correction.** The
 *      importer guesses `is_travel` once; §P5 makes the record the operator's,
 *      and a re-read is not a licence to edit it. This is the assertion that
 *      would still pass if the column were in the `set` clause — except that it
 *      wouldn't, which is the point of writing it down.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createLearningRepository, type ImportEventInput } from './learning.repository';

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

const event = (overrides: Partial<ImportEventInput> = {}): ImportEventInput => ({
  id: newId(),
  source: 'ics',
  externalId: 'standup@example.com',
  calendarName: 'Work',
  title: 'Daily standup',
  location: null,
  startsAt: '2026-08-30T03:30:00.000Z',
  endsAt: '2026-08-30T03:45:00.000Z',
  zone: ZONE,
  isAllDay: false,
  isAccepted: true,
  attendeeCount: 2,
  isTravel: false,
  ...overrides,
});

suite('learning repository (§4.8)', () => {
  /* `describe.skipIf` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createLearningRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  describe('learning items', () => {
    it('is idempotent on a replayed client-minted id', async () => {
      const id = newId();
      const first = unwrap(await repo.createItem({ id, kind: 'book', title: 'DDIA' }));
      const second = unwrap(await repo.createItem({ id, kind: 'book', title: 'Something else' }));
      expect(second.title).toBe(first.title);
      expect(unwrap(await repo.items())).toHaveLength(1);
    });

    it('reads skills back as a list, never as null', async () => {
      const id = newId();
      const item = unwrap(await repo.createItem({ id, kind: 'paper', title: 'Spanner' }));
      expect(item.skills).toEqual([]);
    });

    it('dates a finish, and only a finish', async () => {
      const id = newId();
      await repo.createItem({ id, kind: 'book', title: 'DDIA', totalUnits: 600 });

      const abandoned = unwrap(
        await repo.setProgress({
          id,
          status: 'abandoned',
          completedUnits: 120,
          synthesis: null,
          abandonedReason: 'Overtaken by the thing it was research for',
          at: '2026-08-30T10:00:00.000Z',
        }),
      );
      expect(abandoned.finishedAt).toBeNull();
      expect(abandoned.abandonedReason).toBe('Overtaken by the thing it was research for');

      const finished = unwrap(
        await repo.setProgress({
          id,
          status: 'finished',
          completedUnits: 600,
          synthesis: 'The chapter on consensus was the point.',
          abandonedReason: null,
          at: '2026-09-01T10:00:00.000Z',
        }),
      );
      expect(finished.finishedAt).toBe('2026-09-01T10:00:00.000Z');
      /* A finished book must not still explain why it was put down. */
      expect(finished.abandonedReason).toBeNull();
    });

    it('does not move startedAt on a second in_progress write', async () => {
      const id = newId();
      await repo.createItem({ id, kind: 'course', title: 'Distributed systems' });

      const first = unwrap(
        await repo.setProgress({
          id,
          status: 'in_progress',
          completedUnits: 1,
          synthesis: null,
          abandonedReason: null,
          at: '2026-08-01T10:00:00.000Z',
        }),
      );
      const second = unwrap(
        await repo.setProgress({
          id,
          status: 'in_progress',
          completedUnits: 4,
          synthesis: null,
          abandonedReason: null,
          at: '2026-08-20T10:00:00.000Z',
        }),
      );
      expect(second.startedAt).toBe(first.startedAt);
    });

    it('is stopped by the database from recording more progress than exists', async () => {
      const id = newId();
      await repo.createItem({ id, kind: 'book', title: 'Short', totalUnits: 10 });
      await expect(
        database.$client`UPDATE learning_item SET completed_units = 40 WHERE id = ${id}`,
      ).rejects.toThrow(/learning_item_progress_bounded/u);
    });
  });

  describe('notes', () => {
    it('files a note against the learning item in the shared note table', async () => {
      const itemId = newId();
      await repo.createItem({ id: itemId, kind: 'book', title: 'DDIA' });

      const written = unwrap(
        await repo.addNote({ id: newId(), learningItemId: itemId, content: 'Consensus chapter.' }),
      );
      expect(written.learningItemId).toBe(itemId);

      const all = unwrap(await repo.notes());
      expect(all.map((row) => row.content)).toEqual(['Consensus chapter.']);
    });
  });

  describe('calendar import', () => {
    it('updates in place on re-import rather than duplicating', async () => {
      const first = unwrap(await repo.importEvents([event()], '2026-08-30T10:00:00.000Z'));
      expect(first).toEqual({ inserted: 1, updated: 0 });

      const second = unwrap(
        await repo.importEvents([event({ title: 'Daily standup (moved)' })], '2026-08-31T10:00:00.000Z'),
      );
      expect(second).toEqual({ inserted: 0, updated: 1 });

      const rows = unwrap(
        await repo.eventsBetween('2026-08-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('Daily standup (moved)');
    });

    it('does not revert a travel correction on re-import', async () => {
      unwrap(await repo.importEvents([event({ isTravel: false })], '2026-08-30T10:00:00.000Z'));
      const [imported] = unwrap(
        await repo.eventsBetween('2026-08-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z'),
      );
      if (imported === undefined) throw new Error('nothing imported');

      unwrap(await repo.setTravel(imported.id, true, '2026-08-30T11:00:00.000Z'));

      /* The same file, read again. Every other column is refreshed from it. */
      unwrap(await repo.importEvents([event({ isTravel: false })], '2026-08-31T10:00:00.000Z'));

      const [after] = unwrap(
        await repo.eventsBetween('2026-08-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z'),
      );
      expect(after?.isTravel).toBe(true);
    });

    it('counts inserts and updates separately across a mixed batch', async () => {
      unwrap(await repo.importEvents([event({ externalId: 'a' })], '2026-08-30T10:00:00.000Z'));

      const outcome = unwrap(
        await repo.importEvents(
          [event({ externalId: 'a' }), event({ externalId: 'b' }), event({ externalId: 'c' })],
          '2026-08-31T10:00:00.000Z',
        ),
      );
      expect(outcome).toEqual({ inserted: 2, updated: 1 });
    });

    it('accepts an empty batch without touching the database', async () => {
      expect(unwrap(await repo.importEvents([], '2026-08-30T10:00:00.000Z'))).toEqual({
        inserted: 0,
        updated: 0,
      });
    });
  });

  describe('focus sessions', () => {
    it('records and then ends a session', async () => {
      const id = newId();
      await repo.recordSession({
        id,
        startedAt: '2026-08-30T03:30:00.000Z',
        zone: ZONE,
        dayKey: '2026-08-30',
        label: 'Blueprint',
      });

      const ended = unwrap(await repo.endSession(id, '2026-08-30T05:30:00.000Z', 4, 1));
      expect(ended.endedAt).toBe('2026-08-30T05:30:00.000Z');
      expect(ended.quality).toBe(4);
      expect(ended.interruptions).toBe(1);
    });

    it('is stopped by the database from a quality outside the Daily Close scale', async () => {
      await expect(
        database.$client`
          INSERT INTO focus_session (id, started_at, zone, day_key, quality)
          VALUES (${newId()}, now(), ${ZONE}, '2026-08-30', 9)`,
      ).rejects.toThrow(/focus_session_quality_range/u);
    });

    it('is stopped by the database from ending before it started', async () => {
      await expect(
        database.$client`
          INSERT INTO focus_session (id, started_at, ended_at, zone, day_key)
          VALUES (${newId()}, '2026-08-30T05:00:00Z', '2026-08-30T04:00:00Z', ${ZONE}, '2026-08-30')`,
      ).rejects.toThrow(/focus_session_ordered/u);
    });

    it('windows on the stored day key', async () => {
      await repo.recordSession({
        id: newId(),
        startedAt: '2026-08-30T18:30:00.000Z',
        zone: ZONE,
        /* 18:30 UTC is past midnight in Asia/Kolkata — the reason the key is
         * stored rather than truncated from the instant at query time. */
        dayKey: '2026-08-31',
      });

      expect(unwrap(await repo.sessionsBetween('2026-08-31', '2026-08-31'))).toHaveLength(1);
      expect(unwrap(await repo.sessionsBetween('2026-08-30', '2026-08-30'))).toHaveLength(0);
    });
  });
});

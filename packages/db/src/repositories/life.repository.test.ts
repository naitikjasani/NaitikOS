/**
 * The Life Timeline — integration, against real Postgres.
 *
 * The core tests cover the lane packing and the bounds. This covers the things
 * only the database can answer:
 *
 *   1. **The ordering, the slot range and the significance range are CHECK
 *      constraints, not conventions.** A span that ends before it starts would
 *      draw as a bar of negative width; a slot of 9 would resolve to a CSS
 *      variable that does not exist and render transparent; a significance of 7
 *      would break every marker size. All three are rejected by Postgres, so a
 *      hand-written INSERT during a migration cannot introduce one.
 *   2. **An open span round-trips as open.** `ended_at IS NULL` is the single
 *      most important fact on this table (§10.8's current chapter), and the one
 *      a helpful default would quietly destroy.
 *   3. **A replayed write is a no-op.** §5.7's client-minted ids.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createLifeRepository } from './life.repository';

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

suite('life repository (§10.8)', () => {
  /*
   * `describe.skip` has already established that `db` exists, but TypeScript
   * cannot see through it. Narrowed once here rather than with a non-null
   * assertion at each call site below.
   */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createLifeRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  describe('spans', () => {
    it('round-trips a span with no end as open', async () => {
      const id = newId();
      const saved = unwrap(
        await repo.saveSpan({
          id,
          kind: 'chapter',
          title: 'The current job',
          startedAt: '2024-04-01T00:00:00.000Z',
        }),
      );

      expect(saved.endedAt).toBeNull();
      /* And again on the way back out. A default applied on read would be just
       * as destructive as one applied on write. */
      const [read] = unwrap(await repo.spans());
      expect(read?.endedAt).toBeNull();
    });

    it('closes a span without touching anything else about it', async () => {
      const id = newId();
      await repo.saveSpan({
        id,
        kind: 'chapter',
        title: 'The previous job',
        description: 'Four years.',
        startedAt: '2020-01-06T00:00:00.000Z',
        slot: 3,
      });

      const closed = unwrap(await repo.closeSpan(id, '2024-03-29T00:00:00.000Z', '2026-09-05T10:00:00.000Z'));
      expect(closed.endedAt).toBe('2024-03-29T00:00:00.000Z');
      expect(closed.description).toBe('Four years.');
      expect(closed.slot).toBe(3);
    });

    it('is rejected by the database when a span ends before it starts', async () => {
      await expect(
        database.$client`
          INSERT INTO life_span (id, kind, title, started_at, ended_at)
          VALUES (${newId()}, 'chapter', 'Backwards', '2024-01-01T00:00:00Z', '2023-01-01T00:00:00Z')`,
      ).rejects.toThrow(/life_span_ordered/u);
    });

    it('is rejected by the database for a palette slot the theme does not define', async () => {
      await expect(
        database.$client`
          INSERT INTO life_span (id, kind, title, started_at, slot)
          VALUES (${newId()}, 'era', 'Slot nine', '2024-01-01T00:00:00Z', 9)`,
      ).rejects.toThrow(/life_span_slot_range/u);
    });

    it('is idempotent on a replayed client-minted id', async () => {
      const id = newId();
      const first = unwrap(
        await repo.saveSpan({ id, kind: 'era', title: 'Twenties', startedAt: '2016-04-02T00:00:00.000Z' }),
      );
      const second = unwrap(
        await repo.saveSpan({ id, kind: 'era', title: 'A different name', startedAt: '2016-04-02T00:00:00.000Z' }),
      );

      expect(second.id).toBe(first.id);
      /* The replay returns the stored row, not the resent one. §5.7: the write
       * that arrives second is the same write, not a correction. */
      expect(second.title).toBe('Twenties');
      expect(unwrap(await repo.spans())).toHaveLength(1);
    });

    it('tombstones with a reason and hides the row from reads', async () => {
      const id = newId();
      await repo.saveSpan({ id, kind: 'chapter', title: 'Mistake', startedAt: '2024-01-01T00:00:00.000Z' });

      unwrap(await repo.removeSpan(id, '2026-09-05T10:00:00.000Z', 'Duplicate of the one below.'));
      expect(unwrap(await repo.spans())).toHaveLength(0);

      const rows = await database.$client`SELECT delete_reason FROM life_span WHERE id = ${id}`;
      expect(rows[0]?.['delete_reason']).toBe('Duplicate of the one below.');

      /* Removing it twice is a not-found, not a second tombstone that would
       * overwrite the first reason. */
      expect((await repo.removeSpan(id, '2026-09-05T11:00:00.000Z', 'Again')).ok).toBe(false);
    });
  });

  describe('events', () => {
    it('is rejected by the database for a significance outside 1–5', async () => {
      await expect(
        database.$client`
          INSERT INTO life_event (id, title, occurred_at, significance)
          VALUES (${newId()}, 'Enormous', '2024-01-01T00:00:00Z', 7)`,
      ).rejects.toThrow(/life_event_significance_range/u);
    });

    it('keeps an event when the span it sat in is removed', async () => {
      const spanId = newId();
      const eventId = newId();
      await repo.saveSpan({ id: spanId, kind: 'chapter', title: 'Berlin', startedAt: '2022-01-01T00:00:00.000Z' });
      await repo.saveEvent({ id: eventId, title: 'Moved', occurredAt: '2022-01-04T00:00:00.000Z', spanId, significance: 5 });

      await repo.removeSpan(spanId, '2026-09-05T10:00:00.000Z', 'Merged into the era above.');

      /* §9.4, and the judgement in this repository's header: an event is
       * significant on its own terms, so tidying up a chapter does not delete
       * the record of what happened during it. */
      const events = unwrap(await repo.events());
      expect(events).toHaveLength(1);
      expect(events[0]?.spanId).toBe(spanId);
    });

    it('is idempotent on a replayed client-minted id', async () => {
      const id = newId();
      await repo.saveEvent({ id, title: 'First', occurredAt: '2024-01-01T00:00:00.000Z' });
      const second = unwrap(await repo.saveEvent({ id, title: 'Second', occurredAt: '2024-01-01T00:00:00.000Z' }));

      expect(second.title).toBe('First');
      expect(unwrap(await repo.events())).toHaveLength(1);
    });

    it('tombstones an event with a reason', async () => {
      const id = newId();
      await repo.saveEvent({ id, title: 'Typo', occurredAt: '2024-01-01T00:00:00.000Z' });
      unwrap(await repo.removeEvent(id, '2026-09-05T10:00:00.000Z', 'Entered twice.'));
      expect(unwrap(await repo.events())).toHaveLength(0);
    });
  });
});

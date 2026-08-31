/**
 * Reviews — integration, against real Postgres.
 *
 * `core` covers the period arithmetic and the draft assembly. This covers the
 * four things only the database can answer, all of them protecting the same
 * sentence in §4.12 — "the editing is the value":
 *
 *   1. **A re-draft updates in place and leaves the edit alone.** The whole
 *      point of `review_period_unique` is that a period has one review forever;
 *      the whole point of two content columns is that re-running the drafter
 *      does not cost the operator an hour of writing.
 *   2. **`state = 'complete'` with no edit is rejected by Postgres.** §4.12
 *      says an unedited draft is not a completed review, and a repository habit
 *      is not a guarantee — this one is a CHECK.
 *   3. **A period cannot end before it starts.** A reversed window would make
 *      every figure in the draft unfalsifiable.
 *   4. **Two reviews of the same period collide.** The archive's natural key is
 *      `(kind, period_start)`, and two Augusts is two answers to one question.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { createReviewRepository } from './review.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

const AUGUST_START = '2026-08-01T00:00:00.000Z';
const AUGUST_END = '2026-08-31T23:59:59.999Z';
const JULY_START = '2026-07-01T00:00:00.000Z';
const JULY_END = '2026-07-31T23:59:59.999Z';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

suite('review repository (§4.12)', () => {
  /*
   * `describe.skip` has already established that `db` exists, but TypeScript
   * cannot see through it. Narrowed once here rather than with a non-null
   * assertion at each call site below.
   */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createReviewRepository(database);

  beforeEach(async () => {
    /*
     * Cleared directly rather than through `resetDomainTables`. `review` is not
     * in `RESET_ORDER` yet, and it does not need to be: the table has no foreign
     * keys in either direction, so there is no ordering for the shared helper to
     * own. Adding it there is a one-line change for whoever wires the surface up.
     */
    await database.$client`delete from review`;
  });

  describe('upsertDraft', () => {
    it('updates the existing review of a period rather than adding a second', async () => {
      await repo.upsertDraft({
        id: newId(),
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'First pass.',
        at: '2026-09-01T06:00:00.000Z',
      });

      const second = unwrap(
        await repo.upsertDraft({
          /* A different client-minted id, because the surface re-drafting August
           * does not know a row already exists. The period is the identity. */
          id: newId(),
          kind: 'monthly',
          periodStart: AUGUST_START,
          periodEnd: AUGUST_END,
          draftContent: 'Second pass, after the March correction.',
          at: '2026-09-02T06:00:00.000Z',
        }),
      );

      expect(second.draftContent).toBe('Second pass, after the March correction.');
      expect(unwrap(await repo.all('monthly'))).toHaveLength(1);
    });

    it('never clobbers an edit the operator has already made', async () => {
      const id = newId();
      await repo.upsertDraft({
        id,
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'Machine prose.',
        at: '2026-09-01T06:00:00.000Z',
      });
      await repo.saveEdit({
        id,
        editedContent: 'An hour of the operator writing about August.',
        state: 'complete',
        at: '2026-09-01T20:00:00.000Z',
      });

      const redrafted = unwrap(
        await repo.upsertDraft({
          id: newId(),
          kind: 'monthly',
          periodStart: AUGUST_START,
          periodEnd: AUGUST_END,
          draftContent: 'Machine prose, revised.',
          at: '2026-09-05T06:00:00.000Z',
        }),
      );

      /* P5: the operator's work is not the system's to revert. The draft moves;
       * the edit, the state and the completion date do not. */
      expect(redrafted.draftContent).toBe('Machine prose, revised.');
      expect(redrafted.editedContent).toBe('An hour of the operator writing about August.');
      expect(redrafted.state).toBe('complete');
      expect(redrafted.completedAt).toBe('2026-09-01T20:00:00.000Z');
    });

    it('brings a removed review back, edit intact, when its period is drafted again', async () => {
      const id = newId();
      await repo.upsertDraft({
        id,
        kind: 'weekly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'A week.',
        at: '2026-09-01T06:00:00.000Z',
      });
      await repo.saveEdit({ id, editedContent: 'Worth keeping.', state: 'editing', at: '2026-09-01T07:00:00.000Z' });
      await repo.remove(id, '2026-09-02T06:00:00.000Z', 'Drafted by accident');

      expect(unwrap(await repo.forPeriod('weekly', AUGUST_START))).toBeNull();

      const restored = unwrap(
        await repo.upsertDraft({
          id: newId(),
          kind: 'weekly',
          periodStart: AUGUST_START,
          periodEnd: AUGUST_END,
          draftContent: 'A week, again.',
          at: '2026-09-03T06:00:00.000Z',
        }),
      );

      /* `review_period_unique` is not partial, so the tombstone still owns the
       * period. Undo, per §9.4, rather than an insert that cannot happen. */
      expect(restored.deletedAt).toBeNull();
      expect(restored.editedContent).toBe('Worth keeping.');
    });
  });

  describe('the database constraints', () => {
    it('refuses a complete state with no edit', async () => {
      const id = newId();
      await repo.upsertDraft({
        id,
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'Drafted and never opened.',
        at: '2026-09-01T06:00:00.000Z',
      });

      await expect(
        database.$client`UPDATE review SET state = 'complete' WHERE id = ${id}`,
      ).rejects.toThrow(/review_complete_requires_edit/u);
    });

    it('refuses a period that ends before it starts', async () => {
      await expect(
        database.$client`
          INSERT INTO review (id, kind, period_start, period_end)
          VALUES (${newId()}, 'monthly', ${AUGUST_END}, ${AUGUST_START})`,
      ).rejects.toThrow(/review_period_ordered/u);
    });

    it('refuses a second review of the same kind and period', async () => {
      await repo.upsertDraft({
        id: newId(),
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'The review of August.',
        at: '2026-09-01T06:00:00.000Z',
      });

      await expect(
        database.$client`
          INSERT INTO review (id, kind, period_start, period_end)
          VALUES (${newId()}, 'monthly', ${AUGUST_START}, ${AUGUST_END})`,
      ).rejects.toThrow(/review_period_unique/u);
    });

    it('allows two kinds over the same start, which are different questions', async () => {
      for (const kind of ['weekly', 'monthly'] as const) {
        await repo.upsertDraft({
          id: newId(),
          kind,
          periodStart: AUGUST_START,
          periodEnd: AUGUST_END,
          draftContent: `A ${kind} review.`,
          at: '2026-09-01T06:00:00.000Z',
        });
      }
      expect(unwrap(await repo.all())).toHaveLength(2);
    });
  });

  describe('saveEdit', () => {
    const draft = async (id: string): Promise<void> => {
      await repo.upsertDraft({
        id,
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'Drafted.',
        at: '2026-09-01T06:00:00.000Z',
      });
    };

    it('leaves completedAt null while the review is still being written', async () => {
      const id = newId();
      await draft(id);

      const saved = unwrap(
        await repo.saveEdit({ id, editedContent: 'Half written.', state: 'editing', at: '2026-09-01T20:00:00.000Z' }),
      );
      expect(saved.state).toBe('editing');
      expect(saved.completedAt).toBeNull();
    });

    it('dates the completion when the review is marked complete', async () => {
      const id = newId();
      await draft(id);

      const done = unwrap(
        await repo.saveEdit({ id, editedContent: 'Finished.', state: 'complete', at: '2026-09-02T20:00:00.000Z' }),
      );
      expect(done.completedAt).toBe('2026-09-02T20:00:00.000Z');
    });

    it('clears the completion date when the review is reopened', async () => {
      const id = newId();
      await draft(id);
      await repo.saveEdit({ id, editedContent: 'Finished.', state: 'complete', at: '2026-09-02T20:00:00.000Z' });

      const reopened = unwrap(
        await repo.saveEdit({ id, editedContent: 'Finished, then not.', state: 'editing', at: '2026-09-03T20:00:00.000Z' }),
      );
      /* A completion that was withdrawn must not keep its date in a permanent
       * archive — nobody will remember in year six. */
      expect(reopened.completedAt).toBeNull();
    });

    it('reports not found rather than silently succeeding on an unknown id', async () => {
      const result = await repo.saveEdit({
        id: newId(),
        editedContent: 'Into the void.',
        state: 'editing',
        at: '2026-09-01T20:00:00.000Z',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('reading', () => {
    it('lists newest period first and filters by kind', async () => {
      await repo.upsertDraft({
        id: newId(),
        kind: 'monthly',
        periodStart: JULY_START,
        periodEnd: JULY_END,
        draftContent: 'July.',
        at: '2026-08-01T06:00:00.000Z',
      });
      await repo.upsertDraft({
        id: newId(),
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'August.',
        at: '2026-09-01T06:00:00.000Z',
      });
      await repo.upsertDraft({
        id: newId(),
        kind: 'annual',
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-12-31T23:59:59.999Z',
        draftContent: 'The year.',
        at: '2027-01-01T06:00:00.000Z',
      });

      expect(unwrap(await repo.all()).map((row) => row.draftContent)).toEqual([
        'August.',
        'July.',
        'The year.',
      ]);
      expect(unwrap(await repo.all('annual')).map((row) => row.draftContent)).toEqual(['The year.']);
    });

    it('finds a review by id and by its period', async () => {
      const id = newId();
      await repo.upsertDraft({
        id,
        kind: 'quarterly',
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-09-30T23:59:59.999Z',
        draftContent: 'Q3.',
        at: '2026-10-01T06:00:00.000Z',
      });

      expect(unwrap(await repo.byId(id))?.draftContent).toBe('Q3.');
      expect(unwrap(await repo.forPeriod('quarterly', '2026-07-01T00:00:00.000Z'))?.id).toBe(id);
      expect(unwrap(await repo.forPeriod('monthly', '2026-07-01T00:00:00.000Z'))).toBeNull();
      expect(unwrap(await repo.byId(newId()))).toBeNull();
    });
  });

  describe('remove', () => {
    it('tombstones rather than deleting, and hides the row from every read', async () => {
      const id = newId();
      await repo.upsertDraft({
        id,
        kind: 'monthly',
        periodStart: AUGUST_START,
        periodEnd: AUGUST_END,
        draftContent: 'August.',
        at: '2026-09-01T06:00:00.000Z',
      });

      const removed = unwrap(await repo.remove(id, '2026-09-04T06:00:00.000Z', 'Duplicate'));
      expect(removed.deletedAt).toBe('2026-09-04T06:00:00.000Z');
      expect(unwrap(await repo.byId(id))).toBeNull();
      expect(unwrap(await repo.all())).toEqual([]);

      /* §9.4: nothing is hard-deleted. The prose is still there. */
      const rows = await database.$client`SELECT draft_content FROM review WHERE id = ${id}`;
      expect(rows[0]?.['draft_content']).toBe('August.');
    });

    it('reports not found on an id that is already gone', async () => {
      expect((await repo.remove(newId(), '2026-09-04T06:00:00.000Z', 'Nothing there')).ok).toBe(false);
    });
  });
});

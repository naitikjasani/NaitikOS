/**
 * Saved lines of enquiry — integration, against real Postgres.
 *
 * Two things only a database can prove, and both are the difference between a
 * thread list that means something and one that does not: the `NULLS LAST`
 * ordering, and the CHECK that stops a turn recording an exchange without
 * saying what came of it.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createEnquiryRepository } from './enquiry.repository';
import type { TurnInput } from './enquiry.repository';

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

/** See `social.repository.test.ts` — Drizzle hides the constraint on `cause`. */
async function constraintFrom(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : null;
    const named = cause instanceof Error ? cause : error;
    if (!(named instanceof Error)) return String(named);
    const constraint = (named as { constraint_name?: string }).constraint_name ?? '';
    return `${named.message} ${constraint}`;
  }
  return 'no error raised';
}

const ANSWER = {
  kind: 'temporal',
  paragraphs: [{ template: 'Sleep moved later over the window.', references: [] }],
  omitted: 'Nothing was omitted.',
  answerable: true,
};

suite('enquiry repository (§3.2)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createEnquiryRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  const turn = (over: Partial<TurnInput> & { threadId: string }): TurnInput => ({
    id: newId(),
    question: 'How has my sleep moved?',
    kind: 'temporal',
    windowDays: 90,
    answer: ANSWER,
    omitted: 'Nothing was omitted.',
    problem: null,
    interactionId: null,
    askedAt: '2026-09-06T10:00:00.000Z',
    ...over,
  });

  describe('threads', () => {
    it('stores a thread with no turns', async () => {
      const saved = unwrap(await repo.saveThread({ id: newId(), title: 'Why is my skin worse in winter?', note: null }));

      const [row] = unwrap(await repo.threads());
      expect(row?.id).toBe(saved.id);
      expect(row?.turnCount).toBe(0);
      expect(row?.lastAskedAt).toBeNull();
    });

    it('sorts an unasked thread last, not first', async () => {
      /*
       * The whole of the list's behaviour. Postgres sorts nulls *first* under
       * `DESC` by default, so without `NULLS LAST` a placeholder created six
       * months ago would sit above an enquiry answered this morning.
       */
      const placeholder = unwrap(await repo.saveThread({ id: newId(), title: 'Never asked', note: null }));
      const live = unwrap(await repo.saveThread({ id: newId(), title: 'Asked today', note: null }));
      await repo.addTurn(turn({ threadId: live.id }));

      const rows = unwrap(await repo.threads());
      expect(rows.map((r) => r.id)).toEqual([live.id, placeholder.id]);
    });

    it('orders by most recently asked', async () => {
      const older = unwrap(await repo.saveThread({ id: newId(), title: 'Older', note: null }));
      const newer = unwrap(await repo.saveThread({ id: newId(), title: 'Newer', note: null }));

      await repo.addTurn(turn({ threadId: older.id, askedAt: '2026-06-01T10:00:00.000Z' }));
      await repo.addTurn(turn({ threadId: newer.id, askedAt: '2026-09-01T10:00:00.000Z' }));

      expect(unwrap(await repo.threads()).map((r) => r.title)).toEqual(['Newer', 'Older']);
    });

    it('counts live turns only', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Counting', note: null }));
      const first = unwrap(await repo.addTurn(turn({ threadId: thread.id })));
      await repo.addTurn(turn({ threadId: thread.id, askedAt: '2026-09-07T10:00:00.000Z' }));

      await repo.deleteTurn(first.id, 'asked in the wrong thread', '2026-09-08T00:00:00.000Z');

      expect(unwrap(await repo.threads())[0]?.turnCount).toBe(1);
    });

    it('updates a title without touching lastAskedAt', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'First title', note: null }));
      await repo.addTurn(turn({ threadId: thread.id }));

      unwrap(await repo.saveThread({ id: thread.id, title: 'Better title', note: 'why it matters' }));

      const [row] = unwrap(await repo.threads());
      expect(row?.title).toBe('Better title');
      expect(row?.note).toBe('why it matters');
      // Renaming an enquiry is not pursuing it.
      expect(row?.lastAskedAt).toBe('2026-09-06T10:00:00.000Z');
    });

    it('soft-deletes a thread and leaves its turns pointing at it', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Gone', note: null }));
      await repo.addTurn(turn({ threadId: thread.id }));

      unwrap(await repo.deleteThread(thread.id, 'answered', '2026-09-08T00:00:00.000Z'));

      expect(unwrap(await repo.threads())).toEqual([]);
      expect(unwrap(await repo.turns(thread.id))).toHaveLength(1);
    });

    it('refuses to delete the same thread twice', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Once', note: null }));
      unwrap(await repo.deleteThread(thread.id, null, '2026-09-08T00:00:00.000Z'));

      expect((await repo.deleteThread(thread.id, null, '2026-09-08T00:00:00.000Z')).ok).toBe(false);
    });

    it('reads one thread by id, and null for one that is not there', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Findable', note: null }));

      expect(unwrap(await repo.thread(thread.id))?.title).toBe('Findable');
      expect(unwrap(await repo.thread(newId()))).toBeNull();
    });
  });

  describe('turns', () => {
    it('stores the answer as it came back from the model', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));
      const saved = unwrap(await repo.addTurn(turn({ threadId: thread.id })));

      // Templates and references, not rendered prose. Figures resolve at read
      // time so a correction changes what an old answer renders.
      expect(saved.answer).toEqual(ANSWER);
    });

    it('stamps the thread when a turn is added', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));
      await repo.addTurn(turn({ threadId: thread.id, askedAt: '2026-09-06T10:00:00.000Z' }));

      expect(unwrap(await repo.threads())[0]?.lastAskedAt).toBe('2026-09-06T10:00:00.000Z');
    });

    it('keeps a turn where no answer was produced', async () => {
      // "I asked this and the layer was off" is part of the line of enquiry.
      // Dropping it makes the thread look unpursued.
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));
      const saved = unwrap(
        await repo.addTurn(turn({ threadId: thread.id, answer: null, omitted: null, problem: 'The AI layer is off.' })),
      );

      expect(saved.answer).toBeNull();
      expect(saved.problem).toBe('The AI layer is off.');
    });

    it('refuses a turn with neither an answer nor a problem', async () => {
      // A row that says an exchange happened and will not say what came of it.
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));

      const violated = await constraintFrom(() =>
        repo.addTurn(turn({ threadId: thread.id, answer: null, problem: null })),
      );

      expect(violated).toContain('ask_turn_outcome');
    });

    it('refuses a turn with both an answer and a problem', async () => {
      // Two accounts of one moment.
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));

      const violated = await constraintFrom(() =>
        repo.addTurn(turn({ threadId: thread.id, problem: 'also broken' })),
      );

      expect(violated).toContain('ask_turn_outcome');
    });

    it('refuses a non-positive window', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));

      const violated = await constraintFrom(() => repo.addTurn(turn({ threadId: thread.id, windowDays: 0 })));

      expect(violated).toContain('ask_turn_window_positive');
    });

    it('refuses a turn in no thread', async () => {
      await expect(repo.addTurn(turn({ threadId: newId() }))).rejects.toThrow();
    });

    it('returns turns newest first', async () => {
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));
      for (const askedAt of ['2026-06-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z']) {
        await repo.addTurn(turn({ threadId: thread.id, askedAt }));
      }

      const rows = unwrap(await repo.turns(thread.id));
      expect(rows.map((r) => r.askedAt)).toEqual([
        '2026-09-01T10:00:00.000Z',
        '2026-07-01T10:00:00.000Z',
        '2026-06-01T10:00:00.000Z',
      ]);
    });

    it('does not roll the thread stamp back when an older turn is added', async () => {
      /*
       * Backfilling an old question is legitimate, and it should not make a
       * live enquiry look stale. The stamp is "when was this last pursued",
       * and adding a record of March does not mean March was more recent.
       */
      const thread = unwrap(await repo.saveThread({ id: newId(), title: 'Sleep', note: null }));
      await repo.addTurn(turn({ threadId: thread.id, askedAt: '2026-09-01T10:00:00.000Z' }));
      await repo.addTurn(turn({ threadId: thread.id, askedAt: '2026-03-01T10:00:00.000Z' }));

      expect(unwrap(await repo.threads())[0]?.lastAskedAt).toBe('2026-09-01T10:00:00.000Z');
    });
  });
});

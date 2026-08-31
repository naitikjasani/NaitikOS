/**
 * Work — integration, against real Postgres.
 *
 * The core tests cover the bucketing and the period summary. This covers the
 * three things only the database can answer:
 *
 *   1. **The completion pair is enforced, not merely written.**
 *      `task_completed_together` is a CHECK constraint, so a completion instant
 *      without its day key is rejected by Postgres. A task that is done but
 *      invisible to every per-day query is the exact failure §4.8's joins
 *      cannot tolerate, and a repository habit is not a guarantee.
 *   2. **Reopening clears both halves.** The mirror of (1), and the one a
 *      hand-written UPDATE would get half right.
 *   3. **`skills` reads back as a list, never as null.** `text[]` returns null
 *      when never written, and a null travelling out of the repository would
 *      make every caller handle it.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createWorkRepository } from './work.repository';

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

suite('work repository (§4.8)', () => {
  /*
   * `describe.skipIf` has already established that `db` exists, but TypeScript
   * cannot see through it. Narrowed once here rather than with a non-null
   * assertion at each of the twenty call sites below.
   */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createWorkRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  describe('projects', () => {
    it('is idempotent on a replayed client-minted id', async () => {
      const id = newId();
      const first = unwrap(await repo.createProject({ id, name: 'NaitikOS' }));
      const second = unwrap(await repo.createProject({ id, name: 'A different name entirely' }));

      expect(second.id).toBe(first.id);
      /* The replay returns the stored row, not the resent one. §5.7: the write
       * that arrives second is the same write, not a correction. */
      expect(second.name).toBe('NaitikOS');
      expect(unwrap(await repo.projects())).toHaveLength(1);
    });

    it('dates a project only on a terminal status', async () => {
      const id = newId();
      await repo.createProject({ id, name: 'Blueprint' });

      const paused = unwrap(await repo.setProjectStatus(id, 'paused', '2026-08-30T10:00:00.000Z'));
      expect(paused.endedAt).toBeNull();

      const shipped = unwrap(await repo.setProjectStatus(id, 'shipped', '2026-08-31T10:00:00.000Z'));
      expect(shipped.endedAt).toBe('2026-08-31T10:00:00.000Z');
    });

    it('reports not found rather than silently succeeding on an unknown id', async () => {
      const result = await repo.setProjectStatus(newId(), 'shipped', '2026-08-31T10:00:00.000Z');
      expect(result.ok).toBe(false);
    });
  });

  describe('tasks', () => {
    it('writes both halves of the completion pair', async () => {
      const id = newId();
      await repo.createTask({ id, title: 'Ship the migration' });

      const closed = unwrap(
        await repo.closeTask({
          id,
          status: 'done',
          at: '2026-08-30T18:30:00.000Z',
          dayKey: '2026-08-31',
          zone: ZONE,
        }),
      );

      expect(closed.completedAt).toBe('2026-08-30T18:30:00.000Z');
      /* 18:30 UTC is past midnight in Asia/Kolkata, so the day key is the next
       * day — which is the whole reason it is stored rather than truncated
       * from the instant at query time. */
      expect(closed.completedDayKey).toBe('2026-08-31');
    });

    it('is stopped by the database from writing one half alone', async () => {
      const id = newId();
      await repo.createTask({ id, title: 'Half a completion' });

      await expect(
        database.$client`UPDATE task SET status = 'done', completed_at = now() WHERE id = ${id}`,
      ).rejects.toThrow(/task_completed_together/u);
    });

    it('refuses a done status with no completion at all', async () => {
      await expect(
        database.$client`
          INSERT INTO task (id, title, status) VALUES (${newId()}, 'Done from nowhere', 'done')`,
      ).rejects.toThrow(/task_done_has_completion/u);
    });

    it('clears both halves on reopen', async () => {
      const id = newId();
      await repo.createTask({ id, title: 'Reopened' });
      await repo.closeTask({
        id,
        status: 'dropped',
        at: '2026-08-30T10:00:00.000Z',
        dayKey: '2026-08-30',
        zone: ZONE,
        droppedReason: 'Overtaken by events',
      });

      const reopened = unwrap(await repo.reopenTask(id, '2026-08-31T10:00:00.000Z'));
      expect(reopened.status).toBe('open');
      expect(reopened.completedAt).toBeNull();
      expect(reopened.completedDayKey).toBeNull();
      expect(reopened.droppedReason).toBeNull();
    });

    it('keeps every open task while windowing only the closed ones', async () => {
      const ancient = newId();
      const recent = newId();
      const oldClosed = newId();

      await repo.createTask({ id: ancient, title: 'Open since forever' });
      await repo.createTask({ id: recent, title: 'Closed recently' });
      await repo.createTask({ id: oldClosed, title: 'Closed long ago' });

      await repo.closeTask({ id: recent, status: 'done', at: '2026-08-29T10:00:00.000Z', dayKey: '2026-08-29', zone: ZONE });
      await repo.closeTask({ id: oldClosed, status: 'done', at: '2025-01-05T10:00:00.000Z', dayKey: '2025-01-05', zone: ZONE });

      const rows = unwrap(await repo.tasks('2026-08-01'));
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(ancient);
      expect(ids).toContain(recent);
      expect(ids).not.toContain(oldClosed);
    });

    it('finds closures by day key for the cross-domain join', async () => {
      const id = newId();
      await repo.createTask({ id, title: 'Joined against a bad night' });
      await repo.closeTask({ id, status: 'done', at: '2026-08-29T10:00:00.000Z', dayKey: '2026-08-29', zone: ZONE });

      expect(unwrap(await repo.tasksClosedBetween('2026-08-29', '2026-08-29'))).toHaveLength(1);
      expect(unwrap(await repo.tasksClosedBetween('2026-08-30', '2026-08-31'))).toHaveLength(0);
    });

    it('excludes a dropped task from the closure join', async () => {
      const id = newId();
      await repo.createTask({ id, title: 'Dropped, not done' });
      await repo.closeTask({ id, status: 'dropped', at: '2026-08-29T10:00:00.000Z', dayKey: '2026-08-29', zone: ZONE });

      expect(unwrap(await repo.tasksClosedBetween('2026-08-29', '2026-08-29'))).toHaveLength(0);
    });
  });

  describe('career log', () => {
    it('reads skills back as a list when none were written', async () => {
      const id = newId();
      const written = unwrap(
        await repo.recordCareerEntry(
          { id, kind: 'shipped', title: 'Shipped the outbox', occurredAt: '2026-08-20T12:00:00.000Z' },
          ZONE,
        ),
      );
      expect(written.skills).toEqual([]);
    });

    it('round-trips a skill list', async () => {
      const id = newId();
      const written = unwrap(
        await repo.recordCareerEntry(
          {
            id,
            kind: 'shipped',
            title: 'Bitemporal timeline',
            occurredAt: '2026-08-20T12:00:00.000Z',
            skills: ['Postgres', 'temporal modelling'],
          },
          ZONE,
        ),
      );
      expect(written.skills).toEqual(['Postgres', 'temporal modelling']);
    });

    it('windows on occurredAt, not on when the row was written', async () => {
      await repo.recordCareerEntry(
        { id: newId(), kind: 'shipped', title: 'In', occurredAt: '2026-03-02T12:00:00.000Z' },
        ZONE,
      );
      await repo.recordCareerEntry(
        { id: newId(), kind: 'shipped', title: 'Out', occurredAt: '2025-03-02T12:00:00.000Z' },
        ZONE,
      );

      const rows = unwrap(
        await repo.careerEntriesBetween('2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'),
      );
      expect(rows.map((row) => row.title)).toEqual(['In']);
    });

    it('searches full text without throwing on punctuation a person would type', async () => {
      await repo.recordCareerEntry(
        {
          id: newId(),
          kind: 'shipped',
          title: 'Migrated the outbox to idempotent replay',
          detail: 'Client-minted UUIDv7 keys.',
          occurredAt: '2026-08-20T12:00:00.000Z',
        },
        ZONE,
      );

      expect(unwrap(await repo.searchCareer('outbox'))).toHaveLength(1);
      expect(unwrap(await repo.searchCareer('"idempotent replay"'))).toHaveLength(1);
      /* `to_tsquery` raises a syntax error on an apostrophe and on a bare
       * minus. `websearch_to_tsquery` is what makes a search box survive real
       * typing, and this is the case that proves it: it parses rather than
       * throwing. It also documents a genuinely surprising result — "don't" is
       * an English stop word, so the query reduces to `!'nonexist'`, a pure
       * negation, which matches every row that lacks the excluded term. That is
       * correct full-text semantics rather than a bug, and it is asserted here
       * so nobody "fixes" it into an empty result later. */
      expect(unwrap(await repo.searchCareer("don't -nonexistent"))).toHaveLength(1);
      expect(unwrap(await repo.searchCareer('outbox -idempotent'))).toHaveLength(0);
      /* All stop words reduces to an empty tsquery, which matches nothing. */
      expect(unwrap(await repo.searchCareer('the of and'))).toEqual([]);
      expect(unwrap(await repo.searchCareer('   '))).toEqual([]);
    });
  });
});

/**
 * Training programs — integration, against real Postgres.
 *
 * The core tests cover the adherence arithmetic and block cycling. This covers
 * the one thing only a database can prove, and it is the reason `activate` is a
 * transaction rather than an update: `program_one_active` is a **partial unique
 * index**, so every path that touches `is_active` has to leave at most one row
 * matching its predicate — including the soft-delete path, which is the one
 * that would otherwise fail silently and permanently.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';
import { programAdherence, validateProgram, validateProgramBlock } from '@naitikos/core';
import type { ProgramInput } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createProgramRepository, createProgramWriter } from './program.repository';

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

suite('program repository (§4.1)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const read = createProgramRepository(database);
  const write = createProgramWriter(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  const programOf = (over: Partial<ProgramInput> = {}) =>
    unwrap(validateProgram({ id: newId(), name: `Program ${String(counter)}`, ...over }));

  describe('saving', () => {
    it('stores a program, inactive', async () => {
      // `saveProgram` never sets `is_active`. An upsert that flipped it on
      // would collide with whatever is already active.
      const saved = unwrap(await write.saveProgram(programOf({ name: 'PPL', targetFrequency: 4 })));

      expect(saved.name).toBe('PPL');
      expect(saved.isActive).toBe(false);
      expect(saved.targetFrequency).toBe(4);
      expect(unwrap(await read.active())).toBeNull();
    });

    it('updates without disturbing which program is active', async () => {
      const first = unwrap(await write.saveProgram(programOf({ name: 'PPL' })));
      unwrap(await write.activate(first.id, '2026-09-06T00:00:00.000Z'));

      unwrap(await write.saveProgram({ ...first, name: 'PPL v2', targetFrequency: 5 }));

      const active = unwrap(await read.active());
      expect(active?.id).toBe(first.id);
      expect(active?.name).toBe('PPL v2');
    });
  });

  describe('activation', () => {
    it('makes one program active', async () => {
      const p = unwrap(await write.saveProgram(programOf()));

      unwrap(await write.activate(p.id, '2026-09-06T00:00:00.000Z'));

      expect(unwrap(await read.active())?.id).toBe(p.id);
    });

    it('stands the previous one down rather than colliding with it', async () => {
      /*
       * The whole reason `activate` is a transaction. Setting the new one first
       * would violate `program_one_active` against the old one for the duration
       * of the statement — Postgres checks a unique index per row, and the
       * index was not declared deferrable.
       */
      const first = unwrap(await write.saveProgram(programOf({ name: 'Old' })));
      const second = unwrap(await write.saveProgram(programOf({ name: 'New' })));

      unwrap(await write.activate(first.id, '2026-09-06T00:00:00.000Z'));
      unwrap(await write.activate(second.id, '2026-09-07T00:00:00.000Z'));

      const active = unwrap(await read.active());
      expect(active?.id).toBe(second.id);

      const all = unwrap(await read.all());
      expect(all.filter((row) => row.isActive)).toHaveLength(1);
    });

    it('is idempotent', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      unwrap(await write.activate(p.id, '2026-09-06T00:00:00.000Z'));

      // Standing everything down includes the one about to be raised, so a
      // repeat is not a self-collision.
      unwrap(await write.activate(p.id, '2026-09-07T00:00:00.000Z'));

      expect(unwrap(await read.active())?.id).toBe(p.id);
    });

    it('refuses to activate a program that has ended', async () => {
      // A retired program prefilling the session logger is the bug this guard
      // exists to prevent.
      const p = unwrap(await write.saveProgram(programOf()));
      unwrap(await write.retire(p.id, '2026-08-01T00:00:00.000Z'));

      const result = await write.activate(p.id, '2026-09-06T00:00:00.000Z');
      expect(result.ok).toBe(false);
    });

    it('refuses to activate a program that is not there', async () => {
      expect((await write.activate(newId(), '2026-09-06T00:00:00.000Z')).ok).toBe(false);
    });
  });

  describe('retiring and deleting', () => {
    it('stands a program down when it is retired', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      unwrap(await write.activate(p.id, '2026-09-06T00:00:00.000Z'));

      unwrap(await write.retire(p.id, '2026-09-30T00:00:00.000Z'));

      expect(unwrap(await read.active())).toBeNull();
    });

    it('stands a program down when it is deleted, so activation is not blocked forever', async () => {
      /*
       * The failure this test exists for. `program_one_active`'s predicate is
       * `is_active IS TRUE AND deleted_at IS NULL` — so a soft-deleted active
       * row leaves the index, and a *different* index shape would not. The
       * repository clears the flag anyway, because relying on the predicate
       * means a future change to it silently blocks every activation with a
       * conflict against a program nobody can see.
       */
      const first = unwrap(await write.saveProgram(programOf({ name: 'Deleted' })));
      unwrap(await write.activate(first.id, '2026-09-06T00:00:00.000Z'));
      unwrap(await write.deleteProgram(first.id, 'wrong plan', '2026-09-07T00:00:00.000Z'));

      const second = unwrap(await write.saveProgram(programOf({ name: 'Next' })));
      unwrap(await write.activate(second.id, '2026-09-08T00:00:00.000Z'));

      expect(unwrap(await read.active())?.id).toBe(second.id);
      expect(unwrap(await read.all())).toHaveLength(1);
    });

    it('refuses to delete the same program twice', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      unwrap(await write.deleteProgram(p.id, null, '2026-09-07T00:00:00.000Z'));

      expect((await write.deleteProgram(p.id, null, '2026-09-07T00:00:00.000Z')).ok).toBe(false);
    });
  });

  describe('blocks', () => {
    it('stores blocks and returns them in order', async () => {
      const p = unwrap(await write.saveProgram(programOf()));

      for (const [index, name] of ['Push', 'Pull', 'Legs'].entries()) {
        unwrap(
          await write.saveBlock(
            unwrap(validateProgramBlock({ id: newId(), programId: p.id, name, orderIndex: index })),
          ),
        );
      }

      expect(unwrap(await read.blocksFor(p.id)).map((b) => b.name)).toEqual(['Push', 'Pull', 'Legs']);
    });

    it('keeps a prescription through a round trip', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      const exerciseId = newId();

      unwrap(
        await write.saveBlock(
          unwrap(
            validateProgramBlock({
              id: newId(),
              programId: p.id,
              name: 'Push',
              orderIndex: 0,
              prescription: [{ exerciseId, sets: 4, repRange: '8-12', targetRpe: '8', notes: null }],
            }),
          ),
        ),
      );

      const [block] = unwrap(await read.blocksFor(p.id));
      expect(block?.prescription).toEqual([{ exerciseId, sets: 4, repRange: '8-12', targetRpe: '8', notes: null }]);
    });

    it('refuses two blocks at the same position', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      unwrap(
        await write.saveBlock(unwrap(validateProgramBlock({ id: newId(), programId: p.id, name: 'A', orderIndex: 0 }))),
      );

      await expect(
        write.saveBlock(unwrap(validateProgramBlock({ id: newId(), programId: p.id, name: 'B', orderIndex: 0 }))),
      ).rejects.toThrow();
    });

    it('soft-deletes a block', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      const block = unwrap(
        await write.saveBlock(unwrap(validateProgramBlock({ id: newId(), programId: p.id, name: 'A', orderIndex: 0 }))),
      );

      unwrap(await write.deleteBlock(block.id, null, '2026-09-07T00:00:00.000Z'));

      expect(unwrap(await read.blocksFor(p.id))).toEqual([]);
    });
  });

  describe('adherence inputs', () => {
    it('reports no session days for a program never trained', async () => {
      const p = unwrap(await write.saveProgram(programOf({ targetFrequency: 3 })));

      const days = unwrap(await read.sessionDayKeys(p.id, '2026-09-01', '2026-09-30'));
      expect(days).toEqual([]);

      // The domain still produces a ratio, and it is zero rather than null —
      // "trained nothing against a target of three" is a fact, not a gap.
      const adherence = programAdherence({ targetFrequency: 3 }, days, {
        fromDayKey: '2026-09-01',
        toDayKey: '2026-09-07',
      });
      expect(adherence.sessionsPerformed).toBe(0);
      expect(adherence.ratio).toBe(0);
    });

    it('reads the day in the session zone, not the server zone', async () => {
      /*
       * §5.3. A session started at 23:00 UTC is the *next* day in Asia/Kolkata,
       * and for an adherence count that is the difference between a week of
       * four and a week of three.
       */
      const p = unwrap(await write.saveProgram(programOf()));
      await database.$client`
        insert into workout_session (id, program_id, started_at, zone)
        values (gen_random_uuid(), ${p.id}, '2026-09-06T23:00:00Z', 'Asia/Kolkata')`;

      expect(unwrap(await read.sessionDayKeys(p.id, '2026-09-01', '2026-09-30'))).toEqual(['2026-09-07']);
    });

    it('returns one entry per session, leaving distinctness to the domain', async () => {
      // Two sessions in one day is one training *day*, and `programAdherence`
      // is where that rule lives. A repository that deduplicated would put it
      // in two places.
      const p = unwrap(await write.saveProgram(programOf()));
      for (const at of ['2026-09-06T06:00:00Z', '2026-09-06T18:00:00Z']) {
        await database.$client`
          insert into workout_session (id, program_id, started_at, zone)
          values (gen_random_uuid(), ${p.id}, ${at}, 'Asia/Kolkata')`;
      }

      const days = unwrap(await read.sessionDayKeys(p.id, '2026-09-01', '2026-09-30'));
      expect(days).toHaveLength(2);
      expect(programAdherence({ targetFrequency: 3 }, days, {
        fromDayKey: '2026-09-01',
        toDayKey: '2026-09-07',
      }).sessionsPerformed).toBe(1);
    });

    it('excludes sessions outside the window', async () => {
      const p = unwrap(await write.saveProgram(programOf()));
      for (const at of ['2026-08-01T06:00:00Z', '2026-09-06T06:00:00Z']) {
        await database.$client`
          insert into workout_session (id, program_id, started_at, zone)
          values (gen_random_uuid(), ${p.id}, ${at}, 'Asia/Kolkata')`;
      }

      expect(unwrap(await read.sessionDayKeys(p.id, '2026-09-01', '2026-09-30'))).toEqual(['2026-09-06']);
    });
  });
});

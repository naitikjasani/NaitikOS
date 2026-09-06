/**
 * Training programs, persisted.
 *
 * Small, because a program is a plan rather than a record: it is written rarely,
 * read once at the start of a session, and never queried across. The adherence
 * arithmetic lives in `core/domain/gym/program.ts`; this supplies its two
 * inputs — the program's target, and the days a session actually happened.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Program, ProgramBlock } from '@naitikos/core';
import { conflictError, notFoundError, parsePrescription } from '@naitikos/core';

import type { Database, Executor } from '../client';
import { program, programBlock, workoutSession } from '../schema/body';

function toProgram(row: typeof program.$inferSelect): Program {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    isActive: row.isActive,
    targetFrequency: row.targetFrequency,
  };
}

function toBlock(row: typeof programBlock.$inferSelect): ProgramBlock {
  return {
    id: row.id,
    programId: row.programId,
    name: row.name,
    orderIndex: row.orderIndex,
    // `parsePrescription` is total: a drifted jsonb row yields the entries it
    // can read rather than making the session screen unreachable.
    prescription: parsePrescription(row.prescription),
    notes: row.notes,
  };
}

export type ProgramRepository = {
  /** The one active program, or none. Enforced by `program_one_active`. */
  active(): Promise<Result<Program | null, DomainError>>;
  byId(id: string): Promise<Result<Program | null, DomainError>>;
  all(): Promise<Result<readonly Program[], DomainError>>;
  blocksFor(programId: string): Promise<Result<readonly ProgramBlock[], DomainError>>;
  /** The block the most recent session used, for `nextBlock`. */
  lastPerformedBlockId(programId: string): Promise<Result<string | null, DomainError>>;

  /**
   * The days a session happened, for `programAdherence`.
   *
   * Day keys rather than instants, and distinct is left to `core` — the domain
   * counts training *days*, and a repository that pre-deduplicated would put
   * that rule in two places.
   */
  sessionDayKeys(programId: string, fromDayKey: string, toDayKey: string): Promise<Result<readonly string[], DomainError>>;
};

/** Writes. Separated because `Executor` covers reads and activation needs a transaction. */
export type ProgramWriter = {
  saveProgram(input: Program): Promise<Result<Program, DomainError>>;
  /** Makes one program the active one and stands every other down. */
  activate(id: string, at: string): Promise<Result<Program, DomainError>>;
  /** Ends a program on a day, which also stands it down. */
  retire(id: string, endedAt: string): Promise<Result<Program, DomainError>>;
  deleteProgram(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  saveBlock(input: ProgramBlock): Promise<Result<ProgramBlock, DomainError>>;
  deleteBlock(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;
};

export function createProgramRepository(db: Executor): ProgramRepository {
  return {
    async active() {
      const rows = await db
        .select()
        .from(program)
        .where(and(eq(program.isActive, true), isNull(program.deletedAt)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toProgram(rows[0]));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(program)
        .where(and(eq(program.id, id), isNull(program.deletedAt)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toProgram(rows[0]));
    },

    async all() {
      const rows = await db
        .select()
        .from(program)
        .where(isNull(program.deletedAt))
        // Active first, then most recently started. A retired program from 2029
        // should not sit above the one being run today.
        .orderBy(desc(program.isActive), desc(program.startedAt));
      return ok(rows.map(toProgram));
    },

    async blocksFor(programId) {
      const rows = await db
        .select()
        .from(programBlock)
        .where(and(eq(programBlock.programId, programId), isNull(programBlock.deletedAt)))
        .orderBy(asc(programBlock.orderIndex));
      return ok(rows.map(toBlock));
    },

    async lastPerformedBlockId(programId) {
      const rows = await db
        .select({ blockId: workoutSession.programBlockId })
        .from(workoutSession)
        .where(
          and(
            eq(workoutSession.programId, programId),
            sql`${workoutSession.programBlockId} IS NOT NULL`,
            isNull(workoutSession.deletedAt),
          ),
        )
        .orderBy(desc(workoutSession.startedAt))
        .limit(1);

      return ok(rows[0]?.blockId ?? null);
    },

    async sessionDayKeys(programId, fromDayKey, toDayKey) {
      /*
       * The day key is derived in SQL from `started_at` and the session's own
       * zone, not from the server's. §5.3: a session at 7am in Bangalore and
       * one at 7am in London are different facts, and reading both in the
       * current zone would move one of them across a day boundary — which for
       * an adherence count is the difference between a week of four and a week
       * of three.
       */
      const rows = await db.execute(sql`
        select to_char(started_at at time zone zone, 'YYYY-MM-DD') as day_key
          from workout_session
         where program_id = ${programId}
           and deleted_at is null
           and to_char(started_at at time zone zone, 'YYYY-MM-DD') between ${fromDayKey} and ${toDayKey}
      `);

      const typed = rows as unknown as readonly { day_key: string }[];
      return ok(typed.map((row) => row.day_key));
    },
  };
}

export function createProgramWriter(db: Database): ProgramWriter {
  return {
    async saveProgram(input) {
      const rows = await db
        .insert(program)
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          /* Never set here. `program_one_active` is a partial unique index, and
           * an upsert that flipped this on would collide with whatever is
           * already active — `activate` owns the transition for that reason. */
          isActive: false,
          targetFrequency: input.targetFrequency,
        })
        .onConflictDoUpdate({
          target: program.id,
          set: {
            name: input.name,
            description: input.description,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            targetFrequency: input.targetFrequency,
            updatedAt: sql`now()`,
            version: sql`${program.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('program', input.id) };
      return ok(toProgram(row));
    },

    async activate(id, at) {
      /*
       * Stand everything down, then raise one — in that order, in one
       * transaction.
       *
       * `program_one_active` is a partial unique index on `is_active IS TRUE`,
       * so setting the new one first would violate it against the old one for
       * the duration of the statement. Postgres checks a unique index per row
       * rather than at statement end, and there is no deferring a unique index
       * that was not declared deferrable.
       *
       * The order also fails in the right direction: a crash between the two
       * leaves *no* active program, which the session logger handles (it simply
       * offers no prefill), rather than two, which it does not.
       */
      const written = await db.transaction(async (tx) => {
        await tx
          .update(program)
          .set({ isActive: false, updatedAt: at })
          .where(and(eq(program.isActive, true), isNull(program.deletedAt)));

        const rows = await tx
          .update(program)
          .set({ isActive: true, updatedAt: at })
          .where(and(eq(program.id, id), isNull(program.deletedAt), isNull(program.endedAt)))
          .returning();

        return rows[0];
      });

      if (written === undefined) {
        /*
         * Either it does not exist or it has ended. Both are refusals rather
         * than not-founds from the caller's point of view, and the message says
         * which case is likely — a retired program prefilling the logger is the
         * bug this guard exists to prevent.
         */
        return {
          ok: false,
          error: conflictError('program', 'invalid_state', {
            code: 'program_not_activatable',
            message: 'That program is gone or has already ended. A finished program cannot be the active one.',
          }),
        };
      }

      return ok(toProgram(written));
    },

    async retire(id, endedAt) {
      const rows = await db
        .update(program)
        .set({ endedAt, isActive: false, updatedAt: endedAt })
        .where(and(eq(program.id, id), isNull(program.deletedAt)))
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('program', id) };
      return ok(toProgram(row));
    },

    async deleteProgram(id, reason, at) {
      const rows = await db
        .update(program)
        /* Stood down as well as deleted. A soft-deleted row keeps satisfying a
         * partial index whose predicate it still matches, so leaving
         * `is_active` true would block every future activation with a conflict
         * against a program nobody can see. */
        .set({ deletedAt: at, deleteReason: reason, isActive: false, updatedAt: at })
        .where(and(eq(program.id, id), isNull(program.deletedAt)))
        .returning({ id: program.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('program', id) };
      return ok(undefined);
    },

    async saveBlock(input) {
      const rows = await db
        .insert(programBlock)
        .values({
          id: input.id,
          programId: input.programId,
          name: input.name,
          orderIndex: input.orderIndex,
          prescription: input.prescription,
          notes: input.notes,
        })
        .onConflictDoUpdate({
          target: programBlock.id,
          set: {
            name: input.name,
            orderIndex: input.orderIndex,
            prescription: input.prescription,
            notes: input.notes,
            updatedAt: sql`now()`,
            version: sql`${programBlock.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('program_block', input.id) };
      return ok(toBlock(row));
    },

    async deleteBlock(id, reason, at) {
      const rows = await db
        .update(programBlock)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(programBlock.id, id), isNull(programBlock.deletedAt)))
        .returning({ id: programBlock.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('program_block', id) };
      return ok(undefined);
    },
  };
}

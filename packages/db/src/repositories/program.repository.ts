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
import { parsePrescription } from '@naitikos/core';

import type { Executor } from '../client';
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
  };
}

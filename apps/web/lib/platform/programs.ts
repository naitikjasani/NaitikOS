/**
 * Training programs, assembled — §4.1's "program definition and adherence".
 *
 * ## Adherence is computed per program, not cached
 *
 * The ratio is a subtraction over a set of day keys, and it changes the moment
 * a session is logged. §5.6 reserves materialisation for aggregates over
 * millions of rows; this is a `Set` over a fortnight.
 *
 * ## Nothing here produces a missed session
 *
 * `core/domain/gym/program.ts` states the reasoning and this module honours it:
 * a program is a plan the record is measured against, not a schedule that
 * generates obligations. A red cross for every skipped Tuesday makes the app
 * one the operator stops opening in a bad month — which is precisely the month
 * whose data would have been worth having (§4.0's argument, applied to Gym).
 *
 * So the surface reports performed, intended, and the ratio, and never names a
 * day that did not happen.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Exercise, Program, ProgramAdherence, ProgramBlock } from '@naitikos/core';
import {
  dayKeyInZone,
  isoFromMillis,
  nextBlock,
  programAdherence,
  shiftDayKey,
  systemClock,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createExerciseRepository, createProgramRepository } from '@naitikos/db';

/**
 * The adherence window.
 *
 * Two weeks, matching `/api/gym/program`. Long enough that a frequency target
 * means something and short enough that the figure describes now — one week
 * makes a single missed session read as a third of a failure, and a month
 * averages a deload into the block before it.
 */
export const PROGRAM_WINDOW_DAYS = 14;

export type ProgramSummary = {
  readonly program: Program;
  readonly blockCount: number;
  /** `null` when the program sets no frequency target. */
  readonly adherence: ProgramAdherence | null;
};

export type ProgramsBoard = {
  readonly todayDayKey: string;
  /** Active first, then most recently started. */
  readonly programs: readonly ProgramSummary[];
  readonly windowDays: number;
};

export async function loadPrograms(db: Database, zone: string): Promise<Result<ProgramsBoard, DomainError>> {
  const programs = createProgramRepository(db);

  const all = await programs.all();
  if (!all.ok) return all;

  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const fromDayKey = shiftDayKey(todayDayKey, -(PROGRAM_WINDOW_DAYS - 1)) ?? todayDayKey;

  const summaries: ProgramSummary[] = [];
  for (const program of all.value) {
    const blocks = await programs.blocksFor(program.id);
    if (!blocks.ok) return blocks;

    const days = await programs.sessionDayKeys(program.id, fromDayKey, todayDayKey);
    if (!days.ok) return days;

    summaries.push({
      program,
      blockCount: blocks.value.length,
      /*
       * `null` rather than a zero ratio when no target is set. §8.9 — an
       * absent intention is not a score of nothing, and a program run without
       * a frequency target is a perfectly ordinary way to train.
       */
      adherence:
        program.targetFrequency === null ?
          null
        : programAdherence(program, days.value, { fromDayKey, toDayKey: todayDayKey }),
    });
  }

  return ok({ todayDayKey, programs: summaries, windowDays: PROGRAM_WINDOW_DAYS });
}

export type ProgramDetail = {
  readonly program: Program;
  readonly blocks: readonly ProgramBlock[];
  /** Which block comes next in the cycle, or `null` for a program with none. */
  readonly upcoming: ProgramBlock | null;
  readonly adherence: ProgramAdherence | null;
  readonly windowDays: number;
  /** The library, so a prescription can name an exercise rather than an id. */
  readonly exercises: readonly Exercise[];
};

export async function loadProgram(
  db: Database,
  zone: string,
  programId: string,
): Promise<Result<ProgramDetail | null, DomainError>> {
  const programs = createProgramRepository(db);

  const program = await programs.byId(programId);
  if (!program.ok) return program;
  if (program.value === null) return ok(null);

  const blocks = await programs.blocksFor(programId);
  if (!blocks.ok) return blocks;

  const lastBlockId = await programs.lastPerformedBlockId(programId);
  if (!lastBlockId.ok) return lastBlockId;

  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const fromDayKey = shiftDayKey(todayDayKey, -(PROGRAM_WINDOW_DAYS - 1)) ?? todayDayKey;

  const days = await programs.sessionDayKeys(programId, fromDayKey, todayDayKey);
  if (!days.ok) return days;

  const exercises = await createExerciseRepository(db).all();
  if (!exercises.ok) return exercises;

  return ok({
    program: program.value,
    blocks: blocks.value,
    /*
     * Computed here rather than shown as "block 3 of 5". The cycle wraps, and a
     * block deleted mid-program restarts it rather than stalling — `nextBlock`
     * owns both rules, and a page counting positions would get the second one
     * wrong the first time a block was removed.
     */
    upcoming: nextBlock(blocks.value, lastBlockId.value),
    adherence:
      program.value.targetFrequency === null ?
        null
      : programAdherence(program.value, days.value, { fromDayKey, toDayKey: todayDayKey }),
    windowDays: PROGRAM_WINDOW_DAYS,
    exercises: exercises.value,
  });
}

/**
 * Training programs and adherence — §4.1's "program definition and adherence".
 *
 * ## What a program is here, and what it is not
 *
 * A program is a **plan the record is measured against**, not a schedule that
 * generates obligations. The distinction shows up in one place and it is the
 * whole design: nothing in this file ever produces a "missed session". §4.0's
 * reasoning about the Daily Close applies exactly:
 *
 *   "A system that only accepts complete records trains the user to log nothing
 *    on a bad day, and bad days are the clinically interesting ones."
 *
 * A gym app that shows a red cross for every skipped Tuesday is a gym app the
 * operator stops opening in a bad month — which is precisely the month whose
 * data would have been worth having. So adherence here is **sessions performed
 * over sessions intended**, a ratio, uncapped downwards and reported alongside
 * its inputs so it can never be read as a verdict.
 *
 * ## Why the prescription is `jsonb`
 *
 * `program_block.prescription` is a JSON array rather than a table of rows, and
 * that is a deliberate exception to the "structure gets a table" rule in §9.2.
 * A prescription is *never queried across programs* — no question in the product
 * is "which programs prescribe five sets of squats". It is read whole, exactly
 * once, when a session starts. A join table would buy nothing and cost a
 * migration every time a coach's notation gains a field.
 *
 * The cost is that the shape is validated here, in code, rather than by the
 * database — which is why {@link parsePrescription} is total and returns what it
 * could read rather than throwing on a row it could not.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';

export type Program = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly isActive: boolean;
  /** Sessions per week the program intends. Adherence is measured against this. */
  readonly targetFrequency: number | null;
};

/** One prescribed exercise within a block. */
export type PrescribedExercise = {
  readonly exerciseId: string;
  readonly sets: number | null;
  /** `8-12`, `5`, `AMRAP`. Free text, because notation is personal. */
  readonly repRange: string | null;
  readonly targetRpe: string | null;
  readonly notes: string | null;
};

export type ProgramBlock = {
  readonly id: string;
  readonly programId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly prescription: readonly PrescribedExercise[];
  readonly notes: string | null;
};

/**
 * Read a stored prescription, keeping what is legible.
 *
 * Total by construction. A block whose JSON has drifted — an old shape, a hand
 * edit, a partially migrated row — yields the entries it can parse rather than
 * making the session screen unreachable. A prescription is guidance; losing one
 * line of it is a smaller harm than losing the session.
 */
export function parsePrescription(raw: unknown): readonly PrescribedExercise[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): PrescribedExercise[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;

    const exerciseId = record['exerciseId'];
    if (typeof exerciseId !== 'string' || exerciseId === '') return [];

    const sets = record['sets'];
    const repRange = record['repRange'];
    const targetRpe = record['targetRpe'];
    const notes = record['notes'];

    return [
      {
        exerciseId,
        sets: typeof sets === 'number' && Number.isInteger(sets) && sets > 0 ? sets : null,
        repRange: typeof repRange === 'string' && repRange !== '' ? repRange : null,
        targetRpe: typeof targetRpe === 'string' && targetRpe !== '' ? targetRpe : null,
        notes: typeof notes === 'string' && notes !== '' ? notes : null,
      },
    ];
  });
}

/* -------------------------------------------------------------------------
 * Adherence
 * ---------------------------------------------------------------------- */

export type AdherenceWindow = {
  /** Inclusive. */
  readonly fromDayKey: string;
  /** Inclusive. */
  readonly toDayKey: string;
};

export type ProgramAdherence = {
  readonly sessionsPerformed: number;
  /** Derived from `targetFrequency` and the window's length. */
  readonly sessionsIntended: number | null;
  /**
   * Performed ÷ intended, or `null` when the program sets no target.
   *
   * Uncapped: a week with five sessions against a target of three reports 1.67,
   * not 1. Clamping would hide the case worth noticing — that the operator is
   * training more than they planned, which is the usual prelude to the injury
   * a deload was supposed to prevent.
   */
  readonly ratio: number | null;
  readonly window: AdherenceWindow;
  /** Days in the window. Reported so the ratio can never be read without it. */
  readonly windowDays: number;
};

/**
 * Adherence over a window.
 *
 * Counts **distinct days with a session**, not sessions. Two sessions in one day
 * is one training day, and counting it as two would let a double day paper over
 * a missed one — which is exactly the substitution a frequency target exists to
 * discourage.
 */
export function programAdherence(
  program: Pick<Program, 'targetFrequency'>,
  sessionDayKeys: readonly string[],
  window: AdherenceWindow,
): ProgramAdherence {
  const from = dayKeyIndex(window.fromDayKey);
  const to = dayKeyIndex(window.toDayKey);
  const windowDays = from === null || to === null ? 0 : Math.max(0, to - from + 1);

  const performed = new Set(
    sessionDayKeys.filter((dayKey) => dayKey >= window.fromDayKey && dayKey <= window.toDayKey),
  ).size;

  const weeks = windowDays / 7;
  const intended =
    program.targetFrequency === null || program.targetFrequency <= 0 || windowDays === 0
      ? null
      : program.targetFrequency * weeks;

  return {
    sessionsPerformed: performed,
    sessionsIntended: intended,
    ratio: intended === null || intended === 0 ? null : performed / intended,
    window,
    windowDays,
  };
}

/**
 * Which block comes next.
 *
 * A program cycles its blocks in order — Push A, Pull A, Legs A, Push B — and
 * "next" is simply the one after the last performed. Returns the first block
 * when nothing has been performed, and wraps at the end.
 *
 * @returns `null` for a program with no blocks, which is a program that has been
 *   named but not yet written.
 */
export function nextBlock(
  blocks: readonly ProgramBlock[],
  lastPerformedBlockId: string | null,
): ProgramBlock | null {
  const ordered = [...blocks].sort((a, b) => a.orderIndex - b.orderIndex);
  const first = ordered[0];
  if (first === undefined) return null;
  if (lastPerformedBlockId === null) return first;

  const lastIndex = ordered.findIndex((block) => block.id === lastPerformedBlockId);
  // A block that no longer exists — deleted mid-program — restarts the cycle
  // rather than stalling it.
  if (lastIndex === -1) return first;

  return ordered[(lastIndex + 1) % ordered.length] ?? first;
}

/* =========================================================================
 * Writing a program
 * ====================================================================== */

export type ProgramInput = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly isActive?: boolean;
  readonly targetFrequency?: number | null;
};

export type ProgramBlockInput = {
  readonly id: string;
  readonly programId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly prescription?: readonly PrescribedExercise[];
  readonly notes?: string | null;
};

/**
 * The most sessions a week a target may claim.
 *
 * Fourteen — twice a day, every day. Not a judgement about training, which this
 * system does not make (§10.0); a bound that catches a typed `30` before it
 * becomes a permanently unreachable adherence ratio the operator reads as
 * failure every week for a year.
 */
export const MAX_TARGET_FREQUENCY = 14;

const NAME_MAX = 120;
const NOTES_MAX = 2000;

export function validateProgram(input: ProgramInput): Result<Program, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(validationError('name', 'A program needs a name.'));
  if (name.length > NAME_MAX) {
    return err(validationError('name', `A name is at most ${String(NAME_MAX)} characters.`));
  }

  const description = input.description?.trim() ?? '';
  if (description.length > NOTES_MAX) {
    return err(validationError('description', `Keep the description under ${String(NOTES_MAX)} characters.`));
  }

  const target = input.targetFrequency ?? null;
  if (target !== null && (!Number.isInteger(target) || target < 1 || target > MAX_TARGET_FREQUENCY)) {
    return err(
      validationError(
        'targetFrequency',
        `A weekly target is between 1 and ${String(MAX_TARGET_FREQUENCY)} sessions, or nothing.`,
      ),
    );
  }

  const startedAt = input.startedAt ?? null;
  const endedAt = input.endedAt ?? null;
  if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
    return err(validationError('endedAt', 'A program cannot end before it starts.'));
  }

  /*
   * A finished program cannot be the active one. The database enforces "at most
   * one active" and nothing enforces this, which is the gap that would leave a
   * retired program still prefilling the session logger.
   */
  const isActive = input.isActive ?? false;
  if (isActive && endedAt !== null) {
    return err(validationError('isActive', 'A program that has ended cannot be the active one.'));
  }

  return ok({
    id: input.id,
    name,
    description: description === '' ? null : description,
    startedAt,
    endedAt,
    isActive,
    targetFrequency: target,
  });
}

export function validateProgramBlock(input: ProgramBlockInput): Result<ProgramBlock, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(validationError('name', 'A block needs a name — Push A, Deload.'));
  if (name.length > NAME_MAX) {
    return err(validationError('name', `A name is at most ${String(NAME_MAX)} characters.`));
  }

  if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0) {
    return err(validationError('orderIndex', 'A block\u2019s position is a whole number from zero.'));
  }

  const notes = input.notes?.trim() ?? '';
  if (notes.length > NOTES_MAX) {
    return err(validationError('notes', `Keep the notes under ${String(NOTES_MAX)} characters.`));
  }

  /*
   * The prescription is normalised through `parsePrescription` rather than
   * trusted, even though it arrives typed. It is the one field stored as
   * `jsonb`, so this is the last point at which its shape is checked by
   * anything — the database will accept whatever JSON it is handed.
   */
  const prescription = parsePrescription(input.prescription ?? []);

  return ok({
    id: input.id,
    programId: input.programId,
    name,
    orderIndex: input.orderIndex,
    prescription,
    notes: notes === '' ? null : notes,
  });
}

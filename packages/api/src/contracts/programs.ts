/**
 * Training programs at the wire — §4.1's "program definition and adherence".
 *
 * ## Activation is its own kind, not a field on the program
 *
 * `program` carries `isActive`, and this contract deliberately does not accept
 * it. `program_one_active` is a partial unique index, so making one program
 * active means standing another down — a transition across two rows, in a
 * transaction. A boolean on an upsert would look like it expressed that and
 * would instead produce a constraint violation the first time two programs
 * existed.
 *
 * ## Nothing here accepts an adherence figure
 *
 * No ratio, no session count. Both are derived from the sessions actually
 * logged, and a client that could write one would be a second source of truth
 * for a number the server computes — §9.3(4)'s drift. It would also be the one
 * number in this pillar it is tempting to flatter.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema } from './timeline';

/** One prescribed exercise. Free text throughout, because notation is personal. */
export const prescribedExerciseSchema = z.object({
  exerciseId: uuidSchema,
  sets: z.number().int().min(1).max(50).nullish(),
  /** `8-12`, `5`, `AMRAP`. */
  repRange: z.string().max(40).nullish(),
  targetRpe: z.string().max(20).nullish(),
  notes: z.string().max(500).nullish(),
});

export const programRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  startedAt: instantSchema.nullish(),
  endedAt: instantSchema.nullish(),
  /** Sessions a week. The bound is in `core`; this is the wire's sanity check. */
  targetFrequency: z.number().int().min(1).max(14).nullish(),
});

export const programBlockRequestSchema = z.object({
  id: uuidSchema,
  programId: uuidSchema,
  name: z.string().min(1).max(120),
  orderIndex: z.number().int().min(0).max(200),
  prescription: z.array(prescribedExerciseSchema).max(40).optional(),
  notes: z.string().max(2000).nullish(),
});

export const programDeleteSchema = z.object({
  id: uuidSchema,
  reason: z.string().max(500).nullish(),
});

export const programWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('program'), program: programRequestSchema }),
  z.object({ kind: z.literal('program_activate'), id: uuidSchema }),
  z.object({ kind: z.literal('program_retire'), id: uuidSchema, endedAt: instantSchema }),
  z.object({ kind: z.literal('program_delete'), delete: programDeleteSchema }),
  z.object({ kind: z.literal('block'), block: programBlockRequestSchema }),
  z.object({ kind: z.literal('block_delete'), delete: programDeleteSchema }),
]);

export type ProgramWriteRequest = z.infer<typeof programWriteSchema>;

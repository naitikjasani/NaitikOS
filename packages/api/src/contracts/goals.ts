/**
 * Goal contracts — §4.10.
 *
 * ## Nothing here accepts a progress value, and nothing ever will
 *
 * §9.3(4): "Goals own definitions, not progress." There is no `currentValue`,
 * no `progressRatio` and no `status` field on any schema below except the
 * closing one, because every one of those is derived from observations on read.
 * A contract that accepted a client-computed ratio would be the second source
 * of truth §4.10 exists to prevent — and it would drift within a week.
 *
 * ## A rate target must state its window
 *
 * Enforced here as a shape and again in `core` as a rule. "Gain 0.25 kg a week"
 * is not a question until you say over how long the slope is measured, and a
 * silently defaulted thirty days is a different goal from the one that was set.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema } from './timeline';

export const goalComparatorSchema = z.enum(['at_least', 'at_most', 'rate_of_change']);

export const goalStatusSchema = z.enum(['active', 'achieved', 'abandoned', 'paused', 'superseded']);

export const goalTargetRequestSchema = z
  .object({
    id: uuidSchema,
    /** A registered metric key. `core` rejects unregistered ones on write (§9.2). */
    metricKey: z.string().min(1).max(120),
    comparator: goalComparatorSchema,
    /** Decimal string. §5.3 keeps floats off the path a measured quantity travels. */
    targetValue: z.string().regex(/^-?\d+(\.\d+)?$/u, 'A decimal number.'),
    unit: z.string().max(40),
    windowDays: z.number().int().min(14).max(365).nullish(),
  })
  .refine((target) => target.comparator !== 'rate_of_change' || (target.windowDays ?? null) !== null, {
    message: 'A rate target needs a window. Without one there is no question to answer.',
    path: ['windowDays'],
  });

export const createGoalRequestSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  /** When the goal starts counting. Not defaulted server-side — see `core`. */
  startedAt: instantSchema,
  horizonAt: instantSchema.nullish(),
  /**
   * At least one, capped at four.
   *
   * The cap is a judgement: a goal with six targets is several goals sharing a
   * title, and §4.10's conflict detection cannot say anything useful about a
   * bundle. Splitting it is the right answer and this makes that visible.
   */
  targets: z.array(goalTargetRequestSchema).min(1).max(4),
});

export const closeGoalRequestSchema = z.object({
  id: uuidSchema,
  /** `active` is not closing. Reopening is a separate, deliberate act. */
  status: z.enum(['achieved', 'abandoned', 'paused', 'superseded']),
  /** §4.10's archaeology: why it stopped mattering. */
  closingNote: z.string().max(2000).nullish(),
});

export const goalWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), goal: createGoalRequestSchema }),
  z.object({ kind: z.literal('close'), close: closeGoalRequestSchema }),
]);

export type GoalWriteRequest = z.infer<typeof goalWriteSchema>;
export type CreateGoalRequest = z.infer<typeof createGoalRequestSchema>;

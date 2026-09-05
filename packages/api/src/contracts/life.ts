/**
 * The Life Timeline's write contracts — §10.8.
 *
 * ## Nothing here is derived, and that is the contract
 *
 * Every field on this surface is typed by a person. There is no `zone` because
 * nothing is day-keyed — at a decade of zoom the difference between an evening
 * in Kolkata and the next morning in UTC is a fraction of a pixel, and §5.3's
 * zone requirement exists for facts that are read per day, which none of these
 * are. There is no computed duration, no inferred parent and no suggested
 * significance, because §10.0 keeps the system out of deciding what a phase of
 * someone's life was.
 *
 * ## A delete carries its reason
 *
 * §9.4 soft-deletes with a `delete_reason`, and the reason is required here
 * rather than optional. A tombstone with no reason is indistinguishable in year
 * six from data loss.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema } from './timeline';

export const lifeSpanKindSchema = z.enum(['era', 'chapter']);

/**
 * A palette slot, 1–8.
 *
 * Not a colour. §8.9 gives charts a slot so a theme change repaints everything
 * at once and no span can be given a value that fails contrast in one of the
 * two themes; `life_span_slot_range` enforces the same range in Postgres.
 */
export const paletteSlotSchema = z.number().int().min(1).max(8);

export const lifeSpanRequestSchema = z
  .object({
    id: uuidSchema,
    kind: lifeSpanKindSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    startedAt: instantSchema,
    /** Absent means still running. Never today's date standing in for one. */
    endedAt: instantSchema.nullish(),
    parentId: uuidSchema.nullish(),
    slot: paletteSlotSchema.nullish(),
  })
  .refine((span) => span.kind !== 'era' || (span.parentId ?? null) === null, {
    message: 'An era cannot sit inside another span.',
    path: ['parentId'],
  })
  .refine(
    (span) => (span.endedAt ?? null) === null || span.startedAt <= (span.endedAt ?? span.startedAt),
    {
      /*
       * A cheap first pass only — this compares the strings, which is right for
       * the `Z`-normalised instants the form sends and wrong for two different
       * offsets. `validateSpan` in `core` does the real comparison on parsed
       * instants, and `life_span_ordered` is the guarantee. This one exists so
       * the common mistake is caught at the field.
       */
      message: 'A span cannot end before it started.',
      path: ['endedAt'],
    },
  );

export const closeLifeSpanRequestSchema = z.object({
  id: uuidSchema,
  endedAt: instantSchema,
});

export const lifeEventRequestSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(2000).nullish(),
  /** The day it happened, never the day it was typed. */
  occurredAt: instantSchema,
  spanId: uuidSchema.nullish(),
  /** 1–5. How large it looms, which is the operator's call and nobody else's. */
  significance: z.number().int().min(1).max(5).nullish(),
});

export const lifeDeleteRequestSchema = z.object({
  id: uuidSchema,
  reason: z.string().min(1).max(500),
});

export const lifeWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('span'), span: lifeSpanRequestSchema }),
  z.object({ kind: z.literal('span_close'), close: closeLifeSpanRequestSchema }),
  z.object({ kind: z.literal('event'), event: lifeEventRequestSchema }),
  z.object({ kind: z.literal('span_delete'), span: lifeDeleteRequestSchema }),
  z.object({ kind: z.literal('event_delete'), event: lifeDeleteRequestSchema }),
]);

export type LifeWriteRequest = z.infer<typeof lifeWriteSchema>;
export type LifeSpanRequest = z.infer<typeof lifeSpanRequestSchema>;
export type LifeEventRequest = z.infer<typeof lifeEventRequestSchema>;

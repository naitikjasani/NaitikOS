/**
 * Sleep contracts — §4.6.
 *
 * ## A night is keyed by the morning it ended
 *
 * `dayKey` is the morning, never the evening the night started on. Every
 * per-day join in this system compares a night against the day it produced, so
 * "I slept badly and then had a bad day" is one row against one day key. The
 * alternative is an off-by-one that nothing detects until a correlation comes
 * out backwards, months later, with no way to tell which of the two conventions
 * the historical rows were written under. The schema comment on `sleep_night`
 * states the same rule; this is the wire enforcing it.
 *
 * ## The server does not derive `durationHours` from the endpoints
 *
 * `bedAt` and `wokeAt` are accepted, and `durationHours` is accepted separately
 * and independently. It would be trivial — and wrong — for the route to compute
 * one from the other two when it was omitted: **time in bed is not time asleep.**
 * The gap between them is exactly the sleep latency plus the wakings, both of
 * which this contract also carries, and a derived duration would overstate
 * every single night by that amount. The schema's own comment makes the point
 * about storage; the same argument forbids the derivation at the boundary,
 * because a fabricated figure is no more defensible for having been computed by
 * the server than by the client (P5, §10.0).
 *
 * The consequence is deliberate: a night with two endpoints and no duration
 * stores `null` for the duration and stays honest about it. `timeInBedHours`
 * and `sleepEfficiency` in `core` are how the endpoints get read, and they are
 * named for what they actually measure.
 *
 * ## Every field but the day, the zone and the id is nullish
 *
 * §4.6 puts sleep in the MVP's Daily Close, which asks for a duration and a
 * quality and nothing else. A night captured through the ritual therefore has
 * no timing, no latency and no waking count, and that is a *complete* record of
 * what the operator knows on waking — not a partial one to be nagged about.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

/**
 * What disturbed a night, when something did.
 *
 * Mirrors the `sleep_disturbance` enum. Written out rather than derived from a
 * `core` constant so that the wire contract is readable on its own; the two are
 * kept in step by `sleepWriteSchema` being parsed into `validateSleepNight`,
 * which types the same union.
 */
export const sleepDisturbanceSchema = z.enum([
  'noise',
  'light',
  'temperature',
  'pain',
  'anxiety',
  'bathroom',
  'illness',
  'device',
  'other',
]);

/**
 * Hours slept, as a decimal string.
 *
 * §5.3 keeps floats off the path a measured quantity travels — the column is
 * `numeric` and the value arrives and leaves as a string. Unsigned, because
 * negative sleep is not a thing the range check downstream should have to
 * explain.
 */
export const sleepDurationSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/u, 'Hours slept, as a decimal number.');

export const recordNightRequestSchema = z.object({
  id: uuidSchema,
  /** The morning this night ended, in `zone`. One night per day key. */
  dayKey: dayKeySchema,
  zone: zoneSchema,

  /** Lights out and out of bed. Both optional — see the note above. */
  bedAt: instantSchema.nullish(),
  wokeAt: instantSchema.nullish(),

  /** Asked for directly. Never inferred from `bedAt` and `wokeAt`. */
  durationHours: sleepDurationSchema.nullish(),

  /** 1–5, the same scale as the Daily Close and `body.sleep.quality`. */
  quality: z.number().int().min(1).max(5).nullish(),

  /** How long it took to fall asleep, as estimated on waking. Up to ten hours. */
  latencyMinutes: z.number().int().min(0).max(600).nullish(),

  /** Times woken. A count the operator gives, not a detection. */
  wakings: z.number().int().min(0).max(50).nullish(),

  disturbance: sleepDisturbanceSchema.nullish(),
  disturbanceNote: z.string().max(500).nullish(),

  note: z.string().max(2000).nullish(),
});

/**
 * Deleting a night.
 *
 * Soft, with a reason that is asked for and never required — the same rule
 * tasks use. A row removed because it was a duplicate and a row removed because
 * the operator changed their mind are different facts, and in year three the
 * unreasoned deletion is indistinguishable from an accident.
 */
export const deleteNightRequestSchema = z.object({
  id: uuidSchema,
  reason: z.string().max(200).nullish(),
});

export const sleepWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('night'), night: recordNightRequestSchema }),
  z.object({ kind: z.literal('night_delete'), night: deleteNightRequestSchema }),
]);

export type SleepWriteRequest = z.infer<typeof sleepWriteSchema>;
export type RecordNightRequest = z.infer<typeof recordNightRequestSchema>;
export type DeleteNightRequest = z.infer<typeof deleteNightRequestSchema>;

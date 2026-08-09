/**
 * Gym contracts — §4.1's live logger, at the wire.
 *
 * Same division as `observations.ts`: **Zod checks shape, `core` checks
 * meaning.** A `load` of `"heavy"` dies here; a load of `-5`, an RPE of 7.25, or
 * a side on a bilateral movement dies in `core/domain/gym/session.ts`, where the
 * exercise is in hand and the refusal can explain itself.
 *
 * The temptation to restate the bounds here is worth naming, because it is
 * strong: `reps: z.number().int().max(200)` looks like an obvious win. It is
 * not. `MAX_REPS` would then exist in two places, this copy is the one that goes
 * stale, and the two disagree exactly when someone changes the domain rule and
 * greps for the constant.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema, zoneSchema } from './timeline';
import { decimalStringSchema, offlineEnvelopeSchema } from './observations';

/* =========================================================================
 * Sessions
 * ====================================================================== */

/**
 * Starting a session.
 *
 * The id is **required**, not optional, and that is the offline story rather
 * than a preference: §5.7 wants "a record created offline to have its permanent
 * identity from the moment it exists", and every set queued behind this session
 * references that id before the server has ever heard of it. A server-generated
 * id would make the first set unsendable.
 */
export const startSessionRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  startedAt: instantSchema,
  zone: zoneSchema,
  programId: uuidSchema.nullish(),
  programBlockId: uuidSchema.nullish(),
  title: z.string().max(120).nullish(),
  location: z.string().max(120).nullish(),
  /**
   * Bodyweight at session time, in kilograms.
   *
   * Sent by the client when it knows, so a pull-up session logged in a basement
   * still has the number `volume.ts` needs. Omitted, the server looks up the
   * most recent reading *before the session started* — never the latest one,
   * which would attribute today's weight to a session six weeks ago.
   */
  bodyweightKg: decimalStringSchema.nullish(),
});

export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

export const closeSessionRequestSchema = offlineEnvelopeSchema.extend({
  sessionId: uuidSchema,
  endedAt: instantSchema,
  /** How it felt, 1–5. §4.1 records it as session context. */
  perceivedEffort: z.number().int().min(1).max(5).nullish(),
  notes: z.string().max(2000).nullish(),
});

export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>;

/* =========================================================================
 * Sets
 * ====================================================================== */

export const setKindSchema = z.enum(['working', 'warmup', 'drop', 'failure', 'backoff', 'amrap']);

export const setInputSchema = z.object({
  id: uuidSchema,
  exerciseId: uuidSchema,
  orderIndex: z.number().int().min(0),
  kind: setKindSchema.optional(),
  load: decimalStringSchema.optional(),
  /**
   * The unit *as typed*, kept alongside the canonical kilograms (§9.2:
   * "conversion happens at the edges"). A gym with pound plates types pounds
   * and reads pounds back; the record holds kilograms either way.
   */
  loadUnit: z.string().max(16).optional(),
  reps: z.number().int().min(0).optional(),
  rpe: decimalStringSchema.optional(),
  restSeconds: z.number().int().min(0).optional(),
  supersetGroup: z.number().int().min(0).optional(),
  side: z.enum(['left', 'right']).optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Logging a set.
 *
 * One set per request, not a batch, and the reason is the ritual rather than
 * the protocol: §4.1's logger writes a set the moment it is finished, so that a
 * phone dying between the fourth and fifth set loses nothing. A batch endpoint
 * would invite the client to accumulate — which is the design that loses a
 * session.
 */
export const logSetRequestSchema = offlineEnvelopeSchema.extend({
  sessionId: uuidSchema,
  performedAt: instantSchema,
  zone: zoneSchema,
  set: setInputSchema,
});

export type LogSetRequest = z.infer<typeof logSetRequestSchema>;

/* =========================================================================
 * Reads
 * ====================================================================== */

export const exerciseSearchSchema = z.object({
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const progressionQuerySchema = z.object({
  exerciseId: uuidSchema,
  /** Sessions to look back over. The exercise detail chart's window. */
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * The volume analysis window.
 *
 * Day keys rather than instants, because the answer is "how much did I train
 * this month" and a month is a calendar range in the operator's zone — §5.3
 * again. The zone travels with the query for exactly that resolution.
 */
export const volumeQuerySchema = z.object({
  fromDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD.'),
  toDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD.'),
  zone: zoneSchema,
});

export type VolumeQuery = z.infer<typeof volumeQuerySchema>;

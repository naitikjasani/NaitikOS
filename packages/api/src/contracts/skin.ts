/**
 * Skin and routine contracts — §4.2, §9.2, at the wire.
 *
 * The one thing worth reading before changing anything here: **the protocol
 * block is optional on every field, and nothing in it is required.**
 *
 * §14.2's Finding 9 makes protocol checks "advisory and recorded, never
 * blocking". A required `lighting` would make the *upload* fail when the
 * operator did not know what to answer — turning an advisory into a blocker at
 * the one layer where a blocker is unrecoverable, because the photo is already
 * taken and the moment has passed. Every field below is nullish for that
 * reason, and the compliance score is computed from what was supplied.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';
import { offlineEnvelopeSchema } from './observations';

/* =========================================================================
 * The daily log
 * ====================================================================== */

export const bodyRegionSchema = z.enum(['face', 'chest', 'back', 'shoulders', 'arms', 'neck', 'other']);

export const skinRegionInputSchema = z.object({
  id: uuidSchema,
  region: bodyRegionSchema,
  state: z.number().int().nullish(),
  activeLesionCount: z.number().int().nullish(),
  scarringLevel: z.number().int().nullish(),
  inflammation: z.number().int().nullish(),
  dryness: z.number().int().nullish(),
  oiliness: z.number().int().nullish(),
  note: z.string().max(500).nullish(),
});

export const logSkinStateRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  observedOn: dayKeySchema,
  observedAt: instantSchema,
  zone: zoneSchema,
  overallState: z.number().int().nullish(),
  note: z.string().max(2000).nullish(),
  isFlare: z.boolean().optional(),
  /** Suspected, never asserted (§4.2). Free text, no vocabulary. */
  suspectedTrigger: z.string().max(500).nullish(),
  regions: z.array(skinRegionInputSchema).max(7).optional(),
});

export type LogSkinStateRequest = z.infer<typeof logSkinStateRequestSchema>;

export const skinWindowSchema = z.object({
  fromDayKey: dayKeySchema,
  toDayKey: dayKeySchema,
});

/* =========================================================================
 * Products
 * ====================================================================== */

export const productEventKindSchema = z.enum([
  'introduced',
  'discontinued',
  'repurchased',
  'reaction',
  'finished',
]);

export const logProductEventRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  productId: uuidSchema,
  kind: productEventKindSchema,
  occurredAt: instantSchema,
  zone: zoneSchema,
  reactionDescription: z.string().max(1000).nullish(),
  reactionSeverity: z.enum(['mild', 'moderate', 'severe']).nullish(),
  note: z.string().max(1000).nullish(),
});

export const createProductRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  brand: z.string().max(120).nullish(),
  category: z.string().max(80).nullish(),
  keyIngredients: z.array(z.string().max(80)).max(30).optional(),
  notes: z.string().max(1000).nullish(),
});

/* =========================================================================
 * The routine engine
 * ====================================================================== */

export const routineStatusSchema = z.enum(['done', 'skipped', 'partial']);

export const logRoutineStepRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  routineId: uuidSchema,
  /** Null logs the routine as a whole rather than one of its steps. */
  stepId: uuidSchema.nullish(),
  occurredOn: dayKeySchema,
  completedAt: instantSchema.nullish(),
  zone: zoneSchema,
  status: routineStatusSchema,
  note: z.string().max(500).nullish(),
});

export type LogRoutineStepRequest = z.infer<typeof logRoutineStepRequestSchema>;

export const clearRoutineStepRequestSchema = offlineEnvelopeSchema.extend({
  routineId: uuidSchema,
  stepId: uuidSchema,
  occurredOn: dayKeySchema,
});

export const routineQuerySchema = z.object({
  kind: z.enum(['skincare', 'dental', 'supplement', 'other']).optional(),
  toDayKey: dayKeySchema,
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type RoutineQuery = z.infer<typeof routineQuerySchema>;

/* =========================================================================
 * The capture protocol (§9.8)
 * ====================================================================== */

export const captureDistanceSchema = z.enum(['close', 'medium', 'full']);
export const captureLightingSchema = z.enum([
  'daylight_indirect',
  'daylight_direct',
  'artificial_warm',
  'artificial_cool',
  'mixed',
  'unknown',
]);
export const captureTimeBucketSchema = z.enum([
  'early_morning',
  'morning',
  'midday',
  'afternoon',
  'evening',
  'night',
]);
export const flashStateSchema = z.enum(['on', 'off', 'auto_fired', 'auto_not_fired']);

/**
 * The protocol block, every field optional. See the file header for why.
 */
export const captureProtocolSchema = z.object({
  region: bodyRegionSchema,
  poseId: z.string().max(60).nullish(),
  distance: captureDistanceSchema.nullish(),
  lighting: captureLightingSchema.nullish(),
  timeBucket: captureTimeBucketSchema.nullish(),
  flash: flashStateSchema.nullish(),
  /** Median luminance of the reference region, 0–255. Advisory only. */
  medianLuminance: z.number().min(0).max(255).nullish(),
  alignmentReferenceId: uuidSchema.nullish(),
});

export type CaptureProtocolInput = z.infer<typeof captureProtocolSchema>;

export const photoQuerySchema = z.object({
  region: bodyRegionSchema,
  poseId: z.string().max(60).optional(),
  includeNonCompliant: z.enum(['true', 'false']).optional(),
});

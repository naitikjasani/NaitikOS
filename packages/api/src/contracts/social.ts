/**
 * People and Places at the wire — §3.2's `/life/people` and `/life/places`.
 *
 * ## What is missing from these schemas is the design
 *
 * There is no `email`, no `phone`, no `address`, no closeness score and no year
 * of birth. The schema file records why: this stores facts about the operator's
 * *contact* with people rather than facts about the people, because unlike
 * every other row in this database the subject is not the operator, and that
 * person will never see the row or be able to correct it.
 *
 * A field absent from the contract is a field that cannot be sent, which is a
 * stronger guarantee than a field the repository declines to persist.
 *
 * ## Nothing here accepts a contact status
 *
 * No `isOverdue`, no `daysSince`. Both are derived from the cadence and the
 * last interaction on read, and a client that could write one would be a second
 * source of truth for a figure the server already computes — §9.3(4)'s drift.
 *
 * ## Nothing here accepts a computed travel day
 *
 * Same rule. `travelDays` is a function over visits, and a client that could
 * assert "I was away on the 14th" independently of the visits it sent would be
 * able to make the two disagree.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

/** Mirrors the `relationship_kind` pgEnum. */
export const relationshipKindSchema = z.enum([
  'family',
  'friend',
  'colleague',
  'professional',
  'acquaintance',
  'other',
]);

/** Mirrors the `interaction_kind` pgEnum. */
export const interactionKindSchema = z.enum(['in_person', 'call', 'video', 'message', 'other']);

/** Mirrors the `place_kind` pgEnum. */
export const placeKindSchema = z.enum(['home', 'city', 'country', 'venue', 'workplace', 'other']);

/** Mirrors the `trip_purpose` pgEnum. */
export const tripPurposeSchema = z.enum(['leisure', 'work', 'family', 'medical', 'other']);

export const personRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  relationship: relationshipKindSchema,
  context: z.string().max(500).nullish(),
  /**
   * `--MM-DD`. The shape is checked here and the *validity* in `core`, which is
   * the split that matters: `--02-30` matches this pattern and is not a day,
   * and a regex that knew how long February is would be a calendar written
   * twice.
   */
  birthday: z
    .string()
    .regex(/^--\d{2}-\d{2}$/, 'A birthday is a day and a month, written --MM-DD. The year is not stored.')
    .nullish(),
  cadenceDays: z.number().int().min(1).max(730).nullish(),
});

/**
 * Recording a contact.
 *
 * There is no `dayKey` here, deliberately. The server derives it from
 * `occurredAt` and `zone`, for the same reason `/api/learning` derives a focus
 * session's: a client that could send the pair separately could send them
 * disagreeing, and a contact whose instant and day key point at different days
 * is invisible to exactly the per-day joins it exists to feed.
 */
export const interactionRequestSchema = z.object({
  id: uuidSchema,
  personId: uuidSchema,
  kind: interactionKindSchema,
  occurredAt: instantSchema,
  zone: zoneSchema,
  note: z.string().max(2000).nullish(),
});

export const placeRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  kind: placeKindSchema,
  /** Two letters. Case is normalised in `core`, not here. */
  countryCode: z.string().length(2).nullish(),
  zone: zoneSchema.nullish(),
  /* Strings, never numbers. §5.3's no-floats rule reaches the wire: a
   * coordinate parsed to a JS double and re-serialised is not the coordinate
   * that was sent. */
  latitude: z.string().max(20).nullish(),
  longitude: z.string().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const tripRequestSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(200),
  purpose: tripPurposeSchema,
  startedOn: dayKeySchema,
  endedOn: dayKeySchema.nullish(),
  notes: z.string().max(2000).nullish(),
});

export const visitRequestSchema = z.object({
  id: uuidSchema,
  placeId: uuidSchema,
  tripId: uuidSchema.nullish(),
  arrivedOn: dayKeySchema,
  departedOn: dayKeySchema.nullish(),
  notes: z.string().max(2000).nullish(),
});

/**
 * Deleting anything here.
 *
 * `reason` is optional rather than required. §9.4 argues for *asking* why
 * something was deleted, not for refusing to delete without an explanation —
 * a mandatory reason field is a field that gets filled with "x" within a week,
 * at which point the audit log records nothing and everybody has been
 * inconvenienced.
 */
export const socialDeleteSchema = z.object({
  id: uuidSchema,
  reason: z.string().max(500).nullish(),
});

/** The discriminated write union `/api/social` accepts. */
export const socialWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), person: personRequestSchema }),
  z.object({ kind: z.literal('person_delete'), delete: socialDeleteSchema }),
  z.object({ kind: z.literal('interaction'), interaction: interactionRequestSchema }),
  z.object({ kind: z.literal('interaction_delete'), delete: socialDeleteSchema }),
  z.object({ kind: z.literal('place'), place: placeRequestSchema }),
  z.object({ kind: z.literal('place_delete'), delete: socialDeleteSchema }),
  z.object({ kind: z.literal('trip'), trip: tripRequestSchema }),
  z.object({ kind: z.literal('trip_delete'), delete: socialDeleteSchema }),
  z.object({ kind: z.literal('visit'), visit: visitRequestSchema }),
  z.object({ kind: z.literal('visit_delete'), delete: socialDeleteSchema }),
]);

export type SocialWriteRequest = z.infer<typeof socialWriteSchema>;

/**
 * Mind contracts — §4.7, at the wire.
 *
 * Same division as everywhere else: **Zod checks shape, `core` checks
 * meaning.** An intensity of `"high"` dies here; an intensity of `7`, an
 * episode that ends before it starts, or a consent scope outside `none |
 * journal` dies in `core/domain/mind`, where the refusal can explain itself.
 *
 * ## Two schemas here are stricter than that rule, deliberately
 *
 * `journalEntrySchema` restates the consent enum and `MAX_JOURNAL_CHARACTERS`
 * is *not* restated. The asymmetry is the point. The character cap is a domain
 * bound and belongs in one place; the consent scope is a **security boundary**,
 * and a security boundary is worth checking twice — once at the wire, once in
 * the domain, and once more as a database check constraint. §4.7 calls journal
 * content the most sensitive data in the system, and the cost of the redundancy
 * is one line.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';
import { offlineEnvelopeSchema } from './observations';

/* =========================================================================
 * Anxiety episodes
 * ====================================================================== */

export const logEpisodeRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  startedAt: instantSchema,
  endedAt: instantSchema.nullish(),
  zone: zoneSchema,
  intensity: z.number().int().nullish(),
  physicalSymptoms: z.string().max(500).nullish(),
  /**
   * What the operator believes set it off.
   *
   * Free text with no vocabulary, and there will not be one. A trigger picker
   * would be the system offering a menu of explanations for the operator's own
   * mental state, which §4.7 forbids in the strongest terms it uses anywhere.
   */
  trigger: z.string().max(500).nullish(),
  copingResponse: z.string().max(500).nullish(),
  outcome: z.string().max(500).nullish(),
  note: z.string().max(2000).nullish(),
});

export type LogEpisodeRequest = z.infer<typeof logEpisodeRequestSchema>;

export const closeEpisodeRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  endedAt: instantSchema,
});

/* =========================================================================
 * Journal
 * ====================================================================== */

/** Checked here *and* in the domain *and* in the database. See the header. */
export const journalConsentSchema = z.enum(['none', 'journal']);

export const journalEntrySchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  writtenAt: instantSchema,
  zone: zoneSchema,
  title: z.string().max(200).nullish(),
  content: z.string().min(1),
  promptId: uuidSchema.nullish(),
  moodAtWriting: z.number().int().nullish(),
  aiConsent: journalConsentSchema.optional(),
});

export type JournalEntryRequest = z.infer<typeof journalEntrySchema>;

/* =========================================================================
 * Practices
 * ====================================================================== */

export const practiceKindSchema = z.enum(['meditation', 'breathwork', 'grounding', 'journaling', 'other']);

export const logPracticeRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  kind: practiceKindSchema,
  startedAt: instantSchema,
  zone: zoneSchema,
  durationMinutes: z.number().nullish(),
  method: z.string().max(200).nullish(),
  stateBefore: z.number().int().nullish(),
  stateAfter: z.number().int().nullish(),
  note: z.string().max(2000).nullish(),
});

export type LogPracticeRequest = z.infer<typeof logPracticeRequestSchema>;

/* =========================================================================
 * Reads
 * ====================================================================== */

/**
 * The window for a mood, energy or anxiety trend.
 *
 * Day keys and an explicit zone, not instants. "The last thirty days" is a
 * calendar question in the operator's zone (§5.3), and a server that resolved
 * it in UTC would file every Indian evening under the following date.
 */
export const mindWindowSchema = z.object({
  fromDayKey: dayKeySchema,
  toDayKey: dayKeySchema,
  zone: zoneSchema,
});

export type MindWindowQuery = z.infer<typeof mindWindowSchema>;

/* =========================================================================
 * Medication
 * ====================================================================== */

export const doseKindSchema = z.enum(['taken', 'skipped', 'delayed']);

/**
 * Logging a dose.
 *
 * `scheduledFor` is required and is the dose's identity — the slot, not the
 * moment the operator got round to tapping. The repository dedupes on it, which
 * is what makes a replayed tap one dose rather than two.
 */
export const logDoseRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  medicationId: uuidSchema,
  scheduleId: uuidSchema.nullish(),
  kind: doseKindSchema,
  scheduledFor: instantSchema,
  takenAt: instantSchema.nullish(),
  zone: zoneSchema,
  note: z.string().max(500).nullish(),
});

export type LogDoseRequest = z.infer<typeof logDoseRequestSchema>;

export const adherenceQuerySchema = z.object({
  toDayKey: dayKeySchema,
  zone: zoneSchema,
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type AdherenceQuery = z.infer<typeof adherenceQuerySchema>;

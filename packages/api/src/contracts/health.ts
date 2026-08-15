/**
 * Health core contracts — §4.4.
 *
 * ## Why one union instead of nine routes
 *
 * Vitals, conditions, symptoms, side effects and appointments are five small
 * write paths that share one guard chain, one trace, and one error map. Nine
 * near-identical thirty-line handlers is nine places for that chain to drift —
 * the same argument `registers.ts` makes, and the same conclusion.
 *
 * The reads are separate routes, because they have genuinely different shapes
 * and different cache behaviour.
 *
 * ## Nothing here accepts a computed field
 *
 * No schema below has a `flag` this system derived, a `status` it inferred, or
 * a canonical unit it converted to. Those are all computed server-side from
 * what the operator or the laboratory actually said. A contract that accepted
 * a client-computed flag would be a contract through which a UI bug becomes a
 * permanent clinical record.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema, zoneSchema } from './timeline';
import { offlineEnvelopeSchema } from './observations';

/* =========================================================================
 * Vitals
 * ====================================================================== */

/**
 * A reading. Every measurement is optional; at least one must be present, and
 * blood pressure is all-or-nothing.
 *
 * The pairing rule is enforced in `core` rather than here, because it is a
 * domain rule and §5.0 puts domain rules below the transport. This schema's job
 * is to reject a *shape*; `planVitalReading` rejects a *reading*.
 */
export const vitalReadingRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  observedAt: instantSchema,
  observedZone: zoneSchema,
  systolic: z.number().int().min(50).max(300).nullish(),
  diastolic: z.number().int().min(30).max(200).nullish(),
  restingHeartRate: z.number().int().min(25).max(220).nullish(),
  /** A decimal string. §5.3 bans floats on any path a lab value travels. */
  temperatureCelsius: z
    .string()
    .regex(/^\d{2}(\.\d{1,2})?$/u, 'Degrees Celsius, e.g. 36.8.')
    .nullish(),
  oxygenSaturation: z.number().int().min(50).max(100).nullish(),
});

/* =========================================================================
 * Conditions
 * ====================================================================== */

export const conditionStatusSchema = z.enum(['suspected', 'active', 'remission', 'resolved', 'refuted']);

export const conditionRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  code: z.string().max(40).nullish(),
  codeSystem: z.string().max(40).nullish(),
  status: conditionStatusSchema,
  severity: z.enum(['mild', 'moderate', 'severe']).nullish(),
  diagnosedBy: z.string().max(200).nullish(),
  /**
   * When it *began*, which is not when this form is being filled in.
   *
   * §4.4: "Learning in October that a condition began in March must not rewrite
   * history." This is the validity axis; the transaction axis is set by the
   * server from its own clock and is never client-supplied.
   */
  onsetAt: instantSchema,
  zone: zoneSchema,
  note: z.string().max(2000).nullish(),
});

export const conditionStatusChangeSchema = z.object({
  id: uuidSchema,
  /** The successor row's id. Client-generated, so the change is idempotent. */
  successorId: uuidSchema,
  status: conditionStatusSchema,
  note: z.string().max(2000).nullish(),
});

/* =========================================================================
 * Symptoms and side effects
 * ====================================================================== */

export const symptomRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  bodySite: z.string().max(120).nullish(),
  severity: z.enum(['mild', 'moderate', 'severe']).nullish(),
  intensity: z.number().int().min(1).max(10).nullish(),
  startedAt: instantSchema,
  endedAt: instantSchema.nullish(),
  zone: zoneSchema,
  /** The operator's suspicion, and it stays labelled as one (P5). */
  suspectedTrigger: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
});

export const symptomEndSchema = z.object({ id: uuidSchema, endedAt: instantSchema });

export const sideEffectRequestSchema = z.object({
  id: uuidSchema,
  effect: z.string().min(1).max(200),
  suspectedMedicationId: uuidSchema.nullish(),
  severity: z.enum(['mild', 'moderate', 'severe']).nullish(),
  onsetAt: instantSchema,
  zone: zoneSchema,
  note: z.string().max(2000).nullish(),
});

export const sideEffectReportedSchema = z.object({ id: uuidSchema });

/* =========================================================================
 * Appointments
 * ====================================================================== */

export const appointmentRequestSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(200),
  provider: z.string().max(200).nullish(),
  specialty: z.string().max(120).nullish(),
  location: z.string().max(200).nullish(),
  scheduledFor: instantSchema,
  zone: zoneSchema,
});

export const appointmentQuestionSchema = z.object({
  id: z.string().min(1).max(200),
  question: z.string().min(1).max(600),
  evidence: z.string().max(600),
  source: z.enum(['lab', 'adherence', 'side_effect', 'symptom', 'condition', 'manual']),
  sourceId: z.string().max(200).nullable(),
});

export const appointmentQuestionsSchema = z.object({
  id: uuidSchema,
  /**
   * The whole list, every time.
   *
   * Same reasoning as the routine step list: eight short strings the operator
   * has reordered and edited by hand, and a patch protocol over them would be
   * more code than the thing it patches.
   */
  questions: z.array(appointmentQuestionSchema).max(40),
});

export const visitNotesSchema = z.object({
  id: uuidSchema,
  attendedAt: instantSchema.nullish(),
  postVisitNotes: z.string().max(8000).nullish(),
  outcome: z.string().max(500).nullish(),
  followUpDue: instantSchema.nullish(),
});

/* =========================================================================
 * Lab panels
 * ====================================================================== */

export const labFlagSchema = z.enum([
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'indeterminate',
]);

export const labResultRequestSchema = z.object({
  id: uuidSchema,
  /** The catalogued slug, or null for an analyte with no metric. */
  analyteSlug: z.string().max(60).nullable(),
  printedName: z.string().min(1).max(200),
  /** Decimal string. §5.3: no floats on the path a lab value travels. */
  value: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/u, 'A decimal number, as printed.')
    .nullable(),
  valueText: z.string().max(200).nullish(),
  unit: z.string().max(40).nullable(),
  /**
   * The range **as printed on this report**.
   *
   * §9.2 forbids looking one up: "ranges vary by laboratory and change over
   * time, and a 2027 result compared against a 2035 range is a clinical error."
   */
  referenceLow: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/u)
    .nullish(),
  referenceHigh: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/u)
    .nullish(),
  referenceText: z.string().max(200).nullish(),
  /** As the laboratory flagged it. Absent means unflagged, not normal. */
  flag: labFlagSchema.nullish(),
  confidence: z.number().min(0).max(1),
});

export const labPanelRequestSchema = z.object({
  id: uuidSchema,
  panelName: z.string().min(1).max(200),
  laboratory: z.string().max(200).nullish(),
  orderedBy: z.string().max(200).nullish(),
  collectedAt: instantSchema,
  reportedAt: instantSchema.nullish(),
  zone: zoneSchema,
  /** The document this panel came from, when it came from one (§4.11). */
  documentId: uuidSchema.nullish(),
  results: z.array(labResultRequestSchema).min(1).max(80),
});

/* =========================================================================
 * The union
 * ====================================================================== */

export const healthWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vitals'), reading: vitalReadingRequestSchema }),
  z.object({ kind: z.literal('condition'), condition: conditionRequestSchema }),
  z.object({ kind: z.literal('condition_status'), change: conditionStatusChangeSchema }),
  z.object({ kind: z.literal('symptom'), symptom: symptomRequestSchema }),
  z.object({ kind: z.literal('symptom_end'), end: symptomEndSchema }),
  z.object({ kind: z.literal('side_effect'), sideEffect: sideEffectRequestSchema }),
  z.object({ kind: z.literal('side_effect_reported'), reported: sideEffectReportedSchema }),
  z.object({ kind: z.literal('appointment'), appointment: appointmentRequestSchema }),
  z.object({ kind: z.literal('appointment_questions'), questions: appointmentQuestionsSchema }),
  z.object({ kind: z.literal('visit_notes'), notes: visitNotesSchema }),
  z.object({ kind: z.literal('lab_panel'), panel: labPanelRequestSchema }),
]);

export type HealthWriteRequest = z.infer<typeof healthWriteSchema>;
export type LabPanelRequest = z.infer<typeof labPanelRequestSchema>;
export type VitalReadingRequest = z.infer<typeof vitalReadingRequestSchema>;

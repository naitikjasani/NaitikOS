/**
 * The authoring contracts — §2.1's "no manual database intervention required".
 *
 * ## Why these exist at all, when V1 forbids new features
 *
 * §12's V1 phase says "**No new features.** Use it daily and fix what actually
 * hurts." These are not new features. They are the missing halves of features
 * already shipped, and §2.1's definition of done makes them a prerequisite for
 * the phase rather than an addition to it:
 *
 * > "thirty consecutive days of real use by the operator, with a Compounding
 * > Days count of ≥ 25 and **no manual database intervention required**."
 *
 * As of week 4 the operator had to run SQL to define an evening skincare
 * routine or to put Venlafaxine in the register — and until they do, routine
 * adherence and medication adherence never fire, which means §2.1's *only*
 * insight family produces nothing for the entire validation window.
 *
 * ## Every one of these is deliberately minimal
 *
 * A routine is a name, a period and an ordered list of labels. There is no
 * product picker, no reminder configuration, no drag-to-reorder. The test each
 * of these had to pass was "does its absence stop the thirty days from
 * happening", and nothing beyond that is in here.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema, zoneSchema } from './timeline';
import { offlineEnvelopeSchema } from './observations';

/* =========================================================================
 * Routine definition (§9.2)
 * ====================================================================== */

export const routineStepDefinitionSchema = z.object({
  id: uuidSchema,
  label: z.string().min(1).max(120),
  orderIndex: z.number().int().min(0).max(50),
  /** Nice-to-have steps are excluded from both sides of the adherence ratio. */
  isOptional: z.boolean().optional(),
  instructions: z.string().max(500).nullish(),
});

export const defineRoutineRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  kind: z.enum(['skincare', 'dental', 'supplement', 'other']),
  period: z.enum(['am', 'pm', 'midday', 'as_needed']),
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  /** Local `HH:MM`. A wall-clock fact, so it survives a timezone change. */
  expectedAt: z
    .string()
    .regex(/^\d{2}:\d{2}$/u, 'Must be HH:MM.')
    .nullish(),
  /**
   * The whole step list, every time.
   *
   * A full replacement rather than a patch. A routine is five short strings;
   * diffing them client-side to send three operations would be more code than
   * the feature, and the failure mode of a lost patch — a step silently
   * vanishing from an adherence denominator — is much worse than a redundant
   * write.
   */
  steps: z.array(routineStepDefinitionSchema).min(1).max(30),
});

export type DefineRoutineRequest = z.infer<typeof defineRoutineRequestSchema>;

/* =========================================================================
 * The medication register (§4.4, §9.5)
 * ====================================================================== */

export const registerMedicationRequestSchema = offlineEnvelopeSchema.extend({
  id: uuidSchema,
  substance: z.string().min(1).max(120),
  brandName: z.string().max(120).nullish(),
  form: z.enum(['tablet', 'capsule', 'liquid', 'injection', 'topical', 'inhaler', 'patch', 'other']),
  /** Strength per unit, as a decimal string. `150` with unit `mg`. */
  strength: z
    .string()
    .regex(/^\d+(\.\d+)?$/u, 'Must be a positive decimal.')
    .nullish(),
  strengthUnit: z.string().max(16).nullish(),
  indication: z.string().max(200).nullish(),
  prescriber: z.string().max(120).nullish(),
  startedAt: instantSchema,
  /** §4.7's lens: flagged so Mind can present it without a second table. */
  isPsychiatric: z.boolean().optional(),
  zone: zoneSchema,

  /**
   * The dosing schedule, required on registration.
   *
   * Not optional, and that is an adherence decision rather than a data-model
   * one: a medication with no schedule has no denominator, so `expectedDosesPerDay`
   * returns `null` and it never appears in an adherence figure. Registering one
   * without a schedule would produce a row that looks tracked and is not.
   */
  schedule: z.object({
    id: uuidSchema,
    dose: z.string().regex(/^\d+(\.\d+)?$/u, 'Must be a positive decimal.'),
    doseUnit: z.string().min(1).max(16),
    frequency: z.enum(['daily', 'twice_daily', 'three_times_daily', 'four_times_daily', 'as_needed', 'weekly']),
    /** `['08:00']`. Empty falls back to the frequency word. */
    times: z.array(z.string().regex(/^\d{2}:\d{2}$/u)).max(6).optional(),
  }),
});

export type RegisterMedicationRequest = z.infer<typeof registerMedicationRequestSchema>;

/* =========================================================================
 * The crisis plan (§4.7)
 * ====================================================================== */

export const crisisContactSchema = z.object({
  name: z.string().min(1).max(120),
  relationship: z.string().max(80).nullish(),
  phone: z.string().max(40).nullish(),
  notes: z.string().max(200).nullish(),
});

/**
 * The plan.
 *
 * Every field optional except that *something* must be present — a plan with
 * nothing in it is not a plan, and storing one would make
 * `evaluateCrisisState` report `hasPlan: true` and then surface a blank card at
 * the worst possible moment.
 *
 * There is no `aiConsent` field. The column is pinned to `none` by a check
 * constraint and this contract cannot express anything else, which is §10.10's
 * "strictest scope" made structural rather than promised.
 */
export const crisisPlanRequestSchema = offlineEnvelopeSchema
  .extend({
    id: uuidSchema,
    warningSigns: z.string().max(4000).nullish(),
    copingStrategies: z.string().max(4000).nullish(),
    reasonsToLive: z.string().max(4000).nullish(),
    contacts: z.array(crisisContactSchema).max(20).optional(),
    professionalContacts: z.array(crisisContactSchema).max(20).optional(),
  })
  .refine(
    (plan) =>
      hasText(plan.warningSigns) ||
      hasText(plan.copingStrategies) ||
      hasText(plan.reasonsToLive) ||
      (plan.contacts ?? []).length > 0 ||
      (plan.professionalContacts ?? []).length > 0,
    { message: 'A plan needs at least one thing in it.' },
  );

export type CrisisPlanRequest = z.infer<typeof crisisPlanRequestSchema>;

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The reference types — §10.10's central structural control.
 *
 *   "**Numeric fields are references, not values.** The model emits an
 *    observation ID; the application renders the number from the database. The
 *    model is never the source of a figure the user reads."
 *
 * Everything in this file exists to make that sentence enforceable rather than
 * aspirational. An insight schema that carried a `number` would let a fluent,
 * plausible, invented figure reach a person deciding about their own
 * medication. §10.0 names the cost precisely, and it is not an embarrassing
 * output.
 *
 * ## Why this is a separate file
 *
 * So that a future schema cannot quietly grow a numeric field. Adding one means
 * importing something from here or writing `z.number()` by hand, and the second
 * is the thing the lint rule and the review checklist look for. A control that
 * is easy to bypass by accident is not a control.
 */

import { z } from 'zod';

/** A UUID. Every reference below is one, and none of them is a value. */
export const idSchema = z.string().uuid();

/**
 * A pointer at one observation in the log.
 *
 * The model may say *"this observation"*. It may not say *"3.4"*. The
 * application resolves the id against `observation` and renders whatever is
 * actually stored, which means a corrected observation (§9.1 makes a correction
 * a supersession) changes what the user reads without the insight being
 * regenerated.
 */
export const observationRefSchema = z.object({
  kind: z.literal('observation'),
  observationId: idSchema,
});

/**
 * A pointer at a computed statistic.
 *
 * The detector battery produced this number; the model is naming it, not
 * calculating it. `statisticId` addresses a row the application already holds,
 * so the rendered figure and the tested figure are the same object.
 */
export const statisticRefSchema = z.object({
  kind: z.literal('statistic'),
  findingId: idSchema,
  /** Which field of the finding to render — `r`, `n`, `effectSize`, `p`. */
  field: z.enum(['r', 'n', 'p', 'effectSize', 'lagDays', 'windowDays']),
});

/** A pointer at a metric definition, so a unit is rendered from the registry. */
export const metricRefSchema = z.object({
  kind: z.literal('metric'),
  metricKey: z.string().min(1).max(120),
});

/** A pointer at an entity in the graph — a condition, a medication, a food. */
export const entityRefSchema = z.object({
  kind: z.literal('entity'),
  nodeId: idSchema,
});

/** A pointer at a document in the vault. */
export const documentRefSchema = z.object({
  kind: z.literal('document'),
  documentId: idSchema,
});

export const referenceSchema = z.discriminatedUnion('kind', [
  observationRefSchema,
  statisticRefSchema,
  metricRefSchema,
  entityRefSchema,
  documentRefSchema,
]);

export type Reference = z.infer<typeof referenceSchema>;

/**
 * Prose with numbered slots, and no numbers in it.
 *
 * The model writes `"{0} has been below {1} on most days since {2}"` and
 * supplies three references. The application substitutes. A model that wanted
 * to assert a figure would have to write it into `template`, which
 * {@link TEMPLATE_FORBIDS_DIGITS} rejects.
 *
 * Digits are refused outright rather than heuristically inspected. "Most of the
 * time a number in prose is fine" is exactly the reasoning that ends with an
 * invented lab value on a screen, and the cost of the strict rule is that the
 * model occasionally has to write "three" instead of "3".
 *
 * The check runs on the template with its **slots removed**, because `{0}` is
 * itself digits. Checking the raw string looks correct, passes a cursory read,
 * and rejects every valid narration in the system — which is how it was found.
 */
const SLOT = /\{(\d+)\}/gu;
const DIGIT = /\d/u;

export const TEMPLATE_FORBIDS_DIGITS =
  'Prose may not contain digits. Numbers are references — emit {0} and a reference, so the application renders the stored value (§10.10).';

export const narrationSchema = z
  .object({
    template: z
      .string()
      .min(1)
      .max(1200)
      .refine((value) => !DIGIT.test(withoutSlots(value)), TEMPLATE_FORBIDS_DIGITS),
    references: z.array(referenceSchema).max(12),
  })
  .refine(
    (value) => slotsIn(value.template).every((index) => index < value.references.length),
    'Every {n} slot must have a reference. An unfilled slot would render as literal braces to the user.',
  );

export type Narration = z.infer<typeof narrationSchema>;

/** The template with `{n}` removed, so the digit check does not see its own syntax. */
function withoutSlots(template: string): string {
  return template.replace(SLOT, '');
}

/** The slot indices a template uses, in order of appearance. */
export function slotsIn(template: string): readonly number[] {
  const found: number[] = [];
  for (const match of template.matchAll(SLOT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const index = Number.parseInt(raw, 10);
    if (Number.isInteger(index)) found.push(index);
  }
  return found;
}

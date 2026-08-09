/**
 * Observation and Daily Close contracts.
 *
 * §5.1: "The same Zod schema validates the form, the route handler, and the
 * domain object. One definition, three enforcement points."
 *
 * ## What these schemas do *not* do
 *
 * They do not check bounds, they do not convert units, and they do not know
 * whether a metric is registered. All of that is `core/observations/write.ts`,
 * because all of it depends on the registry — and a validation rule that needs a
 * database read is not a parse.
 *
 * The division is: **Zod checks shape, `core` checks meaning.** A `value` of
 * `"heavy"` is a shape failure and dies here; a bodyweight of `900` is a meaning
 * failure and dies in `core`. Duplicating the second here would create two
 * sources of truth for the bounds, and the copy in this file would be the one
 * that went stale.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

/* =========================================================================
 * Values
 * ====================================================================== */

/**
 * A decimal, as a string.
 *
 * **A string, never a number**, and this is the single most important line in
 * the file. §5.3: "No floats for weight, dosage, or lab values. A rounding
 * artifact in a medication dosage is unacceptable." `z.number()` here would put
 * every value through an IEEE double before `core` ever sees it, and by then
 * the rounding has already happened — silently, and unrecoverably.
 *
 * The regex is deliberately permissive about *form* (leading `+`, no integer
 * part, an exponent) and strict about *kind*: `NaN` and `Infinity` are not
 * measurements. `core`'s `parseDecimal` re-checks this; the duplication is the
 * §5.1 "three enforcement points" and it is intentional.
 */
export const decimalStringSchema = z
  .string()
  .min(1)
  .max(64, 'Implausibly long for a measurement.')
  .regex(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, 'Must be a decimal number.');

/**
 * A submitted value, discriminated by kind.
 *
 * The discriminant is not ceremony. Without it, "the client sent a string where
 * a boolean belongs" becomes a coercion three layers in rather than a parse
 * failure at the boundary, and the `unit` field would have nowhere to live —
 * which is what makes §9.2's "conversion happens at the edges" expressible at
 * all.
 */
export const observationValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('number'),
    value: decimalStringSchema,
    /** The unit *as measured*. Omitted means the metric's canonical unit. */
    unit: z.string().max(16).optional(),
  }),
  z.object({ kind: z.literal('integer'), value: z.number().int().safe() }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('category'), value: z.string().min(1).max(64) }),
  /**
   * 2000 characters. §4.0 asks for "one free-text line", and a limit an order
   * of magnitude above that is generous without being a place to paste a
   * document — which is what `journal_entry` is for (§4.7).
   */
  z.object({ kind: z.literal('text'), value: z.string().max(2000) }),
]);

/* =========================================================================
 * Writing observations
 * ====================================================================== */

export const observationInputSchema = z.object({
  /** Client-generated UUIDv7 (§5.7). Optional only for server-side writers. */
  id: uuidSchema.optional(),
  metricKey: z
    .string()
    .min(1)
    .max(120)
    /*
     * Dotted lowercase. Not decoration: the key is a primary key that travels
     * in the export (§9.10), and a permissive schema is how `Mind.Mood` and
     * `mind.mood` end up as two metrics with half the history each.
     */
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/, 'Must be a dotted lowercase metric key.'),
  value: observationValueSchema,
  observedAt: instantSchema,
  observedZone: zoneSchema,
  subject: z
    .object({ type: z.string().min(1).max(64), id: uuidSchema })
    .nullish(),
  context: z.record(z.string(), z.unknown()).nullish(),
  confidence: decimalStringSchema.nullish(),
  supersedes: z
    .object({
      id: uuidSchema,
      /** §9.1 keeps both rows forever so the record explains itself. */
      reason: z.string().min(1, 'A correction must say why.').max(500),
    })
    .nullish(),
});

/**
 * The offline envelope every mutation carries (§5.7).
 *
 * Three fields, and each one exists because of a specific failure:
 *
 * - `idempotencyKey` — "the outbox may replay any request any number of times;
 *   the server deduplicates."
 * - `deviceId` — the HLC's tiebreaker, so two of the operator's own devices
 *   writing in the same millisecond still have a total order.
 * - `clientHlc` — what the device believed the clock was, so the server can
 *   merge rather than overwrite, and so §5.8's skew diagnostic has an input.
 */
export const offlineEnvelopeSchema = z.object({
  idempotencyKey: uuidSchema,
  deviceId: uuidSchema,
  /** `<12 hex><4 hex>-<12 hex>`. Absent on a device's very first write. */
  clientHlc: z
    .string()
    .regex(/^[0-9a-f]{12}[0-9a-f]{4}-[0-9a-f]{12}$/, 'Not a valid hybrid logical clock.')
    .optional(),
});

/**
 * A batch write.
 *
 * Capped at 100. A Daily Close is seven, a workout is perhaps sixty, and a
 * wearable import does not come through this endpoint (§2.3 makes it a batch
 * job). The cap is a resource bound on an authenticated endpoint rather than a
 * domain rule — §5.14 treats every input as hostile, including one that arrives
 * with a valid session from a client bug.
 */
export const createObservationsRequestSchema = offlineEnvelopeSchema.extend({
  observations: z.array(observationInputSchema).min(1).max(100),
});

export type CreateObservationsRequest = z.infer<typeof createObservationsRequestSchema>;

/* =========================================================================
 * Reading observations
 * ====================================================================== */

export const observationQuerySchema = z.object({
  /** Comma-separated on the wire; an array here. */
  metricKeys: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.string().min(1)).max(50))
    .optional(),
  from: instantSchema.optional(),
  until: instantSchema.optional(),
  /** `?currentOnly=false` to include superseded rows (§9.1's correction chain). */
  currentOnly: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export type ObservationQueryInput = z.infer<typeof observationQuerySchema>;

/* =========================================================================
 * The Daily Close (§4.0)
 * ====================================================================== */

export const closeAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('metric'),
    metricKey: z.string().min(1).max(120),
    value: observationValueSchema,
  }),
  z.object({ kind: z.literal('medication'), medicationId: uuidSchema, taken: z.boolean() }),
  z.object({ kind: z.literal('note'), text: z.string().max(2000) }),
]);

/**
 * A Close submission.
 *
 * `answers` may be **empty**, and that is load-bearing rather than lenient.
 * §4.0: "Every field is optional. A partial close counts as a close. This is
 * deliberate: a system that rejects incomplete data trains you to skip it
 * entirely on a bad day, and bad days are the most clinically interesting days
 * you have." A `.min(1)` here would quietly repeal that.
 *
 * The `.max(24)` is the §4.0 budget with headroom for medication toggles, as a
 * resource bound rather than as the budget itself — the budget is enforced in
 * `core/close/form.ts`, where it can explain itself.
 */
export const dailyCloseRequestSchema = offlineEnvelopeSchema.extend({
  dayKey: dayKeySchema,
  zone: zoneSchema,
  answers: z.array(closeAnswerSchema).max(24),
});

export type DailyCloseRequest = z.infer<typeof dailyCloseRequestSchema>;

/** `GET /api/close?dayKey=…&zone=…` — the form plus whatever is already recorded. */
export const dailyCloseQuerySchema = z.object({
  dayKey: dayKeySchema,
  zone: zoneSchema,
});

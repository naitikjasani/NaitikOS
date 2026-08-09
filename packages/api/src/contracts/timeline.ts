/**
 * Timeline, event, and media contracts.
 *
 * These parse what arrives over HTTP. That is a *different* job from
 * `validateEventPayload` in `core`, which asserts that an event our own domain
 * constructed matches its registered shape — and the two are complementary
 * rather than redundant. A malformed event produced by a service bug never
 * touches the wire, and only the `core` check catches it; a hostile query string
 * never reaches a service, and only this does.
 *
 * §5.1: "The same Zod schema validates the form, the route handler, and the
 * domain object. One definition, three enforcement points."
 */

import { z } from 'zod';
import type { EventCategory, EventType } from '@naitikos/core';
import {
  EVENT_CATEGORIES,
  EVENT_SOURCES,
  TASK_KINDS,
  TIMELINE_MAX_PAGE_SIZE,
  TIMELINE_PAGE_SIZE,
  isEventType,
  isIanaZone,
} from '@naitikos/core';

/* =========================================================================
 * Primitives
 * ====================================================================== */

/**
 * A UUID.
 *
 * §5.7 has clients generate UUIDv7 ids offline, so an id arriving over the wire
 * is the record's *permanent* identity rather than a server-assigned one. The
 * schema accepts any UUID version: rejecting a v4 would break the seed data and
 * the fixtures, and the version is not a security property.
 */
export const uuidSchema = z.string().uuid('Must be a UUID.');

/**
 * An ISO 8601 instant.
 *
 * `datetime({ offset: true })` accepts `Z` and `+05:30` and rejects a bare local
 * time. That last part matters: §5.3 stores UTC with the zone alongside, and a
 * timestamp with no offset is one whose meaning depends on who is reading it.
 */
export const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO 8601 instant with an offset or Z.' });

/** A `YYYY-MM-DD` day key, in some zone the caller knows about. */
export const dayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date.');

/**
 * An IANA zone name.
 *
 * Delegates to `core`'s validator rather than probing `Intl` here, and the
 * difference is not stylistic. This was an inline
 * `new Intl.DateTimeFormat({ timeZone: value })` probe, which accepts far more
 * than IANA zone names: `IST` (Indian, Irish *or* Israel Standard Time — ICU
 * picks one), `EST` → America/Panama, and `+05:30` **as a zone**, which is
 * precisely the offset-is-not-a-zone confusion §5.3 exists to prevent.
 *
 * One validator, in `core`, where the reasoning is recorded.
 */
export const zoneSchema = z.string().refine(isIanaZone, 'Not a recognised IANA time zone.');

export const eventTypeSchema = z
  .string()
  .refine(isEventType, 'Not a registered event type.')
  .transform((value) => value as EventType);

/**
 * `EVENT_CATEGORIES` is a frozen `readonly EventCategory[]`; `z.enum` wants a
 * non-empty tuple. The assertion is the narrowing, not a widening — the runtime
 * value is exactly the tuple, and `registry.test.ts` asserts it stays non-empty.
 */
export const eventCategorySchema = z.enum(
  EVENT_CATEGORIES as unknown as readonly [EventCategory, ...EventCategory[]],
);

export const eventSourceSchema = z.enum(EVENT_SOURCES);

export const storageTierSchema = z.enum(['public', 'private', 'sensitive']);

export const taskKindSchema = z.enum(TASK_KINDS);

/* =========================================================================
 * Timeline query
 * ====================================================================== */

/**
 * A comma-separated repeated query parameter.
 *
 * `?categories=body,mind` rather than `?categories=body&categories=mind`. One
 * form, parsed one way — accepting both means two code paths and two chances to
 * disagree about which wins.
 */
function commaSeparated<T extends z.ZodType<unknown, string>>(item: T) {
  // Constrained to schemas whose *input* is a string — the pipe target has to
  // accept what the split produces, and an unconstrained `ZodTypeAny` lets a
  // number schema through here and fails at the call site with a much worse
  // message.
  return z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(item).min(1));
}

/**
 * The timeline query, as it arrives on a URL.
 *
 * Every numeric and boolean field is coerced from a string, because a query
 * string has no types. `limit` is clamped here *and* by `normaliseQuery` in
 * `core` — deliberately, because the two protect different callers: this one
 * rejects a hostile URL with a 400, and that one clamps a programmatic caller
 * that never touched HTTP.
 */
export const timelineQuerySchema = z
  .object({
    from: instantSchema.optional(),
    until: instantSchema.optional(),

    categories: commaSeparated(eventCategorySchema).optional(),
    eventTypes: commaSeparated(eventTypeSchema).optional(),

    includeDetail: z.coerce.boolean().optional(),
    clinicalOnly: z.coerce.boolean().optional(),
    withMediaOnly: z.coerce.boolean().optional(),

    /**
     * Free text.
     *
     * Capped at 200 characters. `websearch_to_tsquery` will happily accept a
     * megabyte and spend real CPU on it, and no human types a 200-character
     * search.
     */
    search: z.string().trim().max(200).optional(),

    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: uuidSchema.optional(),

    grouping: z.enum(['none', 'day', 'week', 'month', 'correlation']).optional(),

    /** Keyset cursor — the last `sequence` seen. Not an offset. */
    afterSequence: z.coerce.number().int().nonnegative().optional(),
    direction: z.enum(['forward', 'backward']).optional(),
    limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_PAGE_SIZE).default(TIMELINE_PAGE_SIZE),
  })
  .refine(
    (query) => (query.entityType === undefined) === (query.entityId === undefined),
    { message: 'entityType and entityId must be supplied together.', path: ['entityId'] },
  )
  .refine(
    (query) => query.from === undefined || query.until === undefined || query.from < query.until,
    // An inverted range returns nothing, which reads to the user as "no data" —
    // a wrong answer rather than an error. Better to say so.
    { message: '`from` must be before `until`.', path: ['until'] },
  );

export type TimelineQueryInput = z.infer<typeof timelineQuerySchema>;

/* =========================================================================
 * Publishing an event
 * ====================================================================== */

/**
 * A domain event submitted by a client.
 *
 * Note what is **not** accepted: `eventId`, `capturedAt`, `createdAt`,
 * `sequence`, and `version`. Those are assigned by the emitter and the store.
 * A caller-supplied `createdAt` would let a client claim the server accepted
 * something at a time it did not, and a caller-supplied `sequence` would let it
 * insert itself anywhere in history.
 */
export const eventDraftSchema = z.object({
  eventType: eventTypeSchema,
  occurredAt: instantSchema,
  source: eventSourceSchema,
  subject: z.object({
    type: z.string().trim().min(1).max(64),
    id: uuidSchema,
  }),

  /**
   * Passed through as an opaque record and validated against the registered
   * spec by `core`.
   *
   * Re-declaring each payload shape in Zod would be a second source of truth for
   * the same rule, and ADR 0005's whole cost is that the payload discipline has
   * to hold in exactly one place. The `passthrough`-free `z.record` here bounds
   * the *shape*; `validateEventPayload` enforces the *contents*, including the
   * unknown-key rejection this schema deliberately does not attempt.
   */
  payload: z.record(z.string(), z.unknown()),

  correlationId: uuidSchema.optional(),
  causationId: uuidSchema.nullable().optional(),

  metadata: z
    .object({
      traceId: z.string().max(64).optional(),
      deviceId: z.string().max(64).optional(),
      zone: zoneSchema.optional(),
      clientSchemaVersion: z.string().max(32).optional(),
      hlc: z.string().max(64).optional(),
    })
    // Closed, not passthrough. §5.11's argument applies: "The schema cannot
    // represent user content, which makes leakage impossible rather than
    // prohibited." An open metadata bag is where a caller puts a note.
    .strict()
    .optional(),
});

export type EventDraftInput = z.infer<typeof eventDraftSchema>;

/**
 * A batch publish.
 *
 * Capped at 100. A Daily Close emits a dozen events and an offline drain might
 * carry a few hundred across several batches; one request carrying ten thousand
 * is either a bug or an attempt to hold a transaction open.
 */
export const publishEventsSchema = z.object({
  events: z.array(eventDraftSchema).min(1).max(100),
  /**
   * §5.7: "Idempotency keys on every mutation. The outbox may replay any request
   * any number of times; the server deduplicates."
   */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/* =========================================================================
 * Replay
 * ====================================================================== */

/**
 * A replay request, from `/settings/developer`.
 *
 * `ignoreLedger` is the dangerous one and is therefore explicit rather than
 * implied by `handlerNames`: it re-runs handlers that have already processed
 * these events, which is correct after truncating a projection and wrong at
 * almost every other time.
 */
export const replayRequestSchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  eventTypes: z.array(eventTypeSchema).max(50).optional(),
  handlerNames: z.array(z.string().min(1).max(64)).max(20).optional(),
  batchSize: z.coerce.number().int().min(1).max(2000).optional(),
  ignoreLedger: z.boolean().optional(),
});

/* =========================================================================
 * Media
 * ====================================================================== */

/**
 * A request for an upload slot.
 *
 * The client has already run the pipeline — hashed, compressed, thumbnailed, and
 * for the sensitive tier encrypted — so it knows the content hash and the byte
 * size before it asks. That ordering is what §5.5 requires and it is why this
 * schema can demand a hash rather than computing one server-side.
 */
export const requestUploadSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(128),
    tier: storageTierSchema,
    contentType: z
      .string()
      .regex(/^[a-z]+\/[a-z0-9.+-]+$/i, 'Must be a MIME type.')
      .max(128),
    /** SHA-256, hex, optionally `sha256:`-prefixed. */
    contentHash: z
      .string()
      .regex(/^(?:sha256:)?[0-9a-fA-F]{64}$/, 'Must be a SHA-256 hex digest.'),
    byteSize: z.number().int().positive(),
    capturedOn: dayKeySchema,
    deviceId: z.string().max(64).optional(),

    /** Present for the sensitive tier; the server never sees the unwrapped key. */
    wrappedKey: z.string().max(1024).optional(),
    encryptionAlgorithm: z.string().max(64).optional(),
  })
  .refine((input) => input.tier !== 'sensitive' || input.wrappedKey !== undefined, {
    /**
     * The wire-level counterpart to the pipeline's refusal and the database's
     * `media_object_sensitive_encrypted` check.
     *
     * Three layers saying the same thing is not redundancy here — it is P7's
     * "make it impossible rather than prohibited" applied at each boundary a
     * plaintext body photo could cross.
     */
    message: 'Sensitive-tier media must arrive with a wrapped key (§5.5).',
    path: ['wrappedKey'],
  });

export type RequestUploadInput = z.infer<typeof requestUploadSchema>;

/** Confirming an upload completed. */
export const completeUploadSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  mediaObjectId: uuidSchema,
});

/** Reporting a failed upload, so the entry stays visible rather than vanishing. */
export const failUploadSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  // A code, never a message. §5.13: developer-facing strings only, and a client
  // error message could contain a file path or a filename the user chose.
  errorCode: z.string().trim().min(1).max(64),
});

/** Asking for a signed URL. */
export const signedUrlRequestSchema = z.object({
  mediaObjectId: uuidSchema,
  /** A thumbnail size, when the caller wants the derivative rather than the original. */
  thumbnailLongEdge: z.coerce.number().int().positive().max(4096).optional(),
});

/* =========================================================================
 * Background jobs
 * ====================================================================== */

/**
 * A manual nightly run, from `/settings/developer` (§5.2).
 *
 * `only` exists so a maintainer can re-run one step after fixing it rather than
 * the whole pipeline — which at 11pm, debugging, is the difference between a
 * fifteen-second loop and a fifteen-minute one.
 */
export const runJobSchema = z.object({
  only: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const enqueueTaskSchema = z.object({
  kind: taskKindSchema,
  subject: z.object({ type: z.string().trim().min(1).max(64), id: uuidSchema }),
  notBefore: instantSchema.optional(),
  causationEventId: uuidSchema.optional(),
});

/**
 * The event log, timeline projection, deferred tasks, and upload outbox.
 *
 * See [ADR 0005](../../../../docs/adr/0005-domain-events-as-integration-log.md).
 * The one-line version: this log records *that something happened* and points at
 * the row; it is not a second copy of the row.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import {
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
  searchVector,
} from './columns';
import { mediaObject } from './crosscutting';

/* =========================================================================
 * Enums
 * ====================================================================== */

/** Mirrors `EVENT_SOURCES` in core. Asserted in step by a contract test. */
export const eventSource = pgEnum('event_source', [
  'user',
  'device_import',
  'derivation',
  'document_extraction',
  'model_inference',
  'system',
]);

/** Mirrors `EventCategory` in core. */
export const eventCategory = pgEnum('event_category', [
  'body',
  'mind',
  'clinical',
  'media',
  'life',
  'system',
]);

export const eventSignificance = pgEnum('event_significance', ['primary', 'detail']);

/** Mirrors `TASK_KINDS` in core. */
export const taskKind = pgEnum('task_kind', [
  'thumbnail.generate',
  'embedding.generate',
  'document.extract-text',
  'timeline.reproject',
  'notification.send',
  'ai.summarise',
]);

export const taskStatus = pgEnum('task_status', ['pending', 'running', 'succeeded', 'failed', 'dead']);

/** §5.7's outbox states. `unsynced` is the one the user must be able to see. */
export const outboxStatus = pgEnum('outbox_status', [
  'pending',
  'uploading',
  'uploaded',
  'failed',
  'abandoned',
]);

/* =========================================================================
 * domain_event
 * ====================================================================== */

/**
 * The append-only event log.
 *
 * ## Why `bigserial` and not a UUIDv7 ordering
 *
 * `sequence` is the total order the timeline paginates on and §5.8's sync
 * watermark reads. It must be **gapless and monotonic**, which only a single
 * writer can guarantee — and UUIDv7 cannot, because §5.7 has clients generate
 * ids offline and a phone with a wrong clock would order itself incorrectly
 * against everything else.
 *
 * So the id stays a client-generatable UUIDv7 (§5.7's requirement that "a record
 * created offline has its permanent identity from the moment it exists") and the
 * *ordering* is server-assigned. Two identifiers doing two jobs.
 *
 * ## Immutability
 *
 * Enforced by a trigger in `0006_event_log_immutable`, the same way §9.1's
 * observations are. Drizzle can declare the columns but not the prohibition, and
 * a convention the database does not enforce is one that breaks at 2am in year
 * four.
 */
export const domainEvent = pgTable(
  'domain_event',
  {
    /** Client-generated UUIDv7 (§5.7). The offline identity. */
    id: primaryKey(),

    /**
     * Server-assigned total order.
     *
     * `bigserial` rather than an `integer` sequence: at ~50 events a day the
     * 32-bit ceiling is 117,000 years away, so this is not about exhaustion. It
     * is that a `bigint` cursor never needs a widening migration on a table that
     * is append-only and cannot be rewritten cheaply.
     */
    sequence: bigserial({ mode: 'number' }).notNull(),

    eventType: text().notNull(),
    /** Payload schema version. Upcast on read, never rewritten (`events/migrate.ts`). */
    version: integer().notNull().default(1),

    /* --- The four timestamps (§9.5's reasoning, applied to events) ---- */
    /** When it happened in the world. */
    occurredAt: instant().notNull(),
    /** When the client recorded it. */
    capturedAt: instant().notNull(),
    /** When the server accepted it. */
    createdAt: instant().notNull().default(sql`now()`),

    actorId: text().notNull(),
    source: eventSource().notNull(),

    /** The row this event is about. Polymorphic, as §9.3(3). */
    subjectType: text().notNull(),
    subjectId: reference().notNull(),

    /**
     * Type-specific facts.
     *
     * **References, never authoritative values** (ADR 0005). The rule is
     * asserted structurally by `validateEventPayload` on every publish and by
     * `registry.test.ts` in CI — it cannot be enforced by a column type.
     */
    payload: jsonb().notNull(),

    /** Groups events from one user action. A Daily Close shares one. */
    correlationId: reference().notNull(),
    /** The event that caused this one. Null for a user-initiated root. */
    causationId: reference(),

    /** Bounded context. Never user content (§5.11). */
    metadata: jsonb().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    /* The ordering index. Every replay and every timeline page reads this. */
    uniqueIndex('domain_event_sequence_unique').on(t.sequence),

    /* "What happened that week" — the primary timeline query. */
    index('domain_event_occurred_idx').on(t.occurredAt.desc()),

    /* Replay filtered by type, and the per-type projections. */
    index('domain_event_type_idx').on(t.eventType, t.sequence),

    /* §3.3 R5: "the timeline links back to every entity." */
    index('domain_event_subject_idx').on(t.subjectType, t.subjectId, t.occurredAt.desc()),

    /* One user action's events, for the correlation grouping. */
    index('domain_event_correlation_idx').on(t.correlationId),

    /* Causality chains — "what did this derivation come from". */
    index('domain_event_causation_idx').on(t.causationId).where(sql`${t.causationId} IS NOT NULL`),

    check('domain_event_version_positive', sql`${t.version} >= 1`),
    /* An event cannot cause itself; that would be an infinite chain. */
    check('domain_event_no_self_causation', sql`${t.causationId} IS NULL OR ${t.causationId} <> ${t.id}`),
    /* capturedAt cannot precede occurredAt by more than a day of clock skew —
       §5.8 bounds skew, and a wildly backdated capture is a bug not a backdate. */
    check('domain_event_capture_after_occurrence', sql`${t.capturedAt} >= ${t.occurredAt} - interval '1 day'`),
  ],
);

/* =========================================================================
 * event_dead_letter
 * ====================================================================== */

/**
 * Handler failures after retries are exhausted.
 *
 * §5.16 alerts on this table. A row here means a projection is incomplete or a
 * job was never enqueued — recoverable by replay, and invisible without a place
 * to look.
 *
 * `resolvedAt` rather than deletion: §9.4's "nothing is hard-deleted" applies,
 * and a resolved failure is the record that the problem happened and was fixed.
 */
export const eventDeadLetter = pgTable(
  'event_dead_letter',
  {
    id: primaryKey(),
    ...rowTimestamps,

    eventId: reference()
      .notNull()
      .references(() => domainEvent.id),
    eventType: text().notNull(),
    /** Stable handler name. Renaming a handler is a migration — it keys here. */
    handlerName: text().notNull(),

    attempts: integer().notNull(),
    /** `DomainError.code`. Machine-readable, safe to log (§5.13). */
    errorCode: text().notNull(),
    /** Developer-facing. Never user content. */
    errorMessage: text().notNull(),
    failedAt: instant().notNull(),

    resolvedAt: instant(),
    resolutionNote: text(),
  },
  (t) => [
    /* One live failure per (event, handler). A retry updates rather than
       accumulating a row per attempt, which would bury the signal. */
    uniqueIndex('event_dead_letter_unique')
      .on(t.eventId, t.handlerName)
      .where(sql`${t.resolvedAt} IS NULL`),
    index('event_dead_letter_open_idx').on(t.failedAt.desc()).where(sql`${t.resolvedAt} IS NULL`),
  ],
);

/* =========================================================================
 * event_handled — the idempotency ledger
 * ====================================================================== */

/**
 * Which handlers have processed which events.
 *
 * Consulted only for handlers that declare themselves non-idempotent — which is
 * the default, so forgetting to declare fails safe.
 *
 * A separate table rather than a column on `domain_event`, because the
 * relationship is many-to-many (N handlers per event) and because
 * `domain_event` is immutable: recording a handler outcome on it would require
 * an UPDATE the trigger forbids.
 */
export const eventHandled = pgTable(
  'event_handled',
  {
    eventId: reference()
      .notNull()
      .references(() => domainEvent.id),
    handlerName: text().notNull(),
    handledAt: instant().notNull().default(sql`now()`),
  },
  (t) => [
    /* The composite primary key IS the idempotency guarantee: a second insert
       for the same pair fails, so a concurrent double-dispatch cannot
       double-handle. */
    uniqueIndex('event_handled_pk').on(t.eventId, t.handlerName),
  ],
);

/* =========================================================================
 * timeline_entry — the projection
 * ====================================================================== */

/**
 * The timeline projection.
 *
 * Derived from `domain_event`, and **safe to truncate and rebuild** — that is the
 * property ADR 0005 rule 3 buys. The projector is pure, so a rebuild produces
 * byte-identical rows.
 *
 * Denormalised on write. The trade is deliberate: written once per event, read on
 * every timeline view, and safe *because* the projected fields are labels and
 * references rather than authoritative values.
 */
export const timelineEntry = pgTable(
  'timeline_entry',
  {
    /** One entry per event, so the event id is the natural key. */
    eventId: reference()
      .primaryKey()
      .references(() => domainEvent.id),

    /** Copied from the event, so the timeline needs no join to paginate. */
    sequence: bigint({ mode: 'number' }).notNull(),
    eventType: text().notNull(),
    category: eventCategory().notNull(),

    occurredAt: instant().notNull(),
    zone: ianaZone(),
    /**
     * The day this belongs to, in the *capture* zone.
     *
     * Pre-computed rather than derived in SQL, and this is the same finding the
     * design system hit: `date_trunc` on a `timestamptz` is `STABLE`, not
     * `IMMUTABLE`, so it cannot be indexed — and forcing it with
     * `AT TIME ZONE 'UTC'` files every Asia/Kolkata evening under the next day.
     * Computing it in `core/timeline/grouping.ts` with `Intl` is both correct and
     * indexable.
     */
    occurredOn: text().notNull(),

    title: text().notNull(),
    detail: text(),

    significance: eventSignificance().notNull(),
    clinical: boolean().notNull().default(false),
    correlationId: reference().notNull(),

    /** `[{ entityType, entityId, relation }]` — §3.3 R5's links back. */
    links: jsonb().notNull().default(sql`'[]'::jsonb`),
    /** `[{ mediaObjectId, kind, isEncrypted, complianceScore }]`. */
    media: jsonb().notNull().default(sql`'[]'::jsonb`),
    hasMedia: boolean().notNull().default(false),

    /**
     * Full text over the title and detail only.
     *
     * **Never payload or entity content.** §4.7 makes journal text the most
     * sensitive data in the system, and a timeline search that reached it would
     * make the diary searchable from a surface that does not look like the
     * journal.
     */
    searchVector: searchVector('title', 'detail'),

    projectedAt: instant().notNull().default(sql`now()`),
  },
  (t) => [
    /* The default view: newest first, collapsed. Partial so the forty
       `SetLogged` rows of one session do not sit in the hot index. */
    index('timeline_primary_idx')
      .on(t.sequence.desc())
      .where(sql`${t.significance} = 'primary'`),

    /* Keyset pagination over everything, when detail is requested. */
    index('timeline_sequence_idx').on(t.sequence.desc()),

    /* Date-range queries and the day view. */
    index('timeline_occurred_on_idx').on(t.occurredOn),
    index('timeline_occurred_at_idx').on(t.occurredAt.desc()),

    /* Category filtering (§3.2's `?domain=`). */
    index('timeline_category_idx').on(t.category, t.sequence.desc()),

    /* One user action, expanded. */
    index('timeline_correlation_idx').on(t.correlationId),

    /* Photo-series views. */
    index('timeline_media_idx').on(t.sequence.desc()).where(sql`${t.hasMedia} IS TRUE`),

    /* Consultation Pack (§2.2) reads the clinical subset. */
    index('timeline_clinical_idx').on(t.sequence.desc()).where(sql`${t.clinical} IS TRUE`),

    index('timeline_search_idx').using('gin', t.searchVector),
  ],
);

/* =========================================================================
 * deferred_task
 * ====================================================================== */

/**
 * Work deferred to the single nightly runner (§5.2).
 *
 * **Not a queue with workers.** §5.2 permits "exactly one scheduled entry point",
 * so nothing polls this table — the nightly run's last step drains it. A row here
 * is work that will happen tonight, not work that is happening now.
 */
export const deferredTask = pgTable(
  'deferred_task',
  {
    id: primaryKey(),
    ...rowTimestamps,

    kind: taskKind().notNull(),
    status: taskStatus().notNull().default('pending'),

    /** A reference, never a payload. Same reasoning as ADR 0005. */
    subjectType: text().notNull(),
    subjectId: reference().notNull(),

    attempts: integer().notNull().default(0),
    /** Backoff, and notification scheduling. */
    notBefore: instant(),
    lastAttemptAt: instant(),
    lastErrorCode: text(),

    /** The event that caused this task, for tracing (§5.13). */
    causationEventId: reference().references(() => domainEvent.id),
  },
  (t) => [
    /* The drain query: due, pending, oldest first. */
    index('deferred_task_due_idx')
      .on(t.notBefore, t.createdAt)
      .where(sql`${t.status} = 'pending'`),

    /**
     * One live task per (kind, subject).
     *
     * Enqueuing a thumbnail for the same photo twice must not produce two rows —
     * the second would do redundant work and, worse, could race the first.
     */
    uniqueIndex('deferred_task_pending_unique')
      .on(t.kind, t.subjectType, t.subjectId)
      .where(sql`${t.status} IN ('pending', 'running')`),

    index('deferred_task_dead_idx').on(t.lastAttemptAt.desc()).where(sql`${t.status} = 'dead'`),
  ],
);

/* =========================================================================
 * upload_outbox
 * ====================================================================== */

/**
 * Pending media uploads — §5.7's outbox, for bytes.
 *
 * §5.7's requirement is unambiguous and is the reason this table exists at all:
 *
 *   "**Outbox durability is a hard requirement.** A failed drain must never
 *    silently discard a write. Entries persist until acknowledged; entries that
 *    fail repeatedly surface in a visible 'unsynced' state with a manual retry.
 *    Losing a logged workout because the drain failed quietly would end the
 *    user's trust in the system, and trust is the whole product."
 *
 * ## What is stored here, and what is not
 *
 * The **metadata and the intent**, not the bytes. Bytes for a queued upload live
 * in IndexedDB on the device — a 12 MB photo in a Postgres row would be a 12 MB
 * write on a connection that is by definition unreliable, and the whole point is
 * that the device is offline.
 *
 * So this row is the server's record that an upload is expected. It is created on
 * the *first* successful contact, which means a photo taken fully offline has no
 * row until the device reaches the network — and until then the device's own
 * IndexedDB queue is the only record. That asymmetry is real and documented in
 * docs/storage.md.
 */
export const uploadOutbox = pgTable(
  'upload_outbox',
  {
    ...entityColumns,

    /**
     * Client-generated idempotency key.
     *
     * §5.7: "Idempotency keys on every mutation. The outbox may replay any
     * request any number of times; the server deduplicates. Retry safety is
     * structural, not hopeful."
     */
    idempotencyKey: text().notNull(),

    status: outboxStatus().notNull().default('pending'),

    /** Set once the object exists and the row is written. */
    mediaObjectId: reference().references(() => mediaObject.id),

    /** Content-addressed destination, known before the upload starts. */
    storageKey: text().notNull(),
    tier: text().notNull(),
    contentType: text().notNull(),
    expectedByteSize: bigint({ mode: 'number' }),
    /** SHA-256 the client computed, verified server-side on arrival. */
    expectedContentHash: text(),

    attempts: integer().notNull().default(0),
    lastAttemptAt: instant(),
    lastErrorCode: text(),

    /** Which device queued it (§5.8). */
    deviceId: text(),
    /** 0–1, for a resumable upload's progress indicator. */
    progress: quantity(),

    /** Set when the user abandons it, so it stops being an alert. */
    abandonedReason: text(),
  },
  (t) => [
    uniqueIndex('upload_outbox_idempotency_unique').on(t.idempotencyKey),

    /* The drain query. */
    index('upload_outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('pending', 'uploading')`),

    /**
     * §5.16: "Sync health: outbox depth and age. An outbox entry older than 24
     * hours is an alert, because it means data the user believes is saved is
     * not." This index is what makes that check cheap enough to run nightly.
     */
    index('upload_outbox_age_idx')
      .on(t.createdAt)
      .where(sql`${t.status} <> 'uploaded' AND ${t.abandonedReason} IS NULL`),

    index('upload_outbox_media_idx').on(t.mediaObjectId),
  ],
);

/* =========================================================================
 * media_thumbnail
 * ====================================================================== */

/**
 * Derived thumbnails.
 *
 * A separate table rather than columns on `media_object`, for one reason: §5.5
 * requires sensitive-tier thumbnails to be "generated client-side at capture and
 * stored encrypted alongside", so each thumbnail is its own encrypted object with
 * its own wrapped key. Columns would mean a fixed set of sizes and no per-object
 * key.
 */
export const mediaThumbnail = pgTable(
  'media_thumbnail',
  {
    id: primaryKey(),
    ...rowTimestamps,

    mediaObjectId: reference()
      .notNull()
      .references(() => mediaObject.id),

    /** Long edge in pixels. 128 for a row, 512 for a grid cell. */
    longEdge: integer().notNull(),
    storageKey: text().notNull(),
    mimeType: text().notNull(),
    byteSize: bigint({ mode: 'number' }),

    /** Present when the parent is sensitive-tier — each thumbnail is encrypted. */
    wrappedKey: text(),
  },
  (t) => [
    uniqueIndex('media_thumbnail_unique').on(t.mediaObjectId, t.longEdge),
    uniqueIndex('media_thumbnail_key_unique').on(t.storageKey),
  ],
);

/* =========================================================================
 * app_metric — §5.11's numeric telemetry
 * ====================================================================== */

/**
 * Numeric measurements, for the §1.4 metrics.
 *
 * Separate from `app_event` (which records that something happened) because this
 * records *how long* or *how many*. §5.11 permits exactly "event names and
 * numeric measurements only" — so this table has a name, a number, and bounded
 * dimensions, and **no payload column**.
 *
 * That absence is the enforcement: §5.11 says the schema "cannot represent user
 * content, which makes leakage impossible rather than prohibited". Adding a
 * `properties jsonb` here would undo it.
 */
export const appMetric = pgTable(
  'app_metric',
  {
    id: primaryKey(),

    /** From `METRIC_NAMES` in core. A closed set, not free-form. */
    name: text().notNull(),
    value: quantity().notNull(),

    /* Bounded, low-cardinality dimensions. */
    route: text(),
    eventType: text(),
    stepName: text(),
    outcome: text(),
    deviceClass: text(),

    recordedAt: instant().notNull().default(sql`now()`),
  },
  (t) => [
    index('app_metric_name_idx').on(t.name, t.recordedAt.desc()),
    /** §1.4's capture-latency percentile query. */
    index('app_metric_recent_idx').on(t.recordedAt.desc()),
  ],
);


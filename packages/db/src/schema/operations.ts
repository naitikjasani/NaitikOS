/**
 * Operations — §9.4, §5.7, §5.8, §5.11.
 *
 * The distinction §9.4 draws, which is easy to lose:
 *
 *   "The audit log is not the application log. Audit (§9.4) is domain data,
 *    lives in Postgres, and is retained forever. Application logs are
 *    operational exhaust and expire."
 *
 * `audit_log` below is the former. `app_event` is closer to the latter but is
 * still domain-shaped, because §5.11 refuses third-party analytics outright and
 * needs somewhere to keep the handful of measurements that protect §1.4's
 * metrics.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { auditOperation, jobStatus } from './enums';
import { ianaZone, instant, primaryKey, reference, rowTimestamps } from './columns';

/**
 * Append-only, permanent, never pruned (§9.4).
 *
 *   "Every mutation to every entity writes: entity type and ID, operation,
 *    actor, timestamp, the before state, the after state, and the change reason
 *    where one was supplied. Never pruned. It is the answer to 'when did this
 *    change, and to what?' at any point in the next twenty years, and it is the
 *    recovery mechanism of last resort."
 *
 * It is also what lets §9.4 avoid shadow history tables for every entity: "the
 * audit log already contains the information, and one mechanism is better than
 * two."
 *
 * **A caution that matters here.** Before/after states are whole rows as JSON,
 * which means this table will contain journal text and clinical detail. It
 * inherits the sensitivity of the most sensitive row it has ever seen, and it
 * must never be shipped anywhere the source tables would not go — not to a
 * model, not to a log aggregator, not into a bug report.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryKey(),

    entityType: text().notNull(),
    entityId: reference().notNull(),
    operation: auditOperation().notNull(),

    /** The version this write produced, matching the entity's `version` column. */
    entityVersion: integer(),

    /** Full row as it was. Null on insert. */
    beforeState: jsonb(),
    /** Full row as it became. Null on purge. */
    afterState: jsonb(),
    /** Column names that actually changed, so a diff does not have to be computed. */
    changedFields: jsonb(),

    /**
     * Who did it. At C1 this is nearly always the single user, but not always:
     * the nightly job writes derivations, and an import writes on behalf of a
     * device. `system:derivation` is a different actor from `user`.
     */
    actor: text().notNull(),
    changeReason: text(),

    occurredAt: instant().notNull().default(sql`now()`),
    zone: ianaZone(),
    /** Correlates a mutation with the request that caused it (§5.13). */
    traceId: text(),
  },
  (t) => [
    /* §9.6: "Audit reconstruction — composite on (entity type, entity ID, timestamp)." */
    index('audit_log_entity_idx').on(t.entityType, t.entityId, t.occurredAt.desc()),
    index('audit_log_occurred_idx').on(t.occurredAt.desc()),
    index('audit_log_actor_idx').on(t.actor, t.occurredAt.desc()),
  ],
);

/**
 * Usage telemetry — §5.11, and deliberately anaemic.
 *
 *   "Event names and numeric measurements only. **No payloads, ever.** The
 *    schema cannot represent user content, which makes leakage impossible
 *    rather than prohibited."
 *
 * That is why there is no `properties jsonb` column here, however convenient one
 * would be. A JSON blob is exactly the affordance that turns "no payloads" from
 * a guarantee into a code-review convention, and P7 asks for the former. The
 * columns below can hold a name, a number, and a route — nothing that can carry
 * a journal line.
 */
export const appEvent = pgTable(
  'app_event',
  {
    id: primaryKey(),

    /** `capture.completed`, `daily_close.submitted`, `sync.failed`. */
    name: text().notNull(),
    /** A single measurement — latency in ms, a count. Never content. */
    value: bigint({ mode: 'number' }),
    /** Route pattern, never a populated path: `/body/gym/exercises/:id`. */
    route: text(),

    occurredAt: instant().notNull().default(sql`now()`),
    zone: ianaZone(),
    /** Coarse device class, for the mobile-versus-desktop split. */
    deviceClass: text(),
    schemaVersion: text(),
  },
  (t) => [
    index('app_event_name_idx').on(t.name, t.occurredAt.desc()),
    index('app_event_occurred_idx').on(t.occurredAt.desc()),
  ],
);

/**
 * Per-device sync watermark and schema-version negotiation (§5.8).
 *
 * §5.8: "Each device tracks the highest server sequence it has seen;
 * reconnection requests the delta rather than a full refetch."
 *
 * `schemaVersion` is the guard against a scenario §5.8 anticipates explicitly:
 * "Over twenty years there will be a stale phone in a drawer; this is what stops
 * it corrupting the record when it wakes up."
 */
export const syncState = pgTable(
  'sync_state',
  {
    id: primaryKey(),
    ...rowTimestamps,

    deviceId: text().notNull(),
    deviceLabel: text(),

    /** Highest server sequence this device has acknowledged. */
    watermark: bigint({ mode: 'number' }).notNull().default(0),
    lastSyncedAt: instant(),
    lastSeenAt: instant(),

    /** Client schema version, for the negotiation above. */
    schemaVersion: text().notNull(),

    /** §5.8: "Skew beyond five minutes ... is flagged in diagnostics." */
    clockSkewMs: integer(),

    /** Count of outbox entries the device reports as unsynced (§5.7). */
    pendingWrites: integer().notNull().default(0),
  },
  (t) => [uniqueIndex('sync_state_device_unique').on(t.deviceId)],
);

/**
 * Idempotency records — the server half of §5.7's outbox guarantee.
 *
 *   "Idempotency keys on every mutation. The outbox may replay any request any
 *    number of times; the server deduplicates. Retry safety is structural, not
 *    hopeful."
 *
 * The stored response is what makes a replay *correct* rather than merely
 * harmless: a retried request returns the original result instead of a
 * conflict, which is what the client needs in order to drain the outbox and
 * move on.
 */
export const idempotencyRecord = pgTable(
  'idempotency_record',
  {
    /** The client-generated key. Natural primary key — there is no better one. */
    key: text().primaryKey(),

    /** Guards against a key being reused for a different request. */
    requestFingerprint: text().notNull(),
    endpoint: text().notNull(),

    responseStatus: integer(),
    responseBody: jsonb(),

    /** Set while in flight, so concurrent replays wait rather than double-execute. */
    isComplete: boolean().notNull().default(false),

    createdAt: instant().notNull().default(sql`now()`),
    completedAt: instant(),
    /** Pruned after this. Long enough to outlive any plausible offline gap. */
    expiresAt: instant().notNull(),
  },
  (t) => [index('idempotency_record_expiry_idx').on(t.expiresAt)],
);

/**
 * A run of the single nightly job (§5.2).
 *
 * §5.2 permits exactly one scheduled entry point — "a nightly job at 03:00
 * local — which runs derivation, detectors, and rollups in sequence. One cron,
 * idempotent, safe to re-run, and manually triggerable from
 * `/settings/developer`." This table is how a run is observed after the fact,
 * which at C3 is the difference between a job that failed and a job that
 * failed silently for three weeks.
 */
export const jobRun = pgTable(
  'job_run',
  {
    id: primaryKey(),

    /** `nightly`, or the individual step when a step is run alone. */
    jobName: text().notNull(),
    status: jobStatus().notNull().default('pending'),

    startedAt: instant().notNull().default(sql`now()`),
    finishedAt: instant(),
    durationMs: integer(),

    /** Whether a human pressed the button rather than cron firing. */
    isManual: boolean().notNull().default(false),

    /** Per-step outcomes: `[{ step, status, durationMs, rowsAffected }]`. */
    steps: jsonb().notNull().default(sql`'[]'::jsonb`),
    rowsAffected: integer(),

    errorMessage: text(),
    traceId: text(),
  },
  (t) => [
    index('job_run_name_idx').on(t.jobName, t.startedAt.desc()),
    index('job_run_failed_idx')
      .on(t.startedAt.desc())
      .where(sql`${t.status} = 'failed'`),
  ],
);

/**
 * Applied migrations (§9.4).
 *
 * drizzle-kit maintains its own journal in `drizzle.__drizzle_migrations`, and
 * this table does not replace it. It records the same history in a form the
 * *application* owns and the export (§9.10) carries — so an archive opened in
 * 2046 states which schema version produced it without needing to understand a
 * particular migration tool's internal bookkeeping.
 */
export const schemaMigration = pgTable(
  'schema_migration',
  {
    /** Migration filename stem: `0000_init`. */
    id: text().primaryKey(),
    /** SHA-256 of the SQL, so an edited-after-apply migration is detectable. */
    checksum: text().notNull(),
    appliedAt: instant().notNull().default(sql`now()`),
    /** Application version that applied it. */
    appliedBy: text(),
    /** §9.4: data migrations are separate from structural ones. */
    isDataMigration: boolean().notNull().default(false),
  },
  (t) => [index('schema_migration_applied_idx').on(t.appliedAt.desc())],
);

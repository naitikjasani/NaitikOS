/**
 * `EventStore`, `HandledLedger`, and `DeadLetterSink` against Postgres.
 *
 * §6.2's dependency inversion: `core` declares the ports, this file is the only
 * thing that knows they are tables.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  DeadLetterEntry,
  DeadLetterSink,
  DomainEvent,
  EventId,
  EventStore,
  HandledLedger,
  UnsequencedEvent,
} from '@naitikos/core';
import type { DomainError } from '@naitikos/core';
import { conflictError, isEventType, upcastAll } from '@naitikos/core';

import type { Database } from '../client';
import { domainEvent, eventDeadLetter, eventHandled } from '../schema/events';

/**
 * Row → envelope.
 *
 * A stored row always has a sequence, so the return type asserts it — callers
 * paging on `sequence` would otherwise have to null-check a field the database
 * declares NOT NULL.
 */
function toDomainEvent(
  row: typeof domainEvent.$inferSelect,
): (DomainEvent & { sequence: NonNullable<DomainEvent['sequence']> }) | null {
  // A row whose type this build does not know. Skipped rather than crashed: a
  // rolled-back deploy reading events a newer one wrote must degrade, not die.
  // `upcast` handles the version case; this handles an unknown *type*.
  if (!isEventType(row.eventType)) return null;

  return {
    eventId: row.id as EventId,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
    actorId: row.actorId,
    source: row.source,
    version: row.version,
    subject: { type: row.subjectType, id: row.subjectId },
    payload: row.payload as DomainEvent['payload'],
    correlationId: row.correlationId as DomainEvent['correlationId'],
    causationId: row.causationId as EventId | null,
    metadata: (row.metadata ?? {}) as DomainEvent['metadata'],
    sequence: row.sequence as NonNullable<DomainEvent['sequence']>,
  };
}

export function createEventStore(db: Database): EventStore {
  return {
    /**
     * Append, assigning sequences.
     *
     * ## Idempotent on `eventId`
     *
     * §5.7 replays the outbox freely — "The outbox may replay any request any
     * number of times; the server deduplicates" — so re-appending an event the
     * store already has must return the stored copy rather than a second row.
     *
     * `ON CONFLICT DO NOTHING` plus a follow-up read, rather than
     * `DO UPDATE ... RETURNING`: an update would touch an append-only row and the
     * trigger from migration 0006 would reject it. That is the trigger working
     * correctly, and it means the deduplicating path has to be a read.
     */
    async append(events: readonly UnsequencedEvent[]): Promise<Result<readonly DomainEvent[], DomainError>> {
      if (events.length === 0) return ok([]);

      const ids = events.map((event) => event.eventId);

      await db
        .insert(domainEvent)
        .values(
          events.map((event) => ({
            id: event.eventId,
            eventType: event.eventType,
            version: event.version,
            occurredAt: event.occurredAt,
            capturedAt: event.capturedAt,
            actorId: event.actorId,
            source: event.source,
            subjectType: event.subject.type,
            subjectId: event.subject.id,
            payload: event.payload,
            correlationId: event.correlationId,
            causationId: event.causationId,
            metadata: event.metadata,
          })),
        )
        // The dedupe. A replayed batch inserts nothing and reads back what is
        // already stored.
        .onConflictDoNothing({ target: domainEvent.id });

      const rows = await db
        .select()
        .from(domainEvent)
        .where(inArray(domainEvent.id, ids))
        .orderBy(asc(domainEvent.sequence));

      const stored: DomainEvent[] = [];
      for (const row of rows) {
        const mapped = toDomainEvent(row);
        if (mapped !== null) stored.push(mapped);
      }

      if (stored.length !== events.length) {
        // Either a type this build cannot map, or the insert silently lost a row.
        // Both are worth failing on: the caller believes these events exist.
        return err(
          conflictError('domain_event', 'invalid_state', {
            code: 'append_incomplete',
            message: `Appended ${String(events.length)} events but read back ${String(stored.length)}.`,
          }),
        );
      }

      // Upcast on the way out, so a caller never sees a stale payload shape even
      // for an event it just wrote at an older version.
      return upcastAll(stored);
    },

    async read(options): Promise<Result<readonly DomainEvent[], DomainError>> {
      const conditions = [gt(domainEvent.sequence, options.afterSequence ?? 0)];

      if (options.types !== undefined && options.types.length > 0) {
        conditions.push(inArray(domainEvent.eventType, options.types as string[]));
      }

      const rows = await db
        .select()
        .from(domainEvent)
        .where(and(...conditions))
        // Sequence, not occurredAt. A replay must see events in the order they
        // were accepted, or a derivation could run before the event it derives
        // from — which is possible when an offline batch drains with backdated
        // `occurredAt` values.
        .orderBy(asc(domainEvent.sequence))
        .limit(options.limit);

      const mapped: DomainEvent[] = [];
      for (const row of rows) {
        const event = toDomainEvent(row);
        if (event !== null) mapped.push(event);
      }

      return upcastAll(mapped);
    },

    async has(eventId: EventId): Promise<Result<boolean, DomainError>> {
      const rows = await db
        .select({ id: domainEvent.id })
        .from(domainEvent)
        .where(eq(domainEvent.id, eventId))
        .limit(1);
      return ok(rows.length > 0);
    },
  };
}

/**
 * The idempotency ledger.
 *
 * The composite unique index is the actual guarantee — two concurrent dispatches
 * of the same event race on the insert and one loses, so a non-idempotent handler
 * cannot run twice even under concurrency. `markHandled` therefore swallows a
 * conflict rather than treating it as an error.
 */
export function createHandledLedger(db: Database): HandledLedger {
  return {
    async wasHandled(eventId, handlerName) {
      const rows = await db
        .select({ eventId: eventHandled.eventId })
        .from(eventHandled)
        .where(and(eq(eventHandled.eventId, eventId), eq(eventHandled.handlerName, handlerName)))
        .limit(1);
      return rows.length > 0;
    },

    async markHandled(eventId, handlerName) {
      await db
        .insert(eventHandled)
        .values({ eventId, handlerName })
        // Already marked. The handler ran twice — which is fine if it is
        // idempotent and already logged if it is not.
        .onConflictDoNothing();
    },
  };
}

/**
 * The dead-letter sink.
 *
 * Upserts on (event, handler) so a repeated failure updates the attempt count
 * rather than accumulating a row per retry. §5.16 alerts on the open rows here,
 * and an alert that fires on row *count* would be dominated by retry noise.
 */
export function createDeadLetterSink(db: Database): DeadLetterSink {
  return {
    async record(entry: DeadLetterEntry) {
      await db
        .insert(eventDeadLetter)
        .values({
          id: crypto.randomUUID(),
          eventId: entry.eventId,
          eventType: entry.eventType,
          handlerName: entry.handlerName,
          attempts: entry.attempts,
          errorCode: entry.error.code,
          // Developer-facing only. §5.13 — never user content.
          errorMessage: entry.error.message,
          failedAt: entry.failedAt,
        })
        .onConflictDoUpdate({
          target: [eventDeadLetter.eventId, eventDeadLetter.handlerName],
          /**
           * The unique index is **partial** — `WHERE resolved_at IS NULL`, so a
           * resolved entry does not block a fresh failure of the same handler.
           *
           * Postgres will not use a partial index for arbitration unless the
           * conflict target repeats its predicate, and without this the statement
           * fails with "there is no unique or exclusion constraint matching the
           * ON CONFLICT specification" — on the *first dead-letter in production*,
           * i.e. at the exact moment something else was already broken.
           */
          targetWhere: isNull(eventDeadLetter.resolvedAt),
          set: {
            attempts: sql`${eventDeadLetter.attempts} + ${entry.attempts}`,
            errorCode: entry.error.code,
            errorMessage: entry.error.message,
            failedAt: entry.failedAt,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}

/** Open dead-letter entries, for §5.16's alert and `/settings/developer`. */
export async function openDeadLetters(
  db: Database,
  limit = 100,
): Promise<
  readonly {
    eventId: string;
    eventType: string;
    handlerName: string;
    attempts: number;
    errorCode: string;
    failedAt: string;
  }[]
> {
  return db
    .select({
      eventId: eventDeadLetter.eventId,
      eventType: eventDeadLetter.eventType,
      handlerName: eventDeadLetter.handlerName,
      attempts: eventDeadLetter.attempts,
      errorCode: eventDeadLetter.errorCode,
      failedAt: eventDeadLetter.failedAt,
    })
    .from(eventDeadLetter)
    .where(sql`${eventDeadLetter.resolvedAt} IS NULL`)
    .orderBy(sql`${eventDeadLetter.failedAt} DESC`)
    .limit(limit);
}

/** Highest assigned sequence. The replay cursor's upper bound. */
export async function latestSequence(db: Database): Promise<number> {
  const rows = await db
    .select({ sequence: domainEvent.sequence })
    .from(domainEvent)
    .orderBy(sql`${domainEvent.sequence} DESC`)
    .limit(1);
  return rows[0]?.sequence ?? 0;
}

/** Event types this build does not recognise — a rolled-back-deploy check. */
export async function unknownEventTypes(db: Database): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ eventType: domainEvent.eventType })
    .from(domainEvent);
  return rows.map((row) => row.eventType).filter((type) => !isEventType(type));
}

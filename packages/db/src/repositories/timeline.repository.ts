/**
 * The timeline projection: writing entries, and querying them.
 *
 * The projector is in `core` (pure); this is the persistence half.
 */

import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  EventHandler,
  TimelineEntry,
  TimelinePage,
  TimelineQuery,
} from '@naitikos/core';
import { EVENT_TYPES, groupEntries, normaliseQuery, projectEvent } from '@naitikos/core';

import type { Database } from '../client';
import { timelineEntry } from '../schema/events';

/** Row → entry. */
function toEntry(row: typeof timelineEntry.$inferSelect): TimelineEntry {
  return {
    eventId: row.eventId,
    sequence: row.sequence,
    eventType: row.eventType as TimelineEntry['eventType'],
    category: row.category,
    occurredAt: row.occurredAt,
    zone: row.zone,
    occurredOn: row.occurredOn,
    title: row.title,
    detail: row.detail,
    significance: row.significance,
    clinical: row.clinical,
    correlationId: row.correlationId,
    links: (row.links ?? []) as TimelineEntry['links'],
    media: (row.media ?? []) as TimelineEntry['media'],
    searchText: [row.title, row.detail].filter((part) => part !== null).join(' '),
  };
}

export type TimelineRepository = {
  /** Upsert entries. Idempotent, so a replay is safe. */
  upsert(entries: readonly TimelineEntry[]): Promise<Result<number, DomainError>>;
  query(query: TimelineQuery, profileZone: string): Promise<Result<TimelinePage, DomainError>>;
  /** Everything touching one entity (§3.3 R5). */
  forEntity(entityType: string, entityId: string, limit?: number): Promise<Result<readonly TimelineEntry[], DomainError>>;
  /** Truncate, for a full rebuild. */
  clear(): Promise<Result<void, DomainError>>;
  count(): Promise<number>;
};

export function createTimelineRepository(db: Database): TimelineRepository {
  return {
    /**
     * Upsert on `eventId`.
     *
     * Idempotent because a replay re-projects events already projected. The
     * projector is pure, so the upserted row is byte-identical — which makes
     * "replay everything" a safe operation rather than one that needs a truncate
     * first.
     */
    async upsert(entries) {
      if (entries.length === 0) return ok(0);

      await db
        .insert(timelineEntry)
        .values(
          entries.map((entry) => ({
            eventId: entry.eventId,
            sequence: entry.sequence,
            eventType: entry.eventType,
            category: entry.category,
            occurredAt: entry.occurredAt,
            zone: entry.zone,
            occurredOn: entry.occurredOn,
            title: entry.title,
            detail: entry.detail,
            significance: entry.significance,
            clinical: entry.clinical,
            correlationId: entry.correlationId,
            links: entry.links,
            media: entry.media,
            hasMedia: entry.media.length > 0,
          })),
        )
        .onConflictDoUpdate({
          target: timelineEntry.eventId,
          set: {
            title: sql`excluded.title`,
            detail: sql`excluded.detail`,
            links: sql`excluded.links`,
            media: sql`excluded.media`,
            hasMedia: sql`excluded.has_media`,
            occurredOn: sql`excluded.occurred_on`,
            projectedAt: sql`now()`,
          },
        });

      return ok(entries.length);
    },

    async query(rawQuery, profileZone) {
      const query = normaliseQuery(rawQuery);
      const conditions: SQL[] = [];

      /* --- Date range: half-open, so adjacent pages never double-count --- */
      if (query.from !== undefined) conditions.push(gte(timelineEntry.occurredAt, query.from));
      if (query.until !== undefined) conditions.push(lt(timelineEntry.occurredAt, query.until));

      /* --- Filters ---------------------------------------------------- */
      if (query.categories !== undefined && query.categories.length > 0) {
        // Cast to the enum's union: Drizzle types `inArray` against the column's own
        // literal type, and `string[]` is wider than the column accepts.
        conditions.push(
          inArray(timelineEntry.category, query.categories as unknown as (typeof timelineEntry.category.enumValues)[number][]),
        );
      }
      if (query.eventTypes !== undefined && query.eventTypes.length > 0) {
        conditions.push(inArray(timelineEntry.eventType, query.eventTypes as string[]));
      }
      if (!query.includeDetail) {
        // The default. Forty `SetLogged` rows would otherwise bury the day.
        conditions.push(eq(timelineEntry.significance, 'primary'));
      }
      if (query.clinicalOnly === true) conditions.push(eq(timelineEntry.clinical, true));
      if (query.withMediaOnly === true) conditions.push(eq(timelineEntry.hasMedia, true));

      /* --- Search ----------------------------------------------------- */
      if (query.search !== undefined && query.search.trim() !== '') {
        // `websearch_to_tsquery` rather than `to_tsquery`: it accepts what a
        // person actually types — quoted phrases, `or`, `-exclusion` — and never
        // throws on unbalanced syntax. `to_tsquery` raises a syntax error on a
        // stray apostrophe, which would surface as a 500 while typing.
        conditions.push(
          sql`${timelineEntry.searchVector} @@ websearch_to_tsquery('english', ${query.search})`,
        );
      }

      /* --- Entity ----------------------------------------------------- */
      if (query.entity !== undefined) {
        // Containment against the jsonb links array. §3.3 R5's "links back to
        // every entity", answered without a join.
        conditions.push(
          sql`${timelineEntry.links} @> ${JSON.stringify([
            { entityType: query.entity.type, entityId: query.entity.id },
          ])}::jsonb`,
        );
      }

      /* --- Keyset pagination ------------------------------------------ */
      const backward = query.direction === 'backward';

      if (query.afterSequence !== undefined) {
        conditions.push(
          backward
            ? lt(timelineEntry.sequence, query.afterSequence)
            : gt(timelineEntry.sequence, query.afterSequence),
        );
      }

      // Fetch one extra to determine `hasMore` without a COUNT(*), which over a
      // five-year timeline is a full scan on every page for one button's state.
      const rows = await db
        .select()
        .from(timelineEntry)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(backward ? desc(timelineEntry.sequence) : asc(timelineEntry.sequence))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const entries = page.map(toEntry);

      const last = entries[entries.length - 1];

      return ok({
        entries,
        ...(query.grouping === 'none'
          ? {}
          : { groups: groupEntries(entries, query.grouping, profileZone) }),
        nextCursor: hasMore && last !== undefined ? last.sequence : null,
        hasMore,
      });
    },

    async forEntity(entityType, entityId, limit = 100) {
      const rows = await db
        .select()
        .from(timelineEntry)
        .where(
          sql`${timelineEntry.links} @> ${JSON.stringify([{ entityType, entityId }])}::jsonb`,
        )
        .orderBy(desc(timelineEntry.sequence))
        .limit(limit);

      return ok(rows.map(toEntry));
    },

    async clear() {
      // Safe by construction (ADR 0005 rule 3): the projection is derived and the
      // projector is pure, so this is recoverable by replay. The event log is
      // what must never be truncated.
      await db.delete(timelineEntry);
      return ok(undefined);
    },

    async count() {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(timelineEntry);
      return rows[0]?.count ?? 0;
    },
  };
}

/**
 * The projection handler.
 *
 * The only handler registered for every event type, and the reason a new domain
 * appears on the timeline with no timeline code change: it emits events, and this
 * projects them.
 *
 * `isIdempotent: true` because the upsert is. That matters for replay — a
 * non-idempotent handler is gated on the ledger, and a rebuild would skip every
 * event the previous run had already seen.
 */
export function createTimelineProjectionHandler(
  repository: TimelineRepository,
  profileZone: string,
): EventHandler {
  return {
    // Stable: this string keys the handled ledger and the dead-letter table.
    // Renaming it is a migration.
    name: 'timeline.project',
    handles: EVENT_TYPES,
    isIdempotent: true,
    async handle(event) {
      const entry = projectEvent(event, profileZone);
      const result = await repository.upsert([entry]);
      return result.ok ? ok(undefined) : result;
    },
  };
}

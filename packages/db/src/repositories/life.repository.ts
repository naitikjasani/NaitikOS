/**
 * The Life Timeline, persisted — eras, chapters and significant events (§10.8).
 *
 * ## Everything here is authored, so everything here is a write path
 *
 * Unlike `timeline_entry`, which is a projection of the domain event log and
 * has no author, every row this repository touches was typed by a person.
 * §10.0 keeps the system out of deciding that a chapter began; there is no
 * derivation, no backfill and no import in this file, and adding one would be
 * the moment the timeline stopped being the operator's account of their own
 * life and started being the system's.
 *
 * ## `saveSpan` and `saveEvent` are inserts, not upserts
 *
 * §5.7 has clients mint UUIDv7 ids offline, so the same write can arrive twice
 * — a retried request, a replayed queue. `onConflictDoNothing` followed by a
 * read returns the stored row, which makes a replay a no-op rather than a
 * duplicate chapter. It also means the second arrival does **not** overwrite
 * the first: a resend is the same write, not a correction. Correcting a span is
 * `closeSpan` or a future explicit edit, both of which say what they are.
 *
 * ## Nothing is deleted
 *
 * §9.4: soft deletion with a reason. `removeSpan` tombstones the row and leaves
 * any events that pointed at it in place — an event is significant on its own
 * terms, and cascading would delete the record of a wedding because the
 * relationship's chapter was tidied up. The orphaned `span_id` is left as-is;
 * it is still true that the event happened during that span.
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, LifeEvent, LifeEventInput, LifeSpan, LifeSpanInput, LifeSpanKind } from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { lifeEvent, lifeSpan } from '../schema/prediction';

const SPAN_ENTITY = 'life_span';
const EVENT_ENTITY = 'life_event';

function toSpan(row: typeof lifeSpan.$inferSelect): LifeSpan {
  return {
    id: row.id,
    kind: row.kind as LifeSpanKind,
    title: row.title,
    description: row.description,
    startedAt: row.startedAt,
    /* Stays null. §10.8's open chapter is a fact the record does not have, and
     * substituting today's date here would put it in every consumer at once. */
    endedAt: row.endedAt,
    parentId: row.parentId,
    slot: row.slot,
  };
}

function toEvent(row: typeof lifeEvent.$inferSelect): LifeEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    occurredAt: row.occurredAt,
    spanId: row.spanId,
    significance: row.significance,
  };
}

export type LifeRepository = {
  /** Every live span, oldest first — the order the axis draws them in. */
  spans(): Promise<Result<readonly LifeSpan[], DomainError>>;
  /** Every live event, most recent first. */
  events(): Promise<Result<readonly LifeEvent[], DomainError>>;

  saveSpan(input: LifeSpanInput): Promise<Result<LifeSpan, DomainError>>;
  saveEvent(input: LifeEventInput): Promise<Result<LifeEvent, DomainError>>;

  /**
   * Close an open span.
   *
   * Its own method rather than a field on `saveSpan`, because ending a chapter
   * is the one edit this surface makes routinely and it is a different act from
   * authoring one. `life_span_ordered` rejects an end before the start, so a
   * mistyped year fails at the database rather than producing a bar of negative
   * width.
   */
  closeSpan(id: string, endedAt: string, at: string): Promise<Result<LifeSpan, DomainError>>;

  /** §9.4 soft delete. The reason is required — a tombstone without one is a mystery in year six. */
  removeSpan(id: string, at: string, reason: string): Promise<Result<LifeSpan, DomainError>>;
  removeEvent(id: string, at: string, reason: string): Promise<Result<LifeEvent, DomainError>>;
};

export function createLifeRepository(db: Database): LifeRepository {
  return {
    async spans() {
      const rows = await db
        .select()
        .from(lifeSpan)
        .where(isNull(lifeSpan.deletedAt))
        /* Eras before chapters at the same start, so the backdrop is read
         * first. The layout in `core` re-sorts for packing; this ordering is
         * for the lists that render the rows as text. */
        .orderBy(asc(lifeSpan.startedAt), asc(lifeSpan.kind), asc(lifeSpan.id));
      return ok(rows.map(toSpan));
    },

    async events() {
      const rows = await db
        .select()
        .from(lifeEvent)
        .where(isNull(lifeEvent.deletedAt))
        .orderBy(desc(lifeEvent.occurredAt), asc(lifeEvent.id));
      return ok(rows.map(toEvent));
    },

    async saveSpan(input) {
      const rows = await db
        .insert(lifeSpan)
        .values({
          id: input.id,
          kind: input.kind,
          title: input.title,
          description: input.description ?? null,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          parentId: input.parentId ?? null,
          slot: input.slot ?? null,
        })
        /* §5.7: a replayed write arrives with the same client-minted UUIDv7. */
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toSpan(row));

      const existing = await db.select().from(lifeSpan).where(eq(lifeSpan.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError(SPAN_ENTITY, input.id) }
        : ok(toSpan(replayed));
    },

    async saveEvent(input) {
      const rows = await db
        .insert(lifeEvent)
        .values({
          id: input.id,
          title: input.title,
          description: input.description ?? null,
          occurredAt: input.occurredAt,
          spanId: input.spanId ?? null,
          significance: input.significance ?? null,
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toEvent(row));

      const existing = await db.select().from(lifeEvent).where(eq(lifeEvent.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError(EVENT_ENTITY, input.id) }
        : ok(toEvent(replayed));
    },

    async closeSpan(id, endedAt, at) {
      const rows = await db
        .update(lifeSpan)
        .set({ endedAt, updatedAt: at })
        .where(and(eq(lifeSpan.id, id), isNull(lifeSpan.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError(SPAN_ENTITY, id) } : ok(toSpan(row));
    },

    async removeSpan(id, at, reason) {
      const rows = await db
        .update(lifeSpan)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(lifeSpan.id, id), isNull(lifeSpan.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError(SPAN_ENTITY, id) } : ok(toSpan(row));
    },

    async removeEvent(id, at, reason) {
      const rows = await db
        .update(lifeEvent)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(lifeEvent.id, id), isNull(lifeEvent.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError(EVENT_ENTITY, id) } : ok(toEvent(row));
    },
  };
}

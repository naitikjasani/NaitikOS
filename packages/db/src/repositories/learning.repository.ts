/**
 * Learning, the calendar import, and focus sessions (§4.8).
 *
 * The three sit together because they share one property: none of them owns a
 * fact any other module also owns. Notes live in the polymorphic `note` table,
 * energy lives in `mind.energy` observations, and recurrence lives in whichever
 * calendar the ICS came from. This file writes what is genuinely its own and
 * reads the rest.
 *
 * ## The import is an upsert on `(source, external_id)`
 *
 * A calendar is re-read repeatedly and an event's details change — a meeting is
 * moved, a room reassigned, an invitation declined. §4.8 makes the import
 * read-only, so the source is authoritative and the row is updated in place
 * rather than accumulating one copy per read.
 *
 * `is_travel` is the exception: it is written on first insert from the
 * importer's guess and **never overwritten**, because the operator is allowed to
 * correct it and a re-import that reverted the correction would make the field
 * useless. P5 — the record is the operator's, and a re-read is not a licence to
 * edit it.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  FocusSession,
  FocusSessionInput,
  LearningItem,
  LearningItemInput,
  LearningKind,
  LearningStatus,
  LoadEvent,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { note } from '../schema/crosscutting';
import { calendarEvent, focusSession, learningItem } from '../schema/work';

/** The `entity_type` learning notes are filed under in the shared `note` table. */
export const LEARNING_NOTE_ENTITY = 'learning_item';

function toItem(row: typeof learningItem.$inferSelect): LearningItem {
  return {
    id: row.id,
    kind: row.kind as LearningKind,
    title: row.title,
    author: row.author,
    url: row.url,
    status: row.status as LearningStatus,
    totalUnits: row.totalUnits,
    completedUnits: row.completedUnits,
    unitLabel: row.unitLabel,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    abandonedReason: row.abandonedReason,
    synthesis: row.synthesis,
    skills: row.skills ?? [],
  };
}

function toSession(row: typeof focusSession.$inferSelect): FocusSession {
  return {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    zone: row.zone,
    dayKey: row.dayKey,
    projectId: row.projectId,
    taskId: row.taskId,
    label: row.label,
    quality: row.quality,
    interruptions: row.interruptions,
    note: row.note,
  };
}

export type CalendarEventRow = LoadEvent & {
  readonly title: string | null;
  readonly location: string | null;
  readonly calendarName: string | null;
  readonly zone: string;
};

function toCalendarEvent(row: typeof calendarEvent.$inferSelect): CalendarEventRow {
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    calendarName: row.calendarName,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    zone: row.zone,
    isAllDay: row.isAllDay,
    isAccepted: row.isAccepted,
    isTravel: row.isTravel,
    attendeeCount: row.attendeeCount,
  };
}

export type LearningNote = {
  readonly id: string;
  readonly learningItemId: string;
  readonly content: string;
  readonly createdAt: string;
};

export type ImportEventInput = {
  readonly id: string;
  readonly source: 'ics' | 'google' | 'manual';
  readonly externalId: string | null;
  readonly calendarName: string | null;
  readonly title: string | null;
  readonly location: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly zone: string;
  readonly isAllDay: boolean;
  readonly isAccepted: boolean | null;
  readonly attendeeCount: number | null;
  readonly isTravel: boolean;
};

export type ImportOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

export type ProgressInput = {
  readonly id: string;
  readonly status: LearningStatus;
  readonly completedUnits: number | null;
  readonly synthesis: string | null;
  readonly abandonedReason: string | null;
  readonly at: string;
};

export type LearningRepository = {
  items(): Promise<Result<readonly LearningItem[], DomainError>>;
  itemById(id: string): Promise<Result<LearningItem | null, DomainError>>;
  createItem(input: LearningItemInput): Promise<Result<LearningItem, DomainError>>;
  setProgress(input: ProgressInput): Promise<Result<LearningItem, DomainError>>;

  notes(): Promise<Result<readonly LearningNote[], DomainError>>;
  addNote(input: { readonly id: string; readonly learningItemId: string; readonly content: string }): Promise<
    Result<LearningNote, DomainError>
  >;

  eventsBetween(fromIso: string, toIso: string): Promise<Result<readonly CalendarEventRow[], DomainError>>;
  importEvents(rows: readonly ImportEventInput[], at: string): Promise<Result<ImportOutcome, DomainError>>;
  setTravel(id: string, isTravel: boolean, at: string): Promise<Result<CalendarEventRow, DomainError>>;

  sessionsBetween(fromDayKey: string, toDayKey: string): Promise<Result<readonly FocusSession[], DomainError>>;
  recordSession(input: FocusSessionInput): Promise<Result<FocusSession, DomainError>>;
  endSession(id: string, at: string, quality: number | null, interruptions: number | null): Promise<
    Result<FocusSession, DomainError>
  >;
};

export function createLearningRepository(db: Database): LearningRepository {
  return {
    async items() {
      const rows = await db
        .select()
        .from(learningItem)
        .where(isNull(learningItem.deletedAt))
        .orderBy(asc(learningItem.createdAt));
      return ok(rows.map(toItem));
    },

    async itemById(id) {
      const rows = await db
        .select()
        .from(learningItem)
        .where(and(eq(learningItem.id, id), isNull(learningItem.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toItem(row));
    },

    async createItem(input) {
      const rows = await db
        .insert(learningItem)
        .values({
          id: input.id,
          kind: input.kind,
          title: input.title,
          author: input.author ?? null,
          url: input.url ?? null,
          totalUnits: input.totalUnits ?? null,
          unitLabel: input.unitLabel ?? null,
          skills: [...(input.skills ?? [])],
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toItem(row));

      const existing = await db.select().from(learningItem).where(eq(learningItem.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('learning_item', input.id) }
        : ok(toItem(replayed));
    },

    async setProgress(input) {
      const rows = await db
        .update(learningItem)
        .set({
          status: input.status,
          completedUnits: input.completedUnits,
          synthesis: input.synthesis,
          /*
           * A reason belongs only to the status that has one. Carrying an
           * abandonment reason onto a later `finished` would leave a finished
           * book explaining why it was put down.
           */
          abandonedReason: input.status === 'abandoned' ? input.abandonedReason : null,
          ...(input.status === 'in_progress' ? { startedAt: sql`coalesce(${learningItem.startedAt}, ${input.at})` } : {}),
          /* Only finishing dates the finish. An abandoned item has a reason and
           * no `finishedAt`, because it was not finished. */
          ...(input.status === 'finished' ? { finishedAt: input.at } : { finishedAt: null }),
          updatedAt: input.at,
        })
        .where(and(eq(learningItem.id, input.id), isNull(learningItem.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('learning_item', input.id) }
        : ok(toItem(row));
    },

    async notes() {
      const rows = await db
        .select()
        .from(note)
        .where(and(eq(note.entityType, LEARNING_NOTE_ENTITY), isNull(note.deletedAt)))
        .orderBy(desc(note.createdAt));
      return ok(
        rows.map((row) => ({
          id: row.id,
          learningItemId: row.entityId ?? '',
          content: row.content,
          createdAt: row.createdAt,
        })),
      );
    },

    async addNote(input) {
      const rows = await db
        .insert(note)
        .values({
          id: input.id,
          entityType: LEARNING_NOTE_ENTITY,
          entityId: input.learningItemId,
          content: input.content,
          /*
           * `none`, the column default, stated explicitly. A reading note is
           * the operator's own thinking and §10.10 makes sharing a deliberate
           * act rather than an inherited one.
           */
          aiConsent: 'none',
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('note', input.id) };
      return ok({
        id: row.id,
        learningItemId: row.entityId ?? input.learningItemId,
        content: row.content,
        createdAt: row.createdAt,
      });
    },

    async eventsBetween(fromIso, toIso) {
      const rows = await db
        .select()
        .from(calendarEvent)
        .where(
          and(
            isNull(calendarEvent.deletedAt),
            gte(calendarEvent.startsAt, fromIso),
            lte(calendarEvent.startsAt, toIso),
          ),
        )
        .orderBy(asc(calendarEvent.startsAt));
      return ok(rows.map(toCalendarEvent));
    },

    async importEvents(rows, at) {
      if (rows.length === 0) return ok({ inserted: 0, updated: 0 });

      /*
       * Which UIDs already exist, before the write. `ON CONFLICT` cannot report
       * insert-versus-update per row and the caller needs both numbers — an
       * import that says "412 events" when 410 were unchanged is a report
       * nobody can use to tell whether it worked.
       */
      const uids = rows
        .map((row) => row.externalId)
        .filter((uid): uid is string => uid !== null && uid !== '');

      const known =
        uids.length === 0
          ? []
          : await db
              .select({ externalId: calendarEvent.externalId })
              .from(calendarEvent)
              .where(and(isNull(calendarEvent.deletedAt), inArray(calendarEvent.externalId, uids)));
      const seen = new Set(known.map((row) => row.externalId));

      await db
        .insert(calendarEvent)
        .values(
          rows.map((row) => ({
            id: row.id,
            source: row.source,
            externalId: row.externalId,
            calendarName: row.calendarName,
            title: row.title,
            location: row.location,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            zone: row.zone,
            isAllDay: row.isAllDay,
            isAccepted: row.isAccepted,
            attendeeCount: row.attendeeCount,
            isTravel: row.isTravel,
            lastImportedAt: at,
          })),
        )
        .onConflictDoUpdate({
          /*
           * The partial unique index needs its predicate repeated to be
           * inferable as an ON CONFLICT target. Postgres will not match a
           * partial index without it — the same 42P10 the graph repository ran
           * into.
           */
          target: [calendarEvent.source, calendarEvent.externalId],
          targetWhere: sql`external_id IS NOT NULL AND deleted_at IS NULL`,
          set: {
            calendarName: sql`excluded.calendar_name`,
            title: sql`excluded.title`,
            location: sql`excluded.location`,
            startsAt: sql`excluded.starts_at`,
            endsAt: sql`excluded.ends_at`,
            zone: sql`excluded.zone`,
            isAllDay: sql`excluded.is_all_day`,
            isAccepted: sql`excluded.is_accepted`,
            attendeeCount: sql`excluded.attendee_count`,
            /* `is_travel` is deliberately absent. The importer guesses it once;
             * the operator may correct it, and a re-read is not a licence to
             * revert that (P5). */
            lastImportedAt: at,
            updatedAt: at,
          },
        });

      const updated = rows.filter(
        (row) => row.externalId !== null && row.externalId !== '' && seen.has(row.externalId),
      ).length;
      return ok({ inserted: rows.length - updated, updated });
    },

    async setTravel(id, isTravel, at) {
      const rows = await db
        .update(calendarEvent)
        .set({ isTravel, updatedAt: at })
        .where(and(eq(calendarEvent.id, id), isNull(calendarEvent.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('calendar_event', id) }
        : ok(toCalendarEvent(row));
    },

    async sessionsBetween(fromDayKey, toDayKey) {
      const rows = await db
        .select()
        .from(focusSession)
        .where(and(gte(focusSession.dayKey, fromDayKey), lte(focusSession.dayKey, toDayKey)))
        .orderBy(desc(focusSession.startedAt));
      return ok(rows.map(toSession));
    },

    async recordSession(input) {
      const rows = await db
        .insert(focusSession)
        .values({
          id: input.id,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          zone: input.zone,
          dayKey: input.dayKey,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          label: input.label ?? null,
          quality: input.quality ?? null,
          interruptions: input.interruptions ?? null,
          note: input.note ?? null,
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toSession(row));

      const existing = await db.select().from(focusSession).where(eq(focusSession.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('focus_session', input.id) }
        : ok(toSession(replayed));
    },

    async endSession(id, at, quality, interruptions) {
      const rows = await db
        .update(focusSession)
        .set({ endedAt: at, quality, interruptions, updatedAt: at })
        .where(eq(focusSession.id, id))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('focus_session', id) }
        : ok(toSession(row));
    },
  };
}

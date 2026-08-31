/**
 * Work — §4.8, the V3 pillar.
 *
 * §4.8 ends with the reason this pillar exists at all:
 *
 *   "work load is a major input to Mind, Sleep, and Gym adherence. This pillar
 *    is the missing variable that explains a great many patterns in the others,
 *    which is why it earns its place despite being the least 'quantified-self'
 *    of the five."
 *
 * That sentence is a design constraint, not a motivation. It says the value of
 * Work is *joins*, so every table here is shaped to be joined against the day —
 * a task carries the day it was completed, a focus session carries its zone, a
 * calendar event carries its load. None of them is shaped to be a good task
 * manager, a good calendar, or a good notebook, because the system already
 * loses if the operator has to maintain those here.
 *
 * ## What this file deliberately does not contain
 *
 * **A notes table.** `/work/learning/notes` reads the polymorphic `note` table
 * with `entity_type = 'learning_item'`. §P3 asks for new lenses rather than new
 * systems, and a `learning_note` would be a second notes implementation with a
 * second search index to keep in step.
 *
 * **An energy table.** §4.8's "energy mapping across the day" is a lens over
 * `mind.energy` observations, which the substrate already stores. A focus
 * session records the session; the energy it happened at is read, not copied.
 *
 * **A recurrence model.** Calendar import is read-only (§4.8), so an expanded
 * occurrence is what arrives and what is stored. Storing an RRULE would mean
 * this system reimplementing expansion, and getting it subtly wrong against the
 * source it is only supposed to be reading.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import {
  calendarSource,
  careerEntryKind,
  learningKind,
  learningStatus,
  projectStatus,
  workTaskStatus,
} from './enums';
import {
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  reference,
  rowTimestamps,
  searchVector,
} from './columns';

/* =========================================================================
 * Projects and tasks
 * ====================================================================== */

/** The container above tasks, linked to career artifacts (§4.8). */
export const project = pgTable(
  'project',
  {
    ...entityColumns,

    name: text().notNull(),
    description: text(),
    status: projectStatus().notNull().default('active'),

    startedAt: instant(),
    endedAt: instant(),

    /**
     * Work done for someone — an employer, a client, oneself. Free text rather
     * than an `organisation` table: this pillar is not a CRM, and §4.8's People
     * neighbour is a separate V3 module that does not exist yet.
     */
    context: text(),

    /** A project may serve a goal. Progress still lives with the goal (§4.10). */
    goalId: reference(),
  },
  (t) => [
    index('project_status_idx').on(t.status).where(sql`${t.deletedAt} IS NULL`),
    check('project_ordered', sql`${t.endedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.startedAt} <= ${t.endedAt}`),
  ],
);

/**
 * A task. Minimal on purpose (§4.8): "Its purpose is linkage: a task attached
 * to a goal, a project, or a health action."
 *
 * There is no priority column and no estimate column. Both are the machinery of
 * a task manager the blueprint explicitly declines to compete with, and both
 * would be fields the operator felt obliged to fill in before the thing they
 * actually came here to do.
 *
 * `completedDayKey` is denormalised from `completedAt` because every question
 * asked of this table is a per-day join — "what did I close on the day I slept
 * badly" — and recomputing a zoned day key across a year of rows at query time
 * is the difference between an index scan and a sequential one.
 */
export const task = pgTable(
  'task',
  {
    ...entityColumns,

    title: text().notNull(),
    note: text(),
    status: workTaskStatus().notNull().default('open'),

    projectId: reference().references(() => project.id),
    goalId: reference(),

    /**
     * The health action a task exists to serve — "book the dermatology
     * follow-up". Polymorphic like §9.3(3), because the target could be an
     * appointment, a treatment course or a condition, and three nullable
     * foreign keys would be three ways to say the same thing.
     */
    linkedEntityType: text(),
    linkedEntityId: reference(),

    dueDayKey: text(),
    completedAt: instant(),
    /** The zoned local day `completedAt` fell on. Written together or not at all. */
    completedDayKey: text(),
    zone: ianaZone(),

    /** Why it was dropped. A dropped task with no reason is noise in year three. */
    droppedReason: text(),
  },
  (t) => [
    index('task_status_idx').on(t.status, t.dueDayKey).where(sql`${t.deletedAt} IS NULL`),
    index('task_project_idx').on(t.projectId).where(sql`${t.deletedAt} IS NULL`),
    index('task_completed_idx').on(t.completedDayKey.desc()).where(sql`${t.completedDayKey} IS NOT NULL`),
    index('task_linked_idx').on(t.linkedEntityType, t.linkedEntityId),
    check(
      'task_completed_together',
      sql`(${t.completedAt} IS NULL) = (${t.completedDayKey} IS NULL)`,
    ),
    check(
      'task_done_has_completion',
      sql`${t.status} <> 'done' OR ${t.completedAt} IS NOT NULL`,
    ),
  ],
);

/* =========================================================================
 * Career
 * ====================================================================== */

/**
 * One line in the career log.
 *
 * §4.8 states both the problem and the protocol: "Solves a real recurring
 * problem: reconstructing a year of work at review time from memory. Every
 * shipped thing gets one line on the day it ships."
 *
 * So `occurredAt` is the day it happened, never the day it was typed — the
 * whole point is defeated by a log that records when the operator got round to
 * writing it up. `createdAt` already answers that question if it is ever asked.
 *
 * `visibility` is the field a review actually turns on: work that nobody senior
 * saw is the work that goes missing at review time, and recording it at the
 * moment it ships is the only time the answer is known.
 */
export const careerEntry = pgTable(
  'career_entry',
  {
    ...entityColumns,

    kind: careerEntryKind().notNull(),
    title: text().notNull(),
    detail: text(),

    occurredAt: instant().notNull(),
    zone: ianaZone(),

    projectId: reference().references(() => project.id),

    /** Who said it, for `feedback` and `recognition`. Free text; not a person record. */
    attributedTo: text(),
    /** A link to the shipped thing — a PR, a doc, a release. */
    artifactUrl: text(),

    /** Was this visible to people who decide things? Known now, guessed later. */
    isVisibleToLeadership: boolean(),

    /** Skills this exercised, for the Learning join §4.8 asks for. */
    skills: text().array(),

    searchVector: searchVector('title', 'detail'),
  },
  (t) => [
    index('career_entry_occurred_idx').on(t.occurredAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('career_entry_kind_idx').on(t.kind, t.occurredAt.desc()),
    index('career_entry_search_idx').using('gin', t.searchVector),
  ],
);

/* =========================================================================
 * Learning
 * ====================================================================== */

/**
 * Something being read, watched or worked through.
 *
 * §4.8: "queue, progress, notes, synthesis. Links to Career for skill
 * development." Notes are the shared `note` table; the link to Career is
 * `skills`, matched against `career_entry.skills`.
 *
 * Progress is a fraction of a self-declared total rather than a page number,
 * because a book, a course and a paper measure progress in three different
 * units and the question asked of this column is always "how far in".
 */
export const learningItem = pgTable(
  'learning_item',
  {
    ...entityColumns,

    kind: learningKind().notNull(),
    title: text().notNull(),
    author: text(),
    url: text(),

    status: learningStatus().notNull().default('queued'),

    /** Total units — pages, lessons, minutes. Whatever the thing counts in. */
    totalUnits: integer(),
    /** Units completed. Compared against `totalUnits`, never against a default. */
    completedUnits: integer(),
    /** What `totalUnits` counts. Recorded so the number is never ambiguous. */
    unitLabel: text(),

    startedAt: instant(),
    finishedAt: instant(),

    /** Why it was put down. §4.8's queue is allowed to have an exit. */
    abandonedReason: text(),

    /** The one-paragraph "what I actually took from this". */
    synthesis: text(),

    skills: text().array(),

    searchVector: searchVector('title', 'author', 'synthesis'),
  },
  (t) => [
    index('learning_item_status_idx').on(t.status).where(sql`${t.deletedAt} IS NULL`),
    index('learning_item_search_idx').using('gin', t.searchVector),
    check(
      'learning_item_progress_bounded',
      sql`${t.completedUnits} IS NULL OR ${t.totalUnits} IS NULL OR ${t.completedUnits} <= ${t.totalUnits}`,
    ),
  ],
);

/* =========================================================================
 * Calendar
 * ====================================================================== */

/**
 * An imported calendar occurrence.
 *
 * §4.8 says what this is for, and it is not scheduling: "Its value is context:
 * the load, travel, and meeting density that explains a bad week in every other
 * domain."
 *
 * `externalId` plus `source` is the idempotency key for re-import. A calendar is
 * re-read repeatedly and an event's details change; the row is updated in place
 * rather than accumulating duplicates, which is why the unique index is on the
 * pair and not on the primary key alone.
 */
export const calendarEvent = pgTable(
  'calendar_event',
  {
    ...entityColumns,

    source: calendarSource().notNull(),
    /** The UID from the source system. Stable across re-imports. */
    externalId: text(),
    /** Which calendar it came from, when one account has several. */
    calendarName: text(),

    title: text(),
    location: text(),

    startsAt: instant().notNull(),
    endsAt: instant(),
    zone: ianaZone().notNull(),
    isAllDay: boolean().notNull().default(false),

    /** Attendee count, for meeting-density analysis. Not the attendees. */
    attendeeCount: integer(),
    /** Did the operator accept? A declined meeting is not load. */
    isAccepted: boolean(),

    /**
     * §4.8 names travel as one of the three things this explains. Set by the
     * import when the event looks like travel, and correctable by hand — the
     * system's guess is stored as the user's field, not as a separate claim.
     */
    isTravel: boolean().notNull().default(false),

    lastImportedAt: instant(),
  },
  (t) => [
    index('calendar_event_starts_idx').on(t.startsAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('calendar_event_external_unique')
      .on(t.source, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/* =========================================================================
 * Focus
 * ====================================================================== */

/**
 * A deep-work session.
 *
 * §4.8: "deep-work sessions and energy mapping across the day, cross-referenced
 * with sleep and mood." The cross-reference is a join on `dayKey`, so the day
 * key is stored rather than derived — same argument as `task.completedDayKey`.
 *
 * `interruptions` is an integer the operator sets afterwards, not a counter the
 * system maintains. A system that tried to detect interruption would need to
 * watch what the operator was doing, which is a surveillance apparatus this
 * design has no intention of building.
 */
export const focusSession = pgTable(
  'focus_session',
  {
    id: primaryKey(),
    ...rowTimestamps,

    startedAt: instant().notNull(),
    endedAt: instant(),
    zone: ianaZone().notNull(),
    /** The zoned local day `startedAt` fell on. */
    dayKey: text().notNull(),

    projectId: reference().references(() => project.id),
    taskId: reference().references(() => task.id),

    /** What was worked on, when it was not a project or a task. */
    label: text(),

    /** 1–5, matching the Daily Close scale (§4.0). Self-rated after the fact. */
    quality: integer(),
    interruptions: integer(),

    note: text(),
  },
  (t) => [
    index('focus_session_day_idx').on(t.dayKey.desc()),
    index('focus_session_project_idx').on(t.projectId),
    check('focus_session_ordered', sql`${t.endedAt} IS NULL OR ${t.startedAt} <= ${t.endedAt}`),
    check('focus_session_quality_range', sql`${t.quality} IS NULL OR ${t.quality} BETWEEN 1 AND 5`),
  ],
);

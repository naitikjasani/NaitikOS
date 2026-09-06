/**
 * The Therapy service — §3.2's `/mind/therapy`, assembled.
 *
 * ## This is a read surface, and that is a decision rather than a stub
 *
 * There is no write path in this file, no `/api/mind/therapy`, and no write
 * method on `MindRepository` for `therapy_session`. §4.7 puts the highest duty
 * of care in the system on this module, and the honest read of it is that a
 * therapy note is written *once*, slowly, after the hour — it is the least
 * quick-capture thing in the record. A form bolted onto the bottom of a list
 * screen is the wrong instrument for it, and shipping the wrong instrument
 * would mean the first real notes go somewhere the operator then has to be
 * migrated out of.
 *
 * What is read-only here is still useful, which is the test §2.1 sets: the
 * dates, the therapist, the modality, the between-session commitments and the
 * next appointment are the things looked at *between* sessions. Rows are
 * inserted directly for now, exactly as `docs/mind.md` records for the crisis
 * plan. The gap is stated on the screen rather than left to be discovered.
 *
 * ## Nothing in this file reads a therapy note
 *
 * Not to summarise it, not to search it, not to score it. §4.7 —
 * "Content is user-authored only; nothing here is ever model-generated" — is
 * pinned by a check constraint on the way in; on the way out the enforcement is
 * that {@link loadTherapyBoard} has no access to the prose at all, because
 * `therapySessions` does not select it. A future feature that wanted to analyse
 * a note would have to change a repository read to do it, which is the right
 * amount of friction.
 *
 * ## What is deliberately not computed
 *
 * - **No cadence, frequency or attendance figure.** "Four sessions this month",
 *   a gap chart, a longest-run — all of it. A gap between sessions can be a
 *   holiday, a therapist's leave, money, or a deliberate and healthy pause, and
 *   §4.7's "no negative framing, ever" is not satisfied by a neutral-coloured
 *   number that still reads as a lapse. Attendance is not adherence.
 * - **No completion rate over action items.** The same objection, one level
 *   down: a commitment made to a therapist is not a habit to be scored, and a
 *   percentage would turn the one genuinely useful list on the page into a
 *   report card handed back at the next session.
 * - **No mood-against-session-date comparison.** It is the most tempting chart
 *   here and it is precisely the claim §4.7 forbids — "'Your mood is low
 *   because you skipped the gym' is a claim the system is not entitled to
 *   make", and the therapy version of that sentence is worse.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import type { Database, TherapySessionSummary } from '@naitikos/db';
import { createMindRepository } from '@naitikos/db';

/*
 * Re-exported so the screen has one import for its props. `features/` reaching
 * into `@naitikos/db` directly is the habit that puts the database package into
 * a browser bundle the first time one of those screens gains a `'use client'`.
 */
export type { TherapyActionItem, TherapySessionSummary } from '@naitikos/db';

/**
 * How far back the list reaches.
 *
 * Weekly therapy for two years is about a hundred hours, so this is roughly
 * eighteen months of a common cadence — long enough that the list is a record
 * rather than a recent-items widget, short enough that the page stays one
 * scroll. There is no pagination because there is no "load more" worth building
 * before there is a second page of real rows.
 */
export const THERAPY_SESSION_LIMIT = 80;

/**
 * A commitment made in a session and not yet marked done, lifted out of the
 * session it belongs to.
 *
 * Flattened across sessions because that is how it is used: the question
 * between two Tuesdays is "what did I say I would do", not "what did I say I
 * would do in the session of the 12th". The originating session travels with it
 * so the answer is never detached from its context.
 */
export type OutstandingActionItem = {
  readonly sessionId: string;
  readonly sessionDayKey: string;
  readonly text: string;
  readonly dueAt: string | null;
};

export type TherapyBoard = {
  readonly sessions: readonly TherapySessionSummary[];
  readonly outstanding: readonly OutstandingActionItem[];
  /**
   * The soonest follow-up still ahead, or null.
   *
   * Null when nothing is booked, and the screen then shows nothing at all
   * rather than prompting. Chasing someone to book a therapy appointment is the
   * system managing their care, and §4.7 keeps it to reporting facts calmly.
   */
  readonly nextFollowUpAt: string | null;
  /** True when nothing has ever been recorded — an empty record, not an error. */
  readonly isEmpty: boolean;
};

/**
 * Order outstanding items by when they are due, undated last.
 *
 * Undated last rather than first: an item with no date was not given one, and
 * floating it to the top would invent an urgency the operator did not record.
 * Within the undated tail, the most recent session's items come first, because
 * those are the ones agreed most recently.
 *
 * Note what this ordering does *not* do — it does not separate, mark or hoist
 * items whose due date has passed. A date in the past is legible as a date in
 * the past; restating it as "overdue" adds no information and adds a reproach.
 */
function byDueDate(a: OutstandingActionItem, b: OutstandingActionItem): number {
  if (a.dueAt === null && b.dueAt === null) return b.sessionDayKey.localeCompare(a.sessionDayKey);
  if (a.dueAt === null) return 1;
  if (b.dueAt === null) return -1;
  return a.dueAt.localeCompare(b.dueAt);
}

export async function loadTherapyBoard(
  db: Database,
  options: { readonly nowIso: string },
): Promise<Result<TherapyBoard, DomainError>> {
  const sessions = await createMindRepository(db).therapySessions(THERAPY_SESSION_LIMIT);
  if (!sessions.ok) return err(sessions.error);

  const outstanding: OutstandingActionItem[] = [];
  for (const session of sessions.value) {
    for (const item of session.actionItems) {
      if (item.completedAt !== null) continue;
      outstanding.push({
        sessionId: session.id,
        sessionDayKey: session.dayKey,
        text: item.text,
        dueAt: item.dueAt,
      });
    }
  }
  outstanding.sort(byDueDate);

  /*
   * Both sides of this comparison are ISO 8601 in UTC — the `instant` column
   * normalises reads through `parseSqlTimestamp`, and `nowIso` comes from
   * `isoFromMillis`. Lexicographic ordering is therefore instant ordering, and
   * no `Date` is constructed outside `core/temporal` (§11.3).
   */
  const upcoming = sessions.value
    .map((session) => session.followUpAt)
    .filter((at): at is string => at !== null && at > options.nowIso)
    .sort((a, b) => a.localeCompare(b));

  return ok({
    sessions: sessions.value,
    outstanding,
    nextFollowUpAt: upcoming[0] ?? null,
    isEmpty: sessions.value.length === 0,
  });
}

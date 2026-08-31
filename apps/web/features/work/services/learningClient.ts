'use client';

/**
 * The Learning, calendar and focus client service (§7.3, §4.8).
 *
 * Writes only. Every one of these surfaces is server-rendered — a reading
 * queue and a meeting-load strip are opened deliberately rather than watched,
 * and polling either would add exactly the background request §1.4's
 * counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** Putting a book down, ending a
 * focus session and correcting a travel flag are state transitions on rows, not
 * appends, and the outbox replays in queue order rather than causal order. A
 * `finished` replayed after a later `abandoned` would leave the item in the
 * wrong state with no error anywhere, and an `end` replayed before its `start`
 * would fail against a session that does not exist yet. The observation path
 * has idempotent inserts to protect it; this path has none, so it stays
 * online-only and the screens say so.
 */

import type { FocusSession, LearningItem, LearningKind, LearningStatus } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/learning', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

export type LearningItemDraft = {
  readonly id: string;
  readonly kind: LearningKind;
  readonly title: string;
  readonly author: string | null;
  readonly url: string | null;
  /** A self-declared total. `null` means no fraction is ever shown — §10.9. */
  readonly totalUnits: number | null;
  readonly unitLabel: string | null;
  readonly skills: readonly string[];
};

export async function createLearningItem(draft: LearningItemDraft): Promise<{ readonly item: LearningItem }> {
  return post({ kind: 'learning_item', item: draft });
}

/**
 * A status change carries the whole progress row.
 *
 * `setProgress` writes `completedUnits` and `synthesis` as given rather than
 * merging, so a caller that omitted them would erase what was recorded on the
 * way past. The screens read the current values back out of the item and send
 * them again.
 */
export type LearningProgressInput = {
  readonly id: string;
  readonly status: LearningStatus;
  readonly completedUnits: number | null;
  readonly synthesis: string | null;
  readonly abandonedReason: string | null;
};

export async function setLearningProgress(
  input: LearningProgressInput,
): Promise<{ readonly item: LearningItem }> {
  return post({ kind: 'learning_progress', progress: input });
}

export type LearningNoteInput = {
  readonly id: string;
  readonly learningItemId: string;
  readonly content: string;
};

export async function addLearningNote(input: LearningNoteInput): Promise<{
  readonly note: {
    readonly id: string;
    readonly learningItemId: string;
    readonly content: string;
    readonly createdAt: string;
  };
}> {
  return post({ kind: 'learning_note', note: input });
}

/**
 * Starting a session. No `dayKey`.
 *
 * The server derives the day from `startedAt` and `zone`. A client that could
 * send the pair separately could send them disagreeing, and a session whose
 * instant and day key point at different days is invisible to exactly the
 * per-day joins §4.8 exists for.
 */
export type FocusStartDraft = {
  readonly id: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly label: string | null;
};

export async function startFocus(draft: FocusStartDraft): Promise<{ readonly session: FocusSession }> {
  return post({ kind: 'focus_start', session: draft });
}

export type FocusEndInput = {
  readonly id: string;
  /** 1–5, the Daily Close scale. Typed in afterwards, never detected. */
  readonly quality: number | null;
  readonly interruptions: number | null;
};

export async function endFocus(input: FocusEndInput): Promise<{ readonly session: FocusSession }> {
  return post({ kind: 'focus_end', end: input });
}

export type CalendarImportOutcome = {
  readonly imported: { readonly inserted: number; readonly updated: number };
  /** Blocks the parser refused, and why. A list rather than a count, so the
   * screen can say what went wrong rather than only how often. */
  readonly skipped: readonly { readonly reason: string; readonly uid: string | null }[];
  /**
   * Recurring events imported as their first occurrence only. Reported rather
   * than swallowed: the meeting-load series understates a calendar that has
   * them, and a reader who is not told will read the shortfall as a quiet week.
   */
  readonly unexpandedRecurrence: number;
};

/**
 * The file body goes over the wire, not a URL.
 *
 * The `.ics` is read client-side and posted. Handing the server a calendar URL
 * to fetch would make this endpoint a proxy for arbitrary outbound requests,
 * aimed by whoever holds a session.
 */
export async function importCalendar(input: {
  readonly content: string;
  readonly zone: string;
}): Promise<CalendarImportOutcome> {
  return post({
    kind: 'calendar_import',
    import: { source: 'ics', content: input.content, zone: input.zone },
  });
}

/**
 * The operator's travel correction, which survives re-import (P5).
 *
 * A flight is not a meeting and no calendar says which is which, so the
 * classification is the operator's and the importer is forbidden from
 * overwriting it.
 */
export async function setEventTravel(
  id: string,
  isTravel: boolean,
): Promise<{ readonly event: { readonly id: string; readonly isTravel: boolean } }> {
  return post({ kind: 'calendar_travel', travel: { id, isTravel } });
}

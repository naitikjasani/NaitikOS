/**
 * Tasks — §4.8.
 *
 * §4.8 spends one sentence on what a task is and two on what it is not:
 *
 *   "**Tasks** — deliberately minimal. Not a competitor to a dedicated task
 *    manager. Its purpose is linkage: a task attached to a goal, a project, or
 *    a health action."
 *
 * That is the whole design brief, and it rules out most of what a task module
 * would otherwise grow. There is no priority, no estimate, no recurrence, no
 * sub-task and no sort order the user maintains by hand. Each of those is a
 * field the operator would feel obliged to fill in before doing the thing they
 * opened the app to record, and §1.4's counter-metric — friction added to
 * capture — is the one this module is most likely to lose against.
 *
 * ## What is here instead: buckets, and one honest one
 *
 * {@link bucketTasks} sorts open tasks into overdue, today, soon, and undated.
 * The fourth bucket is the one that matters. A task manager that forces a date
 * onto everything produces a list where every date is a lie, and the operator
 * stops believing the overdue count within a fortnight. An undated task is
 * allowed to sit undated indefinitely; {@link staleTasks} is how it eventually
 * gets noticed, and it asks a question rather than raising an alarm.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';

/** Mirrors the `work_task_status` pgEnum exactly. */
export const TASK_STATUSES = Object.freeze(['open', 'done', 'dropped'] as const);

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = Object.freeze({
  open: 'Open',
  done: 'Done',
  /* Not "cancelled". A dropped task was a real intention that stopped being
   * one, and §4.10's goal archaeology applies at this scale too. */
  dropped: 'Dropped',
});

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export type Task = {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
  readonly status: TaskStatus;
  readonly projectId: string | null;
  readonly goalId: string | null;
  readonly linkedEntityType: string | null;
  readonly linkedEntityId: string | null;
  readonly dueDayKey: string | null;
  readonly completedAt: string | null;
  readonly completedDayKey: string | null;
  readonly droppedReason: string | null;
  readonly createdAt: string;
};

export type TaskInput = {
  readonly id: string;
  readonly title: string;
  readonly note?: string | null;
  readonly projectId?: string | null;
  readonly goalId?: string | null;
  readonly linkedEntityType?: string | null;
  readonly linkedEntityId?: string | null;
  readonly dueDayKey?: string | null;
};

export function validateTask(input: TaskInput): Result<TaskInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('task_title_empty', 'A task needs a title.'));
  }
  const due = input.dueDayKey ?? null;
  if (due !== null && dayKeyIndex(due) === null) {
    return err(validationError('task_due_invalid', 'dueDayKey must be a YYYY-MM-DD day key.'));
  }

  /*
   * A link is a type and an id or it is neither.
   *
   * §4.8 says linkage is the point of this table, so a half-written link is
   * the failure that matters most: an `entityId` with no `entityType` is a
   * uuid pointing at nothing in particular, and the screen that tried to
   * resolve it would have to guess which table to look in.
   */
  const type = input.linkedEntityType ?? null;
  const id = input.linkedEntityId ?? null;
  if ((type === null) !== (id === null)) {
    return err(
      validationError('task_link_partial', 'A linked entity needs both a type and an id, or neither.'),
    );
  }

  return ok(input);
}

/* -------------------------------------------------------------------------
 * Buckets
 * ---------------------------------------------------------------------- */

/** How far ahead "soon" reaches. A week — the horizon a week has. */
export const SOON_DAYS = 7;

export type TaskBucketKey = 'overdue' | 'today' | 'soon' | 'undated';

export const TASK_BUCKET_LABELS: Readonly<Record<TaskBucketKey, string>> = Object.freeze({
  overdue: 'Overdue',
  today: 'Today',
  soon: 'This week',
  /* Not "no due date", which reads as a defect. It is a legitimate state and
   * naming it neutrally is what stops dates being invented to escape it. */
  undated: 'Someday',
});

export type TaskBuckets = Readonly<Record<TaskBucketKey, readonly Task[]>>;

/**
 * Sort open tasks into four buckets against a day key.
 *
 * Closed tasks are dropped rather than given a bucket of their own: a done
 * list belongs on the day it was done, which is `completedDayKey` and a
 * different question.
 */
export function bucketTasks(tasks: readonly Task[], todayDayKey: string): TaskBuckets {
  const today = dayKeyIndex(todayDayKey);
  const overdue: Task[] = [];
  const due: Task[] = [];
  const soon: Task[] = [];
  const undated: Task[] = [];

  for (const task of tasks) {
    if (task.status !== 'open') continue;

    const key = task.dueDayKey;
    const index = key === null ? null : dayKeyIndex(key);
    if (index === null || today === null) {
      undated.push(task);
      continue;
    }

    const delta = index - today;
    if (delta < 0) overdue.push(task);
    else if (delta === 0) due.push(task);
    else if (delta <= SOON_DAYS) soon.push(task);
    else undated.push(task);
  }

  const byDue = (a: Task, b: Task): number => (a.dueDayKey ?? '').localeCompare(b.dueDayKey ?? '');
  const byAge = (a: Task, b: Task): number => a.createdAt.localeCompare(b.createdAt);

  return Object.freeze({
    overdue: [...overdue].sort(byDue),
    today: [...due].sort(byAge),
    soon: [...soon].sort(byDue),
    /* Oldest first. The undated bucket is where things go to be forgotten, and
     * showing the newest at the top is how it stays that way. */
    undated: [...undated].sort(byAge),
  });
}

/**
 * How long an undated open task has sat before it is worth asking about.
 *
 * Sixty days rather than thirty: this is a linkage table, and a task attached
 * to a goal legitimately waits a season. The question being asked is "is this
 * still a thing", not "why haven't you done this".
 */
export const STALE_TASK_DAYS = 60;

/**
 * Open tasks with no due date that have not been touched in {@link STALE_TASK_DAYS}.
 *
 * Returned rather than acted on. Nothing in this system closes a task on the
 * operator's behalf — P5's "the record is the operator's, and the system does
 * not edit it" holds at the smallest scale too.
 */
export function staleTasks(
  tasks: readonly Task[],
  todayDayKey: string,
  createdDayKeyOf: (task: Task) => string | null,
): readonly Task[] {
  const today = dayKeyIndex(todayDayKey);
  if (today === null) return [];

  return tasks.filter((task) => {
    if (task.status !== 'open' || task.dueDayKey !== null) return false;
    const key = createdDayKeyOf(task);
    const index = key === null ? null : dayKeyIndex(key);
    return index !== null && today - index >= STALE_TASK_DAYS;
  });
}

/**
 * Tasks closed on each of the given days.
 *
 * The shape §4.8 wants for the cross-domain join: "what did I close on the day
 * I slept badly". A count, not a rate — there is no denominator for tasks
 * completed, and dividing by anything would be inventing one.
 */
export function closedPerDay(
  tasks: readonly Task[],
  dayKeys: readonly string[],
): readonly { readonly dayKey: string; readonly closed: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const key = task.completedDayKey;
    if (task.status !== 'done' || key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return dayKeys.map((dayKey) => ({ dayKey, closed: counts.get(dayKey) ?? 0 }));
}

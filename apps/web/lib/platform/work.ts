/**
 * The Work service — §4.8, assembled.
 *
 * §4.8 justifies this pillar by what it explains rather than by what it holds:
 * "work load is a major input to Mind, Sleep, and Gym adherence. This pillar is
 * the missing variable that explains a great many patterns in the others."
 *
 * So the overview is deliberately not a dashboard of work. It is a day-keyed
 * strip — tasks closed per day, alongside nothing else — because the value of
 * that strip is realised when it is laid next to a mood series, and a strip
 * that agreed with nothing else's day boundaries would be worse than no strip.
 *
 * ## Nothing here asserts a cause
 *
 * §4.7 forbids "'Your mood is low because you skipped the gym'", and the same
 * restraint applies in the other direction: a heavy week and a bad night sit
 * next to each other on this page and the system says nothing about which
 * produced which. §10.6's five controls govern any claim stronger than
 * adjacency, and none of them is satisfied by two columns on a screen.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  CareerEntry,
  CareerPeriod,
  DomainError,
  ProjectStanding,
  Task,
  TaskBuckets,
  WorkProject,
} from '@naitikos/core';
import {
  CAREER_GAP_DAYS,
  bucketTasks,
  closedPerDay,
  dayKeyInZone,
  isoFromMillis,
  loggingGap,
  projectStanding,
  shiftDayKey,
  staleTasks,
  summarisePeriod,
  systemClock,
  windowDayKeys,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createWorkRepository } from '@naitikos/db';

/**
 * How far back the overview's closure strip reaches.
 *
 * Twenty-eight days — four whole weeks, so a weekly rhythm is visible as a
 * rhythm rather than as noise from a window that cuts one week in half.
 */
export const WORK_STRIP_DAYS = 28;

/** How much closed history the task list carries. A quarter. */
export const TASK_HISTORY_DAYS = 90;

/** The default career review window, when no period is asked for. A year. */
export const CAREER_PERIOD_DAYS = 365;

export type ClosureDay = {
  readonly dayKey: string;
  readonly closed: number;
};

export type WorkOverview = {
  readonly todayDayKey: string;
  readonly buckets: TaskBuckets;
  readonly stale: readonly Task[];
  readonly projects: readonly (WorkProject & { readonly standing: ProjectStanding })[];
  readonly closures: readonly ClosureDay[];
  readonly recentCareer: readonly CareerEntry[];
  /**
   * Days since the last career entry, or `null` for an empty log.
   *
   * `null` rather than a large number, because "you have never logged anything"
   * and "you have not logged in 400 days" are different sentences and the
   * second one is wrong for a log that has just been created.
   */
  readonly careerGapDays: number | null;
  readonly careerGapThreshold: number;
};

export async function loadWorkOverview(db: Database, zone: string): Promise<Result<WorkOverview, DomainError>> {
  const work = createWorkRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const stripFrom = shiftDayKey(todayDayKey, -(WORK_STRIP_DAYS - 1)) ?? todayDayKey;
  const historyFrom = shiftDayKey(todayDayKey, -TASK_HISTORY_DAYS) ?? todayDayKey;

  const [tasks, projects, closures, career] = await Promise.all([
    work.tasks(historyFrom),
    work.projects(),
    work.tasksClosedBetween(stripFrom, todayDayKey),
    work.careerEntries(20),
  ]);

  if (!tasks.ok) return tasks;
  if (!projects.ok) return projects;
  if (!closures.ok) return closures;
  if (!career.ok) return career;

  const standings = projects.value.map((project) => ({
    ...project,
    standing: projectStanding({
      projectId: project.id,
      tasks: tasks.value,
      careerEntries: career.value,
    }),
  }));

  return ok({
    todayDayKey,
    buckets: bucketTasks(tasks.value, todayDayKey),
    stale: staleTasks(tasks.value, todayDayKey, (task) => dayKeyInZone(task.createdAt, zone)),
    /* Active first, then by most recent activity. A shipped project is history
     * and belongs below the thing being worked on, not interleaved by date. */
    projects: [...standings].sort((a, b) => {
      const rank = (status: string): number => (status === 'active' ? 0 : status === 'paused' ? 1 : 2);
      return (
        rank(a.status) - rank(b.status) ||
        (b.standing.lastActivityAt ?? '').localeCompare(a.standing.lastActivityAt ?? '')
      );
    }),
    closures: closedPerDay(closures.value, windowDayKeys(todayDayKey, WORK_STRIP_DAYS)),
    recentCareer: career.value,
    careerGapDays: loggingGap(career.value, todayDayKey, (instant) => dayKeyInZone(instant, zone)),
    careerGapThreshold: CAREER_GAP_DAYS,
  });
}

export type TaskBoard = {
  readonly todayDayKey: string;
  readonly buckets: TaskBuckets;
  readonly stale: readonly Task[];
  readonly recentlyClosed: readonly Task[];
  readonly projects: readonly WorkProject[];
};

export async function loadTaskBoard(db: Database, zone: string): Promise<Result<TaskBoard, DomainError>> {
  const work = createWorkRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const historyFrom = shiftDayKey(todayDayKey, -TASK_HISTORY_DAYS) ?? todayDayKey;

  const [tasks, projects] = await Promise.all([work.tasks(historyFrom), work.projects()]);
  if (!tasks.ok) return tasks;
  if (!projects.ok) return projects;

  return ok({
    todayDayKey,
    buckets: bucketTasks(tasks.value, todayDayKey),
    stale: staleTasks(tasks.value, todayDayKey, (task) => dayKeyInZone(task.createdAt, zone)),
    recentlyClosed: tasks.value
      .filter((task) => task.status !== 'open')
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 50),
    projects: projects.value,
  });
}

export type ProjectBoard = {
  readonly projects: readonly (WorkProject & {
    readonly standing: ProjectStanding;
    readonly openTaskTitles: readonly string[];
  })[];
};

export async function loadProjects(db: Database): Promise<Result<ProjectBoard, DomainError>> {
  const work = createWorkRepository(db);

  const [projects, tasks, career] = await Promise.all([
    work.projects(),
    work.tasks(),
    work.careerEntries(500),
  ]);
  if (!projects.ok) return projects;
  if (!tasks.ok) return tasks;
  if (!career.ok) return career;

  return ok({
    projects: projects.value.map((project) => ({
      ...project,
      standing: projectStanding({ projectId: project.id, tasks: tasks.value, careerEntries: career.value }),
      openTaskTitles: tasks.value
        .filter((task) => task.projectId === project.id && task.status === 'open')
        .map((task) => task.title)
        .slice(0, 5),
    })),
  });
}

export type CareerBoard = {
  readonly period: CareerPeriod;
  readonly projects: readonly WorkProject[];
  readonly gapDays: number | null;
  readonly gapThreshold: number;
};

export async function loadCareer(
  db: Database,
  zone: string,
  options: { readonly fromDayKey?: string; readonly toDayKey?: string } = {},
): Promise<Result<CareerBoard, DomainError>> {
  const work = createWorkRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const toDayKey = options.toDayKey ?? todayDayKey;
  const fromDayKey = options.fromDayKey ?? shiftDayKey(toDayKey, -CAREER_PERIOD_DAYS) ?? toDayKey;

  /*
   * The query window is widened to whole zoned days at both ends before it
   * touches the database, and then `summarisePeriod` filters again on day keys.
   * Belt and braces on purpose: the repository compares instants, and an entry
   * at 23:00 local on the last day of a review period is inside the period and
   * outside a naive `toDayKey + 'T00:00:00Z'` bound.
   */
  const fromIso = zonedDayBounds(fromDayKey, zone)?.start ?? nowIso;
  const toIso = zonedDayBounds(toDayKey, zone)?.end ?? nowIso;

  const [entries, projects, recent] = await Promise.all([
    work.careerEntriesBetween(fromIso, toIso),
    work.projects(),
    work.careerEntries(1),
  ]);
  if (!entries.ok) return entries;
  if (!projects.ok) return projects;
  if (!recent.ok) return recent;

  return ok({
    period: summarisePeriod(entries.value, fromDayKey, toDayKey, (instant) => dayKeyInZone(instant, zone)),
    projects: projects.value,
    /*
     * The gap is measured against the whole log, not against the window. A
     * review period that ended in March should not report a 150-day silence
     * simply because it is being read in August.
     */
    gapDays: loggingGap(recent.value, todayDayKey, (instant) => dayKeyInZone(instant, zone)),
    gapThreshold: CAREER_GAP_DAYS,
  });
}

export async function searchCareer(
  db: Database,
  query: string,
): Promise<Result<readonly CareerEntry[], DomainError>> {
  return createWorkRepository(db).searchCareer(query);
}

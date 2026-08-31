/**
 * Learning, calendar load, and focus — §4.8's three reading surfaces.
 *
 * §4.8's value is comparability. A learning queue nobody laid beside anything
 * else would be a reading list, and a meeting-minutes series that agreed with
 * nothing else's day boundaries would be worse than no series at all. So every
 * series assembled here is day-keyed through `dayKeyInZone`, the same
 * convention the routine and medication screens use — a 23:30 meeting belongs
 * to the evening it was attended, not to the following UTC morning, and the
 * strips only mean anything stacked if they agree about where a day ends.
 *
 * ## There is deliberately no composite load score
 *
 * Meeting minutes, meeting count, focus minutes and travel are returned as four
 * named figures and never folded into one. A composite would need weights, and
 * the weights would be invented: six hours of meetings is not the same day as
 * six hours of deep work, and a single number renders them identical while
 * looking authoritative about a judgement nobody made deliberately.
 *
 * ## Nothing here asserts a cause
 *
 * A heavy week and a bad night can sit next to each other on these pages and
 * the system says nothing about which produced which. §10.6's five controls
 * govern any claim stronger than adjacency, and none of them is satisfied by
 * two series on a screen.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  FocusSession,
  HourBand,
  LearningItem,
  LoadDay,
  SkillCrossover,
  WorkProject,
} from '@naitikos/core';
import {
  HEAVY_MEETING_MINUTES,
  busiestHours,
  dailyLoad,
  dayKeyInZone,
  focusByHour,
  hourInZone,
  isoFromMillis,
  meanOver,
  queueOrder,
  shiftDayKey,
  skillCrossover,
  systemClock,
  totalFocusMinutes,
  windowDayKeys,
  zonedDayBounds,
} from '@naitikos/core';
import type { CalendarEventRow, Database, LearningNote } from '@naitikos/db';
import { createLearningRepository, createWorkRepository } from '@naitikos/db';

/**
 * How far back the load strip reaches.
 *
 * Twenty-eight days — four whole weeks, so a weekly rhythm reads as a rhythm
 * rather than as noise from a window that cuts one week in half. The same
 * figure the work overview's closure strip uses, because the two are meant to
 * be laid side by side and a strip of a different length cannot be.
 */
export const LOAD_WINDOW_DAYS = 28;

/**
 * How much focus history the hour-of-day chart is built from. A quarter.
 *
 * Longer than the load window on purpose: "when do I start doing real work" is
 * a question about a habit, and a habit is not visible in four weeks of a
 * hand-logged series with gaps in it.
 */
export const FOCUS_WINDOW_DAYS = 90;

export type LearningBoard = {
  readonly items: readonly LearningItem[];
  readonly notes: readonly LearningNote[];
  readonly crossover: SkillCrossover;
};

export async function loadLearning(db: Database): Promise<Result<LearningBoard, DomainError>> {
  const learning = createLearningRepository(db);
  const work = createWorkRepository(db);

  const [items, notes, career] = await Promise.all([
    learning.items(),
    learning.notes(),
    /*
     * The whole log, near enough. The crossover is a set comparison, so an
     * entry missed at the tail silently removes a skill from "applied" and
     * moves it into "studied and never applied" — a wrong sentence produced by
     * a page limit rather than by anything the operator did.
     */
    work.careerEntries(500),
  ]);

  if (!items.ok) return items;
  if (!notes.ok) return notes;
  if (!career.ok) return career;

  return ok({
    items: queueOrder(items.value),
    notes: notes.value,
    crossover: skillCrossover(
      items.value,
      career.value.flatMap((entry) => entry.skills),
    ),
  });
}

export type CalendarBoard = {
  readonly todayDayKey: string;
  readonly days: readonly LoadDay[];
  readonly events: readonly CalendarEventRow[];
  readonly meanMeetingMinutes: number | null;
  readonly heavyThreshold: number;
  readonly travelDays: number;
};

export async function loadCalendar(db: Database, zone: string): Promise<Result<CalendarBoard, DomainError>> {
  const learning = createLearningRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const fromDayKey = shiftDayKey(todayDayKey, -(LOAD_WINDOW_DAYS - 1)) ?? todayDayKey;

  /*
   * The event query is bounded by instants, so the window is widened to whole
   * zoned days at both ends before it reaches the database. A meeting at 08:00
   * on the first day of the window is inside the window and outside a naive
   * `fromDayKey + 'T00:00:00Z'` bound for any zone east of UTC.
   */
  const fromIso = zonedDayBounds(fromDayKey, zone)?.start ?? nowIso;
  const toIso = zonedDayBounds(todayDayKey, zone)?.end ?? nowIso;

  const [events, sessions] = await Promise.all([
    learning.eventsBetween(fromIso, toIso),
    learning.sessionsBetween(fromDayKey, todayDayKey),
  ]);
  if (!events.ok) return events;
  if (!sessions.ok) return sessions;

  const days = dailyLoad({
    dayKeys: windowDayKeys(todayDayKey, LOAD_WINDOW_DAYS),
    events: events.value,
    sessions: sessions.value,
    dayKeyOf: (instant) => dayKeyInZone(instant, zone),
  });

  return ok({
    todayDayKey,
    days,
    /*
     * Newest first — the calendar is read to answer "what has this month been
     * like", and that question starts at today and works backwards. Capped
     * because a busy quarter is thousands of rows and no list of that length
     * is read.
     */
    events: [...events.value].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, 100),
    /*
     * Days with no meeting recorded are left out of the mean rather than
     * counted as zeroes. A day with no rows is indistinguishable from a day the
     * calendar was never imported for, and averaging the second kind in turns
     * a gap in the import into a claim about how the operator spent their week.
     * The figure is therefore "the average meeting day", which is the number
     * worth having anyway.
     */
    meanMeetingMinutes: meanOver(
      days.filter((day) => day.meetingCount > 0).map((day) => day.meetingMinutes),
    ),
    heavyThreshold: HEAVY_MEETING_MINUTES,
    travelDays: days.filter((day) => day.isTravel).length,
  });
}

export type FocusBoard = {
  readonly todayDayKey: string;
  readonly sessions: readonly FocusSession[];
  readonly byHour: readonly HourBand[];
  readonly busiest: readonly HourBand[];
  readonly totalMinutes: number;
  readonly days: readonly LoadDay[];
  readonly projects: readonly WorkProject[];
};

export async function loadFocus(db: Database, zone: string): Promise<Result<FocusBoard, DomainError>> {
  const learning = createLearningRepository(db);
  const work = createWorkRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const focusFromDayKey = shiftDayKey(todayDayKey, -(FOCUS_WINDOW_DAYS - 1)) ?? todayDayKey;
  const loadFromDayKey = shiftDayKey(todayDayKey, -(LOAD_WINDOW_DAYS - 1)) ?? todayDayKey;

  const loadFromIso = zonedDayBounds(loadFromDayKey, zone)?.start ?? nowIso;
  const toIso = zonedDayBounds(todayDayKey, zone)?.end ?? nowIso;

  const [sessions, events, projects] = await Promise.all([
    learning.sessionsBetween(focusFromDayKey, todayDayKey),
    /*
     * Meetings are read over the shorter load window only. The strip on this
     * page is the same twenty-eight days the calendar page draws — same window,
     * same day convention — so the two can be read against each other without
     * anyone having to align them by eye.
     */
    learning.eventsBetween(loadFromIso, toIso),
    work.projects(),
  ]);
  if (!sessions.ok) return sessions;
  if (!events.ok) return events;
  if (!projects.ok) return projects;

  const byHour = focusByHour(sessions.value, hourInZone);

  return ok({
    todayDayKey,
    sessions: sessions.value,
    byHour,
    busiest: busiestHours(byHour),
    totalMinutes: totalFocusMinutes(sessions.value),
    /* The quarter of sessions is passed whole; `dailyLoad` reads only the day
     * keys it was given, so the ones outside the strip cost a map insert and
     * nothing else — cheaper than a second round trip for a subset. */
    days: dailyLoad({
      dayKeys: windowDayKeys(todayDayKey, LOAD_WINDOW_DAYS),
      events: events.value,
      sessions: sessions.value,
      dayKeyOf: (instant) => dayKeyInZone(instant, zone),
    }),
    projects: projects.value,
  });
}

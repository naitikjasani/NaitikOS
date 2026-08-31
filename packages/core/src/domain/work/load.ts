/**
 * Work load — §4.8's actual payoff.
 *
 * §4.8 names calendar's value precisely, and it is not scheduling:
 *
 *   "Its value is context: the load, travel, and meeting density that explains
 *    a bad week in every other domain."
 *
 * So this file turns calendar events and focus sessions into a day-keyed series
 * that can be laid alongside sleep, mood and training. It computes minutes and
 * counts. **It never says that a heavy day caused anything**, and there is no
 * function here that would let a caller phrase it that way — §10.6's five
 * controls govern any claim stronger than adjacency, and none of them is
 * satisfied by two series on a screen.
 *
 * ## Why there is no single "load score"
 *
 * A composite would need weights, and the weights would be invented. Six hours
 * of meetings and six hours of uninterrupted deep work are both a full day and
 * they are not the same day; a number that rendered them identical would look
 * authoritative while carrying an assumption nobody made deliberately. Four
 * separate figures, named, is the honest shape.
 */

import { dayKeyIndex } from '../../temporal/instant';
import { parseInstant } from '../../temporal/instant';

export type LoadEvent = {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly isAllDay: boolean;
  readonly isAccepted: boolean | null;
  readonly isTravel: boolean;
  readonly attendeeCount: number | null;
};

export type LoadSession = {
  readonly id: string;
  readonly dayKey: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly quality: number | null;
  readonly interruptions: number | null;
};

export type LoadDay = {
  readonly dayKey: string;
  /** Minutes in accepted, timed, non-travel events. */
  readonly meetingMinutes: number;
  readonly meetingCount: number;
  readonly focusMinutes: number;
  readonly focusSessions: number;
  readonly isTravel: boolean;
};

/**
 * A day with more meeting hours than this is worth being able to see at a
 * glance. Four — half a working day gone before anything is made.
 *
 * A threshold for *display*, not a judgement encoded as data. Nothing is stored
 * against it and no insight is derived from it.
 */
export const HEAVY_MEETING_MINUTES = 240;

/**
 * A day's load, for each of the given day keys.
 *
 * `dayKeyOf` is injected so the caller supplies the zone (§5.3). An event at
 * 23:30 local is on the day it was attended, not on the UTC day the instant
 * happens to fall in, and getting that wrong shifts every late meeting onto the
 * following morning.
 */
export function dailyLoad(input: {
  readonly dayKeys: readonly string[];
  readonly events: readonly LoadEvent[];
  readonly sessions: readonly LoadSession[];
  readonly dayKeyOf: (instant: string) => string;
}): readonly LoadDay[] {
  const byDay = new Map<string, { meetingMinutes: number; meetingCount: number; travel: boolean }>();
  for (const dayKey of input.dayKeys) {
    byDay.set(dayKey, { meetingMinutes: 0, meetingCount: 0, travel: false });
  }

  for (const event of input.events) {
    const dayKey = input.dayKeyOf(event.startsAt);
    const bucket = byDay.get(dayKey);
    if (bucket === undefined) continue;

    /*
     * Travel marks the day and contributes no minutes. A flight is not a
     * meeting, and folding six hours of it into "meeting minutes" would make
     * the one series that explains a bad week explain it wrongly.
     */
    if (event.isTravel) {
      bucket.travel = true;
      continue;
    }

    /* A declined meeting is not load. `null` — never answered — counts, because
     * an unanswered invitation is usually one that was attended anyway. */
    if (event.isAccepted === false) continue;

    /*
     * An all-day event has no duration to count. It is usually a marker — a
     * holiday, a conference day — and treating it as 1440 minutes of meetings
     * would swamp every real number in the series.
     */
    if (event.isAllDay) continue;

    bucket.meetingCount += 1;
    bucket.meetingMinutes += minutesBetween(event.startsAt, event.endsAt);
  }

  const focus = new Map<string, { minutes: number; count: number }>();
  for (const session of input.sessions) {
    const bucket = focus.get(session.dayKey) ?? { minutes: 0, count: 0 };
    bucket.count += 1;
    bucket.minutes += minutesBetween(session.startedAt, session.endedAt);
    focus.set(session.dayKey, bucket);
  }

  return input.dayKeys.map((dayKey) => {
    const meetings = byDay.get(dayKey) ?? { meetingMinutes: 0, meetingCount: 0, travel: false };
    const deep = focus.get(dayKey) ?? { minutes: 0, count: 0 };
    return {
      dayKey,
      meetingMinutes: meetings.meetingMinutes,
      meetingCount: meetings.meetingCount,
      focusMinutes: deep.minutes,
      focusSessions: deep.count,
      isTravel: meetings.travel,
    };
  });
}

/**
 * Whole minutes between two instants, or `0` when the end is missing.
 *
 * Zero rather than a guessed default. An event with no end time is one the
 * calendar did not state a duration for, and inventing thirty minutes would put
 * a fabricated figure into a series whose entire purpose is being compared
 * against real ones.
 */
export function minutesBetween(from: string, to: string | null): number {
  if (to === null) return 0;
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (start === null || end === null) return 0;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return minutes > 0 ? minutes : 0;
}

/**
 * The mean of a numeric series, ignoring days with nothing recorded.
 *
 * Returns `null` for an empty series rather than `0`. A week with no calendar
 * imported has no average meeting load, and reporting zero would state that the
 * operator had no meetings — which is a claim about their week rather than
 * about the data.
 */
export function meanOver(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Days ordered by focus minutes, best first.
 *
 * Deliberately not "your most productive days". They are the days with the most
 * recorded deep work, which is a different and much weaker statement — the
 * operator logs these by hand and a day they forgot to log is not a day they
 * did nothing.
 */
export function bestFocusDays(days: readonly LoadDay[], limit = 5): readonly LoadDay[] {
  return [...days]
    .filter((day) => day.focusMinutes > 0)
    .sort((a, b) => b.focusMinutes - a.focusMinutes || a.dayKey.localeCompare(b.dayKey))
    .slice(0, limit);
}

/** Whether a day key sits inside a window, inclusive at both ends. */
export function withinWindow(dayKey: string, fromDayKey: string, toDayKey: string): boolean {
  const index = dayKeyIndex(dayKey);
  const from = dayKeyIndex(fromDayKey);
  const to = dayKeyIndex(toDayKey);
  if (index === null || from === null || to === null) return false;
  return index >= from && index <= to;
}

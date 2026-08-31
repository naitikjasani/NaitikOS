/**
 * Review periods — §4.12.
 *
 * §4.12 asks for "weekly, monthly, and annual reviews... permanently archived as
 * first-class documents". A document that is archived forever needs a period
 * that is defined once and identically everywhere: the label printed on it, the
 * `(kind, period_start)` unique key it is stored under, and the window the
 * figures were drawn from all have to agree, in 2026 and in 2046.
 *
 * So the period is computed here, in `core`, and nowhere else. Two functions
 * that each "obviously" computed the Monday of a week would agree for years and
 * then disagree across a new year, which is exactly the week nobody checks.
 *
 * ## Weeks are ISO weeks, Monday to Sunday
 *
 * Not "the last seven days", and not Sunday-first. The ISO rule — week 1 is the
 * week containing the first Thursday — is already implemented once in
 * `timeline/grouping.ts`, and {@link weekLabel} calls it rather than restating
 * it. A second implementation of ISO week numbering is a second chance to get
 * 29 December wrong.
 */

import { weekKeyInZone } from '../../timeline/grouping';
import { dayKeyIndex, isoWeekday, shiftDayKey, utcDayKey, utcNoonAt, utcNoonOn } from '../../temporal/instant';

/** Mirrors the `review_kind` pgEnum exactly. */
export const REVIEW_KINDS = Object.freeze(['weekly', 'monthly', 'quarterly', 'annual'] as const);

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_KIND_LABELS: Readonly<Record<ReviewKind, string>> = Object.freeze({
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
});

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

/**
 * Mirrors the `review_state` pgEnum exactly.
 *
 * Three states rather than a boolean, because §4.12 distinguishes a draft
 * nobody has opened from one being worked on: "a review the user did not edit
 * is a review they did not do". `drafted` and `editing` are both incomplete,
 * and they are incomplete for different reasons.
 */
export const REVIEW_STATES = Object.freeze(['drafted', 'editing', 'complete'] as const);

export type ReviewState = (typeof REVIEW_STATES)[number];

export function isReviewState(value: string): value is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(value);
}

/**
 * A closed calendar window, inclusive at both ends.
 *
 * Day keys rather than instants. §5.3 keeps zone interpretation at the edge, and
 * a period boundary expressed as a timestamp would silently move an evening's
 * entries between two reviews depending on where the operator was standing.
 * A calendar label has no duration and therefore no zone to get wrong.
 */
export type ReviewPeriod = {
  readonly kind: ReviewKind;
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly label: string;
};

const MONTH_NAMES: readonly string[] = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

/**
 * The ISO week label for a day key, `2026-W35`.
 *
 * Delegates to `weekKeyInZone` by anchoring the day key at UTC noon and reading
 * it in UTC — which round-trips to the same day key, so the zone conversion is
 * a no-op and the only logic doing work is the ISO week arithmetic already
 * written there. Noon rather than midnight for the reason `utcNoonOn` gives.
 */
function weekLabel(dayKey: string): string {
  return weekKeyInZone(`${dayKey}T12:00:00.000Z`, 'UTC');
}

/** The last day of a month, as a day key. Months are 1-based. */
function lastDayOfMonth(year: number, month: number): string {
  /* Day 0 of the following month is the last day of this one, and it rolls the
   * year correctly for December without a special case. This is also what makes
   * February right in a leap year without a table. */
  return utcDayKey(utcNoonAt(year, month + 1, 0));
}

/** The calendar parts of a day key. `null` if it is not a real date. */
function partsOf(dayKey: string): { year: number; month: number } | null {
  const anchor = utcNoonOn(dayKey);
  if (anchor === null) return null;
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1 };
}

/**
 * The period of the given kind that contains a day.
 *
 * @returns `null` if `dayKey` is not a real date. Not a fallback period — a
 *   malformed key must not silently produce a review of an arbitrary window,
 *   because the window is what every figure in the draft is drawn from.
 */
export function periodContaining(kind: ReviewKind, dayKey: string): ReviewPeriod | null {
  const parts = partsOf(dayKey);
  const anchor = utcNoonOn(dayKey);
  if (parts === null || anchor === null) return null;

  if (kind === 'weekly') {
    /* Back to Monday. `isoWeekday` is Monday = 1, which is the whole reason it
     * exists — `getUTCDay()` returns 0 for Sunday and is the standard source of
     * off-by-one week boundaries. */
    const from = shiftDayKey(dayKey, -(isoWeekday(anchor) - 1));
    if (from === null) return null;
    const to = shiftDayKey(from, 6);
    if (to === null) return null;
    return { kind, fromDayKey: from, toDayKey: to, label: weekLabel(from) };
  }

  if (kind === 'monthly') {
    const month = String(parts.month).padStart(2, '0');
    return {
      kind,
      fromDayKey: `${String(parts.year)}-${month}-01`,
      toDayKey: lastDayOfMonth(parts.year, parts.month),
      label: `${MONTH_NAMES[parts.month - 1] ?? month} ${String(parts.year)}`,
    };
  }

  if (kind === 'quarterly') {
    const quarter = Math.floor((parts.month - 1) / 3) + 1;
    const firstMonth = (quarter - 1) * 3 + 1;
    return {
      kind,
      fromDayKey: `${String(parts.year)}-${String(firstMonth).padStart(2, '0')}-01`,
      toDayKey: lastDayOfMonth(parts.year, firstMonth + 2),
      label: `${String(parts.year)} Q${String(quarter)}`,
    };
  }

  return {
    kind,
    fromDayKey: `${String(parts.year)}-01-01`,
    toDayKey: `${String(parts.year)}-12-31`,
    label: String(parts.year),
  };
}

/**
 * The period immediately before this one.
 *
 * Computed from the day before `fromDayKey` rather than by subtracting a
 * duration, so it is right for every kind at once and right across a year
 * boundary where an ISO week belongs to the following year.
 */
export function previousPeriod(period: ReviewPeriod): ReviewPeriod | null {
  const before = shiftDayKey(period.fromDayKey, -1);
  return before === null ? null : periodContaining(period.kind, before);
}

/**
 * Whether the period has ended.
 *
 * **Load-bearing, and the UI must refuse to draft a review when this is false.**
 * A review of a period that has not ended yet is a review of a partial record:
 * the sleep mean is over four nights of seven, the training count is short by
 * however many sessions are still to come, and none of the figures say so
 * because they are all true of the days that exist. §4.12 makes the review a
 * permanent archived document, and a permanent document that quietly describes
 * three days of a week as the week is a lie the archive keeps.
 *
 * Strictly after the last day, not on it. The last day of a period is still
 * being lived, and a review drafted at breakfast on Sunday has not seen Sunday.
 *
 * @returns `false` for a `todayDayKey` that is not a real date — the safe
 *   direction, since it refuses to draft rather than drafting from a window it
 *   cannot place.
 */
export function isPeriodClosed(period: ReviewPeriod, todayDayKey: string): boolean {
  const today = dayKeyIndex(todayDayKey);
  const end = dayKeyIndex(period.toDayKey);
  if (today === null || end === null) return false;
  return today > end;
}

/** A guard against a caller asking for a thousand years of weeks. */
const MAX_RECENT_PERIODS = 200;

/**
 * The most recent periods of a kind, newest first, starting with the one
 * containing `todayDayKey`.
 *
 * The current, unfinished period **is** included. It is what a review picker
 * has to show — the operator is looking at this week — and hiding it would make
 * the list silently disagree with the calendar. Whether it can be drafted is
 * {@link isPeriodClosed}'s answer, and keeping those two questions apart is what
 * stops "which periods exist" from quietly becoming "which periods are allowed".
 */
export function recentPeriods(
  kind: ReviewKind,
  todayDayKey: string,
  count: number,
): readonly ReviewPeriod[] {
  if (count <= 0) return [];

  const periods: ReviewPeriod[] = [];
  let cursor = periodContaining(kind, todayDayKey);
  const wanted = Math.min(count, MAX_RECENT_PERIODS);

  while (cursor !== null && periods.length < wanted) {
    periods.push(cursor);
    cursor = previousPeriod(cursor);
  }

  return periods;
}

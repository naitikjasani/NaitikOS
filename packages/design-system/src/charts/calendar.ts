/**
 * Civil-date arithmetic on `YYYY-MM-DD`, with no `Date` anywhere.
 *
 * ## Why the design system does its own calendar maths
 *
 * §11.3 bans raw `Date` construction outside `core/temporal`, and the ban is
 * right: `new Date('2026-08-17')` discards the zone, and a chart that
 * re-derives a day from an instant re-derives it in the *runtime's* zone rather
 * than the observer's. That is the §5.3 bug — every Indian evening filed under
 * the following date — arriving through the axis labels.
 *
 * The resolution is that **charts never see instants.** A `SeriesPoint.at` is a
 * day key that `core` has already resolved in the zone the observation was
 * captured in. All this file has to do is place those keys on an axis and label
 * them, which is integer arithmetic on the proleptic Gregorian calendar.
 *
 * The algorithms are Howard Hinnant's `days_from_civil` / `civil_from_days`,
 * which are exact for every date in the range this record will ever hold and
 * have no dependency on locale, zone, or a leap-second table.
 *
 * @see https://howardhinnant.github.io/date_algorithms.html
 */

/** Days from 1970-01-01 for a `YYYY-MM-DD`. `null` if it is not a real date. */
export function dayIndex(dayKey: string): number | null {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const index = daysFromCivil(year, month, day);
  // Round-trip check: rejects 2026-02-31, which the arithmetic would otherwise
  // silently roll into March exactly as `Date` does.
  return dayKeyOf(index) === dayKey ? index : null;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.trunc((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The `YYYY-MM-DD` at a day index. The inverse of {@link dayIndex}. */
export function dayKeyOf(index: number): string {
  const shifted = index + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.trunc(
    (dayOfEra - Math.trunc(dayOfEra / 1460) + Math.trunc(dayOfEra / 36_524) - Math.trunc(dayOfEra / 146_096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100));
  const monthPrime = Math.trunc((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.trunc((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);

  const finalYear = year + (month <= 2 ? 1 : 0);
  return `${String(finalYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * ISO weekday: Monday = 1 … Sunday = 7.
 *
 * 1970-01-01 was a Thursday, which is ISO 4. Everything else follows.
 */
export function weekdayOf(index: number): number {
  return ((((index + 3) % 7) + 7) % 7) + 1;
}

/** The Monday of the week containing this day. */
export function weekStartIndex(index: number): number {
  return index - (weekdayOf(index) - 1);
}

const MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/**
 * A short axis label: `17 Aug`, or `17 Aug 26` when the range crosses a year.
 *
 * Formatted here rather than through `Intl` because an axis tick has a hard
 * width budget at 360px and `Intl`'s short formats vary by locale in ways that
 * silently overflow it. The record is single-user (C1) and its dates are read
 * by one person; a stable, compact format beats a localised, variable one.
 */
export function axisLabel(index: number, includeYear = false): string {
  const key = dayKeyOf(index);
  const day = Number(key.slice(8, 10));
  const month = MONTHS[Number(key.slice(5, 7)) - 1] ?? '';
  return includeYear ? `${String(day)} ${month} ${key.slice(2, 4)}` : `${String(day)} ${month}`;
}

/** `August 2026`, for the adherence grid's month rule. */
export function monthLabel(index: number): string {
  const key = dayKeyOf(index);
  return `${MONTHS[Number(key.slice(5, 7)) - 1] ?? ''} ${key.slice(0, 4)}`;
}

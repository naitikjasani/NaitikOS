/**
 * Timeline grouping and zone-aware day bucketing.
 *
 * The whole file exists because of one sentence in §5.3:
 *
 *   "A workout at '7am' during travel is a materially different fact from one at
 *    7am at home, and discarding the zone destroys information you cannot
 *    recover."
 *
 * So a timeline day is a day *in the zone the event was captured in*, not a UTC
 * day and not a day in the reader's current zone. An entry recorded at 23:30 in
 * Asia/Kolkata belongs to that date, even though it is 18:00 UTC and the user is
 * now in London.
 *
 * This is the same class of error as the design system's `date_trunc` deviation:
 * `AT TIME ZONE 'UTC'` compiles, looks right, and files every Indian evening
 * under the following date.
 */

import {
  addUtcDays,
  isoWeekday,
  parseInstant,
  utcDayKey,
  utcDaysBetween,
  utcNoonAt,
  utcNoonOn,
} from '../temporal/instant';
import type { TimelineEntry, TimelineGroup, TimelineGrouping } from './types';

/**
 * The `YYYY-MM-DD` a timestamp falls on in a given zone.
 *
 * Uses `Intl` rather than arithmetic on offsets, because an offset is not a
 * zone: a fixed `+05:30` cannot express a DST transition, and hand-rolled offset
 * maths is wrong twice a year in every zone that observes one.
 *
 * `en-CA` because its short date format is ISO-ordered (`2026-08-03`), which
 * avoids reformatting the parts by hand.
 */
export function dayKeyInZone(instant: string, zone: string): string {
  /**
   * The fallback, used for an unrecognised zone or an unparseable instant.
   *
   * Falls back to the leading ten characters rather than throwing. A malformed
   * zone should mis-file one entry, not make the timeline unrenderable — §5.3's
   * information loss is a smaller harm than a blank screen. Note the consequence:
   * for genuinely malformed input the returned key is not a date.
   */
  const fallback = instant.slice(0, 10);

  const parsed = parseInstant(instant);
  if (parsed === null) return fallback;

  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(parsed);
  } catch {
    // An unrecognised IANA zone. `Intl` throws rather than falling back.
    return fallback;
  }
}

/** ISO week key, `2026-W32`. */
export function weekKeyInZone(instant: string, zone: string): string {
  const dayKey = dayKeyInZone(instant, zone);

  // Anchored at UTC noon: starting from midnight and then shifting by days can
  // slip a date under some engines' handling, and the anchor only has to be
  // *within* the correct day.
  const anchored = utcNoonOn(dayKey);
  // A malformed instant already produced a non-date key; there is no week to
  // compute, so the day key is the most truthful thing to group by.
  if (anchored === null) return dayKey;

  // ISO 8601: week 1 is the week containing the first Thursday. Shifting to the
  // Thursday of this week and reading *its* year is the standard trick, and the
  // only way 29 December 2025 lands in 2026-W01 correctly.
  const thursday = addUtcDays(anchored, 4 - isoWeekday(anchored));
  const isoYear = thursday.getUTCFullYear();

  // 4 January is always in week 1, so the Thursday of its week is week 1's
  // Thursday.
  const jan4 = utcNoonAt(isoYear, 1, 4);
  const firstThursday = addUtcDays(jan4, 4 - isoWeekday(jan4));

  const week = 1 + Math.round(utcDaysBetween(firstThursday, thursday) / 7);
  return `${String(isoYear)}-W${String(week).padStart(2, '0')}`;
}

/** Month key, `2026-08`. */
export function monthKeyInZone(instant: string, zone: string): string {
  return dayKeyInZone(instant, zone).slice(0, 7);
}

/**
 * Group entries.
 *
 * Preserves the order entries arrive in — the store has already sorted by
 * sequence, and re-sorting here would silently override a `direction=forward`
 * query.
 *
 * `correlation` grouping is the one worth understanding: it collects everything
 * from a single user action, so a Daily Close appears as one group of a dozen
 * entries rather than a dozen unrelated rows. That is what makes §3.2's
 * `/timeline/:date` "single day, fully expanded" view legible.
 */
export function groupEntries(
  entries: readonly TimelineEntry[],
  grouping: TimelineGrouping,
  profileZone: string,
): readonly TimelineGroup[] {
  if (grouping === 'none') {
    return [{ key: 'all', label: 'All', entries }];
  }

  const order: string[] = [];
  const buckets = new Map<string, TimelineEntry[]>();

  for (const entry of entries) {
    const zone = entry.zone ?? profileZone;
    const key =
      grouping === 'day'
        ? entry.occurredOn
        : grouping === 'week'
          ? weekKeyInZone(entry.occurredAt, zone)
          : grouping === 'month'
            ? monthKeyInZone(entry.occurredAt, zone)
            : entry.correlationId;

    const existing = buckets.get(key);
    if (existing === undefined) {
      order.push(key);
      buckets.set(key, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return order.map((key) => ({
    key,
    label: labelForGroup(key, grouping, buckets.get(key) ?? []),
    entries: buckets.get(key) ?? [],
  }));
}

/**
 * A human label for a group key.
 *
 * Correlation groups are labelled from their most significant entry, because a
 * UUID is not a heading. If a Daily Close is in the group, that is the label; a
 * workout group reads "Training session completed".
 */
function labelForGroup(
  key: string,
  grouping: TimelineGrouping,
  entries: readonly TimelineEntry[],
): string {
  if (grouping !== 'correlation') return key;

  const primary = entries.find((entry) => entry.significance === 'primary');
  return primary?.title ?? entries[0]?.title ?? key;
}

/**
 * Days in a range that have no entries.
 *
 * Not cosmetic. §9.8's photo series and §8.9(3)'s charts both insist that
 * missing data is shown as missing — "Gaps are gaps… Interpolation across a week
 * of no data is fabrication." A timeline that silently skips empty days makes a
 * three-week gap in the record look like three consecutive entries, which is the
 * single most misleading thing this surface could do.
 *
 * @returns `YYYY-MM-DD` keys with no entry, ascending.
 */
export function emptyDaysInRange(
  entries: readonly TimelineEntry[],
  from: string,
  until: string,
  zone: string,
): readonly string[] {
  const present = new Set(entries.map((entry) => entry.occurredOn));
  const gaps: string[] = [];

  const start = utcNoonOn(dayKeyInZone(from, zone));
  const end = utcNoonOn(dayKeyInZone(until, zone));
  // A malformed bound gives no range to walk. Reporting no gaps is the safe
  // direction: claiming a gap that may not exist would be the fabrication §8.9(3)
  // forbids, in the opposite direction.
  if (start === null || end === null) return [];

  // Bounded so a malformed range cannot spin: five and a half years of days is
  // well past any view the UI offers.
  const MAX_DAYS = 2000;

  let cursor = start;
  for (let walked = 0; cursor <= end && walked < MAX_DAYS; walked += 1) {
    const key = utcDayKey(cursor);
    if (!present.has(key)) gaps.push(key);
    cursor = addUtcDays(cursor, 1);
  }

  return gaps;
}

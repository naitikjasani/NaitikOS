/**
 * One day, fully expanded — §3.2's `/timeline/:date`.
 *
 * ## What "fully expanded" means, and why it needs its own route
 *
 * `/timeline` runs with `includeDetail: false`. §9.x's reasoning is on the
 * query type itself: *"A workout of forty sets emits forty `Workout.SetLogged`
 * events, and a collapsed timeline showing all of them buries the rest of the
 * day."* The collapsed view is right for scrolling a month.
 *
 * This is the other need — *what actually happened on the fourteenth* — and it
 * is the only surface that answers it. So `includeDetail` is true here, and the
 * route exists precisely because the two settings cannot both be the default.
 *
 * ## Grouped by correlation, not flat
 *
 * Forty sets in chronological order is a wall. Grouped by `correlationId` they
 * sit under "Training session completed", which is the shape the day actually
 * had — `groupEntries` already labels a correlation group from its most
 * significant entry, because a UUID is not a heading.
 *
 * ## Forward order, unlike everywhere else
 *
 * Every other timeline view is newest-first, because scrolling a record means
 * starting from now. A single day reads forwards: morning, then afternoon, then
 * the Close. Reversing it would make the Daily Close the first thing on the page
 * and the workout that preceded it the last.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, TimelineEntry, TimelineGroup } from '@naitikos/core';
import { dayKeyIndex, groupEntries, shiftDayKey, zonedDayBounds } from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createTimelineRepository } from '@naitikos/db';

/**
 * The most entries one day's page will render.
 *
 * Two hundred. A heavy day — a long workout, a full Close, several meals — runs
 * to perhaps eighty entries with detail included; two hundred is comfortably
 * above any honest day and low enough that a projector bug producing thousands
 * does not hang the page. If it is ever hit, the count says so rather than the
 * list quietly ending.
 */
export const DAY_ENTRY_LIMIT = 200;

export type TimelineDay = {
  readonly dayKey: string;
  /** Grouped by correlation, in the order things happened. */
  readonly groups: readonly TimelineGroup[];
  readonly entryCount: number;
  /** True when the day held more than {@link DAY_ENTRY_LIMIT} entries. */
  readonly truncated: boolean;
  readonly previousDayKey: string | null;
  readonly nextDayKey: string | null;
  readonly zone: string;
};

export async function loadTimelineDay(
  db: Database,
  dayKey: string,
  zone: string,
): Promise<Result<TimelineDay | null, DomainError>> {
  /*
   * An unreadable day key is `null`, not an error. The value comes out of a URL
   * segment, so `/timeline/yesterday` is a thing a person will type — and a 404
   * is the honest answer to a date that does not exist, where a 500 would say
   * the system broke.
   */
  if (dayKeyIndex(dayKey) === null) return ok(null);

  const bounds = zonedDayBounds(dayKey, zone);
  if (bounds === null) return ok(null);

  const page = await createTimelineRepository(db).query(
    {
      from: bounds.start,
      until: bounds.end,
      /* The whole point of this route. See the header. */
      includeDetail: true,
      grouping: 'correlation',
      direction: 'forward',
      limit: DAY_ENTRY_LIMIT,
    },
    zone,
  );
  if (!page.ok) return page;

  return ok({
    dayKey,
    /*
     * Regrouped rather than trusting `page.groups`.
     *
     * The repository groups the page it returned, which is correct — but this
     * surface also needs the groups in *occurrence* order, and a keyset page is
     * ordered by sequence. Re-running `groupEntries` over the sorted entries is
     * cheap at a day's scale and keeps the ordering rule in one place.
     */
    groups: groupEntries(sortByOccurrence(page.value.entries), 'correlation', zone),
    entryCount: page.value.entries.length,
    truncated: page.value.hasMore,
    previousDayKey: shiftDayKey(dayKey, -1),
    nextDayKey: shiftDayKey(dayKey, 1),
    zone,
  });
}

/**
 * Chronological, with `sequence` as the tie-break.
 *
 * Two entries can share an instant — a Close writes several observations in one
 * transaction — and `occurredAt` alone would order them arbitrarily on each
 * read. `sequence` is monotonic in the event log, so it is the stable
 * second key, and it makes the page render the same way twice.
 */
function sortByOccurrence(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  return [...entries].sort(
    (left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence,
  );
}

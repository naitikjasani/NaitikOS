/**
 * Instant parsing and calendar arithmetic.
 *
 * ## Why this file exists
 *
 * §11.3 bans `new Date()` repo-wide and §5.3 explains why — a bare `Date`
 * discards the zone an event was captured in, and "discarding the zone destroys
 * information you cannot recover."
 *
 * But the ban needs somewhere to point for the *other* use of `Date`: parsing an
 * explicit ISO instant, and doing calendar arithmetic on a known day. That is not
 * reading the wall clock — the zone was never in the string being discarded,
 * because a `Z`-suffixed instant does not carry one. `clock.ts` covers "what time
 * is it"; this covers "what does this timestamp mean".
 *
 * Without it, every timezone-aware helper in the system is obliged to carry an
 * `eslint-disable`, which is how a rule stops being read and starts being
 * pattern-matched past.
 *
 * ## What it deliberately is not
 *
 * Not a date library. No formatting, no locale handling, no durations. Those
 * belong in the timezone-aware helpers §5.3 requires for observations (§12,
 * Week 1–2) and several of them will want `Intl` rather than arithmetic.
 * Everything here is the narrow set the event backbone needs.
 *
 * ## Every function is total
 *
 * A malformed instant returns `null`, never an `Invalid Date`. An `Invalid Date`
 * propagates silently — `.getTime()` gives `NaN`, comparisons are all false, and
 * `toISOString()` throws several frames from the cause. Returning `null` forces
 * the caller to decide, at the point where it still knows what to do.
 */

/**
 * Parse an ISO-8601 instant.
 *
 * @returns `null` for anything unparseable, including the empty string.
 */
export function parseInstant(iso: string): Date | null {
  if (iso === '') return null;

  // The sanctioned parse point (§11.3). Parsing an explicit instant, not reading the wall clock; see the file header.
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Normalise a SQL timestamp string to an ISO 8601 instant.
 *
 * Postgres's text output for `timestamptz` is **not ISO 8601**:
 *
 *     2026-08-03 11:37:27.525285+00
 *
 * A space instead of `T`, microsecond precision, and a two-digit offset with no
 * minutes. `Date` rejects it in V8 — `+00` is not a valid ISO offset — so
 * {@link parseInstant} correctly returns `null` for it, which is how this
 * function came to exist rather than the driver quietly handing back a
 * non-conforming string.
 *
 * It matters because timestamps are compared as strings in several places, and
 * `'2026-08-03T08:00:00.000Z'` sorts *after* `'2026-08-03 08:00:00+00'` for the
 * same instant — `'T'` (0x54) is greater than `' '` (0x20). A freshly constructed
 * timestamp and a read-back one would therefore order inconsistently.
 *
 * @returns an ISO instant, or `null` if the input cannot be understood.
 */
export function parseSqlTimestamp(value: string): string | null {
  if (value === '') return null;

  /*
   * Normalised unconditionally, with **no fast path for a value that already
   * parses.** That shortcut was the first version of this function and it was
   * wrong: `new Date('2026-08-03 08:00:00')` succeeds in V8 and interprets the
   * string in the *runtime's* zone, so a zoneless Postgres timestamp came back
   * shifted by the machine's offset — five and a half hours, on the developer's
   * laptop. It parsed, so the fast path returned it, so the UTC branch below never
   * ran. Silent, and only visible on a machine that is not on UTC.
   */

  // `2026-08-03 11:37:27.525285+00` → `2026-08-03T11:37:27.525285+00`
  let candidate = value.includes('T') ? value : value.replace(' ', 'T');

  // `+00` → `+00:00`, `-0530` → `-05:30`. A bare two-digit offset is what Postgres
  // emits and what `Date` refuses.
  candidate = candidate
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  // No zone at all means `timestamp without time zone`. Treating it as UTC is the
  // only defensible reading: §5.3 keeps the capture zone in its own column, so a
  // naive timestamp in this schema is always already UTC.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(candidate)) candidate = `${candidate}Z`;

  return parseInstant(candidate)?.toISOString() ?? null;
}

/**
 * Midday UTC on a `YYYY-MM-DD` day key.
 *
 * Noon rather than midnight, and the reason is a bug rather than a preference:
 * calendar arithmetic starting from `T00:00:00Z` lands on the previous day the
 * moment anything shifts it by a few hours, which is exactly what a DST
 * transition or an offset conversion does. Noon leaves twelve hours of slack in
 * both directions, so day arithmetic cannot slip a date.
 *
 * @returns `null` if `dayKey` is not a valid date.
 */
export function utcNoonOn(dayKey: string): Date | null {
  // Rejected here rather than by `Date`, which accepts a surprising range of
  // near-misses (`2026-8-3`, `2026-02-31`) and normalises them silently.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

  const parsed = parseInstant(`${dayKey}T12:00:00Z`);
  if (parsed === null) return null;

  // `2026-02-31T12:00:00Z` parses in some engines and rolls into March. Comparing
  // the round-trip catches that.
  return parsed.toISOString().slice(0, 10) === dayKey ? parsed : null;
}

/** A UTC instant at midday on the given calendar date. Months are 1-based. */
export function utcNoonAt(year: number, month: number, day: number): Date {
  // As above. `Date.UTC` takes explicit parts, so there is no ambient zone to discard.
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/** A new instant `days` later. Does not mutate its argument. */
export function addUtcDays(instant: Date, days: number): Date {
  // As above. Derived from an instant that is already in hand.
  const next = new Date(instant.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** The `YYYY-MM-DD` of an instant in UTC. */
export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * An ISO instant from epoch milliseconds.
 *
 * The other half of the clock: `Clock.nowMillis()` returns a number, and turning
 * it back into a timestamp is otherwise a `new Date(ms)` at every call site — which
 * is exactly the pattern §11.3 bans, spread across the codebase rather than
 * concentrated here.
 */
export function isoFromMillis(millis: number): string {
  // The sanctioned construction from explicit epoch millis; see the file header. No ambient zone is involved.
  return new Date(millis).toISOString();
}

/** An ISO instant `seconds` after the given epoch millis. For expiry stamps. */
export function isoAfterSeconds(fromMillis: number, seconds: number): string {
  return isoFromMillis(fromMillis + seconds * 1000);
}

/** Whole days between two instants, rounded. */
export function utcDaysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * A day key's position on a fixed integer timeline.
 *
 * Days since 1970-01-01, so two calendar labels can be compared, subtracted and
 * windowed with integer arithmetic instead of a `Date` per comparison. The
 * moving average and the adherence grid both sweep thousands of these; parsing
 * inside the loop is what makes a ninety-day chart feel slow on a phone.
 *
 * @returns `null` if `dayKey` is not a real date. Callers must not coerce that
 *   to 0 — a malformed key is 1970 under any arithmetic that does.
 */
export function dayKeyIndex(dayKey: string): number | null {
  const anchor = utcNoonOn(dayKey);
  return anchor === null ? null : utcDaysBetween(DAY_INDEX_EPOCH, anchor);
}

/** The origin for {@link dayKeyIndex}. Noon, for the reason `utcNoonOn` gives. */
const DAY_INDEX_EPOCH = utcNoonAt(1970, 1, 1);

/**
 * A day key shifted by whole days.
 *
 * `shiftDayKey('2026-03-29', 1)` is `'2026-03-30'` in every zone, including the
 * ones where that day is 23 hours long — calendar labels have no duration, and
 * that is precisely why the window arithmetic works on them rather than on
 * instants.
 *
 * @returns `null` if `dayKey` is not a real date.
 */
export function shiftDayKey(dayKey: string, days: number): string | null {
  const anchor = utcNoonOn(dayKey);
  return anchor === null ? null : utcDayKey(addUtcDays(anchor, days));
}

/**
 * ISO-8601 day of week, Monday = 1 … Sunday = 7.
 *
 * `getUTCDay()` returns 0 for Sunday, which is wrong for every ISO week
 * calculation and is the single most common source of off-by-one week numbers.
 */
export function isoWeekday(instant: Date): number {
  const day = instant.getUTCDay();
  return day === 0 ? 7 : day;
}

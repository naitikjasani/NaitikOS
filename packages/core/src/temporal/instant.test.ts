/**
 * Instant parsing and calendar arithmetic.
 *
 * These functions are the sanctioned `Date` parse point (§11.3), which makes them
 * the place where every timezone bug in the system either gets caught or gets in.
 * The two properties worth defending:
 *
 *  - **Totality.** Malformed input returns `null`, never an `Invalid Date`. An
 *    `Invalid Date` propagates silently: `getTime()` is `NaN`, every comparison
 *    is false, and `toISOString()` throws several frames from the cause.
 *  - **Strictness.** `new Date('2026-02-31')` and `new Date('2026-8-3')` both
 *    succeed and normalise silently. A day key that rolls into the next month is
 *    how one entry gets filed under the wrong date with nothing logged.
 */

import { describe, expect, it } from 'vitest';

import {
  addUtcDays,
  isoWeekday,
  parseInstant,
  parseSqlTimestamp,
  utcDayKey,
  utcDaysBetween,
  utcNoonAt,
  utcNoonOn,
} from './instant';

describe('parseInstant', () => {
  it('parses an ISO instant', () => {
    const parsed = parseInstant('2026-08-03T18:30:00Z');
    expect(parsed?.toISOString()).toBe('2026-08-03T18:30:00.000Z');
  });

  it('parses an offset instant to the same moment', () => {
    // Asia/Kolkata's +05:30. Same instant, different spelling — the offset is
    // consumed, which is exactly why the zone must be stored separately (§5.3).
    expect(parseInstant('2026-08-04T00:00:00+05:30')?.toISOString()).toBe('2026-08-03T18:30:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    for (const input of ['', 'not-a-date', 'tomorrow', '2026-13-45T00:00:00Z']) {
      expect(parseInstant(input), `${input} should not parse`).toBeNull();
    }
  });

  it('does not return a Date whose time is NaN', () => {
    // The specific failure this guards: `new Date('nope')` is an object, is
    // truthy, and passes every null check in the codebase.
    const parsed = parseInstant('nope');
    expect(parsed).toBeNull();
  });
});

describe('parseSqlTimestamp', () => {
  it('normalises what Postgres actually returns', () => {
    // The format that motivated this function. `Date` refuses it in V8 because
    // `+00` is not a valid ISO offset, so `parseInstant` alone returns null and the
    // value would have flowed through unnormalised.
    expect(parseSqlTimestamp('2026-08-03 11:37:27.525285+00')).toBe('2026-08-03T11:37:27.525Z');
    expect(parseSqlTimestamp('2026-08-03 08:00:00+00')).toBe('2026-08-03T08:00:00.000Z');
  });

  it('passes an already-ISO value through', () => {
    expect(parseSqlTimestamp('2026-08-03T08:00:00.000Z')).toBe('2026-08-03T08:00:00.000Z');
    expect(parseSqlTimestamp('2026-08-03T08:00:00Z')).toBe('2026-08-03T08:00:00.000Z');
  });

  it('handles a non-UTC offset', () => {
    expect(parseSqlTimestamp('2026-08-03 13:30:00+05:30')).toBe('2026-08-03T08:00:00.000Z');
    expect(parseSqlTimestamp('2026-08-03 13:30:00+0530')).toBe('2026-08-03T08:00:00.000Z');
    expect(parseSqlTimestamp('2026-08-03 04:00:00-04')).toBe('2026-08-03T08:00:00.000Z');
  });

  it('reads a zoneless timestamp as UTC', () => {
    // `timestamp without time zone`. §5.3 keeps the capture zone in its own column,
    // so a naive timestamp in this schema is always already UTC — reading it as
    // local would shift every such value by the runtime's offset.
    expect(parseSqlTimestamp('2026-08-03 08:00:00')).toBe('2026-08-03T08:00:00.000Z');
  });

  it('produces values that sort correctly against application-built ones', () => {
    // The actual bug. Before normalisation `'2026-08-03T08:00:00.000Z'` sorted
    // *after* `'2026-08-03 09:00:00+00'` — an hour later — because `'T'` (0x54) is
    // greater than `' '` (0x20).
    const readBack = parseSqlTimestamp('2026-08-03 09:00:00+00') as string;
    const constructed = '2026-08-03T08:00:00.000Z';

    expect(constructed < readBack).toBe(true);
    expect('2026-08-03 09:00:00+00' < constructed).toBe(true);
  });

  it('returns null for something it cannot understand', () => {
    expect(parseSqlTimestamp('')).toBeNull();
    expect(parseSqlTimestamp('not a timestamp')).toBeNull();
    expect(parseSqlTimestamp('infinity')).toBeNull();
  });
});

describe('utcNoonOn', () => {
  it('anchors a day key at midday UTC', () => {
    expect(utcNoonOn('2026-08-03')?.toISOString()).toBe('2026-08-03T12:00:00.000Z');
  });

  it('uses noon so day arithmetic cannot slip a date', () => {
    const anchored = utcNoonOn('2026-08-03');
    if (anchored === null) throw new Error('expected a date');

    // Twelve hours of slack in both directions. From midnight, any shift backwards
    // lands on the previous day.
    expect(anchored.getUTCHours()).toBe(12);
    expect(utcDayKey(addUtcDays(anchored, -1))).toBe('2026-08-02');
    expect(utcDayKey(addUtcDays(anchored, 1))).toBe('2026-08-04');
  });

  it('rejects a loose date format rather than normalising it', () => {
    // `new Date('2026-8-3')` succeeds in V8. Accepting it here would mean two
    // spellings of the same day producing two different group keys.
    for (const input of ['2026-8-3', '3/8/2026', '2026-08-03T00:00:00Z', 'not-a-date', '']) {
      expect(utcNoonOn(input), `${input} should be rejected`).toBeNull();
    }
  });

  it('rejects a date that does not exist', () => {
    // The important one. 31 February parses in some engines and rolls into March —
    // a day key that silently becomes a different day key.
    expect(utcNoonOn('2026-02-31')).toBeNull();
    expect(utcNoonOn('2026-13-01')).toBeNull();
    expect(utcNoonOn('2026-04-31')).toBeNull();
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(utcNoonOn('2028-02-29')).not.toBeNull();
    expect(utcNoonOn('2026-02-29')).toBeNull();
  });
});

describe('utcNoonAt', () => {
  it('takes a one-based month', () => {
    // `Date.UTC` is zero-based, which is the other classic off-by-one. Taking a
    // one-based month here means call sites read like the dates they mean.
    expect(utcNoonAt(2026, 1, 4).toISOString()).toBe('2026-01-04T12:00:00.000Z');
    expect(utcNoonAt(2026, 12, 31).toISOString()).toBe('2026-12-31T12:00:00.000Z');
  });
});

describe('addUtcDays', () => {
  it('does not mutate its argument', () => {
    const original = utcNoonAt(2026, 8, 3);
    const before = original.toISOString();

    addUtcDays(original, 10);

    // The bug this prevents: `setUTCDate` mutates in place, so a loop cursor
    // shared with a caller silently advances their date too.
    expect(original.toISOString()).toBe(before);
  });

  it('crosses a month boundary', () => {
    expect(utcDayKey(addUtcDays(utcNoonAt(2026, 8, 31), 1))).toBe('2026-09-01');
  });

  it('crosses a year boundary in both directions', () => {
    expect(utcDayKey(addUtcDays(utcNoonAt(2026, 12, 31), 1))).toBe('2027-01-01');
    expect(utcDayKey(addUtcDays(utcNoonAt(2026, 1, 1), -1))).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(utcDayKey(addUtcDays(utcNoonAt(2028, 2, 28), 1))).toBe('2028-02-29');
    expect(utcDayKey(addUtcDays(utcNoonAt(2026, 2, 28), 1))).toBe('2026-03-01');
  });

  it('accepts zero', () => {
    expect(utcDayKey(addUtcDays(utcNoonAt(2026, 8, 3), 0))).toBe('2026-08-03');
  });
});

describe('utcDaysBetween', () => {
  it('counts whole days', () => {
    expect(utcDaysBetween(utcNoonAt(2026, 8, 1), utcNoonAt(2026, 8, 8))).toBe(7);
  });

  it('is negative backwards', () => {
    expect(utcDaysBetween(utcNoonAt(2026, 8, 8), utcNoonAt(2026, 8, 1))).toBe(-7);
  });

  it('is zero for the same instant', () => {
    expect(utcDaysBetween(utcNoonAt(2026, 8, 3), utcNoonAt(2026, 8, 3))).toBe(0);
  });

  it('rounds, so a DST-shifted pair still counts as whole days', () => {
    // Both anchors are UTC noon, so this is exact today — but the rounding is what
    // keeps it correct if a caller ever passes local-midnight anchors across a
    // spring-forward, where the true difference is 6.958 days.
    const from = utcNoonAt(2026, 3, 25);
    const to = new Date(utcNoonAt(2026, 4, 1).getTime() - 3_600_000);
    expect(utcDaysBetween(from, to)).toBe(7);
  });
});

describe('isoWeekday', () => {
  it('numbers Monday as 1 and Sunday as 7', () => {
    // `getUTCDay()` returns 0 for Sunday, which is wrong for every ISO week
    // calculation and is the single most common source of off-by-one week numbers.
    expect(isoWeekday(utcNoonAt(2026, 8, 3))).toBe(1); // Monday
    expect(isoWeekday(utcNoonAt(2026, 8, 6))).toBe(4); // Thursday
    expect(isoWeekday(utcNoonAt(2026, 8, 9))).toBe(7); // Sunday
  });

  it('never returns 0', () => {
    for (let day = 0; day < 14; day += 1) {
      const weekday = isoWeekday(addUtcDays(utcNoonAt(2026, 8, 1), day));
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(7);
    }
  });
});

describe('utcDayKey', () => {
  it('returns the UTC date, ignoring the local zone of the runtime', () => {
    // A test suite running in Asia/Kolkata must not produce different keys from one
    // running in CI on UTC.
    expect(utcDayKey(parseInstant('2026-08-03T23:59:59Z') as Date)).toBe('2026-08-03');
    expect(utcDayKey(parseInstant('2026-08-04T00:00:01Z') as Date)).toBe('2026-08-04');
  });
});

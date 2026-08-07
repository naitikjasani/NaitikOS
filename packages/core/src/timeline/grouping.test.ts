/**
 * Zone-aware day bucketing, grouping, and gap detection.
 *
 * The whole module exists for one sentence in §5.3 — "A workout at '7am' during
 * travel is a materially different fact from one at 7am at home" — so the tests
 * are mostly about zones, and specifically about the two things that are wrong in
 * every hand-rolled implementation: DST, and the ISO week at a year boundary.
 *
 * `emptyDaysInRange` gets its own section because it defends a stated principle
 * rather than a mechanism. §8.9(3): "Gaps are gaps… Interpolation across a week of
 * no data is fabrication."
 */

import { describe, expect, it } from 'vitest';

import type { TimelineEntry } from './types';
import { dayKeyInZone, emptyDaysInRange, groupEntries, monthKeyInZone, weekKeyInZone } from './grouping';

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    eventId: 'evt-1',
    sequence: 1,
    eventType: 'Weight.Logged',
    category: 'body',
    occurredAt: '2026-08-03T07:00:00Z',
    zone: 'Asia/Kolkata',
    occurredOn: '2026-08-03',
    title: 'Bodyweight recorded',
    detail: null,
    significance: 'primary',
    clinical: false,
    correlationId: 'corr-1',
    links: [],
    media: [],
    searchText: 'Bodyweight recorded',
    ...overrides,
  };
}

/* =========================================================================
 * Day keys
 * ====================================================================== */

describe('dayKeyInZone', () => {
  it('returns the local date, not the UTC one', () => {
    // 19:00 UTC is 00:30 the next day in Asia/Kolkata.
    expect(dayKeyInZone('2026-08-03T19:00:00Z', 'Asia/Kolkata')).toBe('2026-08-04');
    expect(dayKeyInZone('2026-08-03T19:00:00Z', 'UTC')).toBe('2026-08-03');
  });

  it('handles a half-hour offset', () => {
    // +05:30. Offset arithmetic on whole hours — a common shortcut — is wrong here
    // and in Kathmandu (+05:45), which is the zone the user actually lives near.
    expect(dayKeyInZone('2026-08-03T18:31:00Z', 'Asia/Kolkata')).toBe('2026-08-04');
    expect(dayKeyInZone('2026-08-03T18:29:00Z', 'Asia/Kolkata')).toBe('2026-08-03');
  });

  it('respects a DST transition', () => {
    // 2026-03-29 01:00 UTC: London has just moved to BST (+01:00), so 23:30 UTC on
    // the 28th is already the 29th locally. A fixed offset cannot express this,
    // which is why the implementation uses Intl rather than arithmetic.
    expect(dayKeyInZone('2026-03-29T23:30:00Z', 'Europe/London')).toBe('2026-03-30');
    expect(dayKeyInZone('2026-01-15T23:30:00Z', 'Europe/London')).toBe('2026-01-15');
  });

  it('handles a negative offset crossing backwards', () => {
    expect(dayKeyInZone('2026-08-03T02:00:00Z', 'America/New_York')).toBe('2026-08-02');
  });

  it('falls back to the UTC date for an unrecognised zone', () => {
    // A malformed zone should mis-file one entry, not make the timeline
    // unrenderable. §5.3's information loss is the smaller harm.
    expect(dayKeyInZone('2026-08-03T19:00:00Z', 'Mars/Olympus_Mons')).toBe('2026-08-03');
    expect(dayKeyInZone('2026-08-03T19:00:00Z', '')).toBe('2026-08-03');
  });

  it('does not throw on an unparseable instant', () => {
    // The fallback slices the first ten characters, so garbage in produces a
    // garbage key rather than an exception. That is the intended trade: one entry
    // groups under a nonsense heading instead of the whole timeline failing to
    // render. Worth knowing the key is not guaranteed to be a date.
    expect(() => dayKeyInZone('not-a-date', 'Asia/Kolkata')).not.toThrow();
    expect(dayKeyInZone('not-a-date', 'Asia/Kolkata')).toBe('not-a-date');
    expect(dayKeyInZone('', 'Asia/Kolkata')).toBe('');
  });
});

describe('monthKeyInZone', () => {
  it('uses the local month at a month boundary', () => {
    // 31 July 19:00 UTC is 1 August in Kolkata.
    expect(monthKeyInZone('2026-07-31T19:00:00Z', 'Asia/Kolkata')).toBe('2026-08');
    expect(monthKeyInZone('2026-07-31T19:00:00Z', 'UTC')).toBe('2026-07');
  });
});

/* =========================================================================
 * ISO weeks
 * ====================================================================== */

describe('weekKeyInZone', () => {
  it('numbers an ordinary week', () => {
    expect(weekKeyInZone('2026-08-03T07:00:00Z', 'UTC')).toBe('2026-W32');
  });

  it('puts late December into the next ISO year when the week belongs there', () => {
    // The case every naive implementation gets wrong. 29 December 2025 is a Monday
    // and its week contains 1 January 2026, so ISO 8601 puts it in 2026-W01 — not
    // 2025-W53. A "week 53 of 2025" label would split one week across two years in
    // every weekly rollup.
    expect(weekKeyInZone('2025-12-29T12:00:00Z', 'UTC')).toBe('2026-W01');
    expect(weekKeyInZone('2026-01-01T12:00:00Z', 'UTC')).toBe('2026-W01');
  });

  it('keeps early January in the previous ISO year when the week belongs there', () => {
    // 1 January 2027 is a Friday, so that week began on Monday 28 December 2026
    // and is 2026-W53.
    expect(weekKeyInZone('2027-01-01T12:00:00Z', 'UTC')).toBe('2026-W53');
  });

  it('pads the week number to two digits, so keys sort lexically', () => {
    // `2026-W9` would sort after `2026-W10` as a string, which is how a chart
    // renders its x-axis out of order.
    expect(weekKeyInZone('2026-03-02T12:00:00Z', 'UTC')).toBe('2026-W10');
    expect(weekKeyInZone('2026-01-05T12:00:00Z', 'UTC')).toBe('2026-W02');
  });

  it('crosses a week boundary in the local zone', () => {
    // Sunday 19:00 UTC is Monday in Kolkata — a different ISO week.
    expect(weekKeyInZone('2026-08-02T19:00:00Z', 'UTC')).toBe('2026-W31');
    expect(weekKeyInZone('2026-08-02T19:00:00Z', 'Asia/Kolkata')).toBe('2026-W32');
  });
});

/* =========================================================================
 * Grouping
 * ====================================================================== */

describe('groupEntries', () => {
  it('returns one pseudo-group when grouping is none', () => {
    const entries = [entry(), entry({ eventId: 'evt-2' })];
    const groups = groupEntries(entries, 'none', 'UTC');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('all');
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it('groups by the pre-computed day key', () => {
    const groups = groupEntries(
      [
        entry({ occurredOn: '2026-08-03' }),
        entry({ eventId: 'evt-2', occurredOn: '2026-08-03' }),
        entry({ eventId: 'evt-3', occurredOn: '2026-08-02' }),
      ],
      'day',
      'UTC',
    );

    expect(groups.map((group) => group.key)).toEqual(['2026-08-03', '2026-08-02']);
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it('preserves arrival order rather than re-sorting', () => {
    // The store has already sorted by sequence. Re-sorting here would silently
    // override a `direction=forward` query.
    const groups = groupEntries(
      [
        entry({ occurredOn: '2026-08-01' }),
        entry({ eventId: 'evt-2', occurredOn: '2026-08-03' }),
        entry({ eventId: 'evt-3', occurredOn: '2026-08-02' }),
      ],
      'day',
      'UTC',
    );

    expect(groups.map((group) => group.key)).toEqual(['2026-08-01', '2026-08-03', '2026-08-02']);
  });

  it('groups by week and month using each entry own zone', () => {
    const groups = groupEntries(
      [
        entry({ occurredAt: '2026-08-02T19:00:00Z', zone: 'Asia/Kolkata' }),
        entry({ eventId: 'evt-2', occurredAt: '2026-08-02T19:00:00Z', zone: 'UTC' }),
      ],
      'week',
      'UTC',
    );

    expect(groups.map((group) => group.key)).toEqual(['2026-W32', '2026-W31']);

    const months = groupEntries(
      [entry({ occurredAt: '2026-07-31T19:00:00Z', zone: 'Asia/Kolkata' })],
      'month',
      'UTC',
    );
    expect(months[0]?.key).toBe('2026-08');
  });

  it('falls back to the profile zone for an entry with none', () => {
    const groups = groupEntries(
      [entry({ occurredAt: '2026-08-02T19:00:00Z', zone: null })],
      'week',
      'Asia/Kolkata',
    );
    expect(groups[0]?.key).toBe('2026-W32');
  });

  it('groups a Daily Close into one correlation group', () => {
    const groups = groupEntries(
      [
        entry({ eventId: 'evt-1', correlationId: 'close-1', significance: 'detail', title: 'Bodyweight recorded' }),
        entry({ eventId: 'evt-2', correlationId: 'close-1', significance: 'primary', title: 'Daily Close' }),
        entry({ eventId: 'evt-3', correlationId: 'other', title: 'Training session completed' }),
      ],
      'correlation',
      'UTC',
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.entries).toHaveLength(2);
    // Labelled from the primary entry — a UUID is not a heading.
    expect(groups[0]?.label).toBe('Daily Close');
  });

  it('labels a correlation group with no primary entry from its first', () => {
    const groups = groupEntries(
      [entry({ significance: 'detail', title: 'Barbell squat', correlationId: 'sess-1' })],
      'correlation',
      'UTC',
    );
    expect(groups[0]?.label).toBe('Barbell squat');
  });

  it('labels date groups with their key', () => {
    const groups = groupEntries([entry({ occurredOn: '2026-08-03' })], 'day', 'UTC');
    expect(groups[0]?.label).toBe('2026-08-03');
  });

  it('returns nothing for no entries', () => {
    expect(groupEntries([], 'day', 'UTC')).toEqual([]);
  });
});

/* =========================================================================
 * Gaps
 * ====================================================================== */

describe('emptyDaysInRange', () => {
  it('reports the days with no entry', () => {
    const gaps = emptyDaysInRange(
      [entry({ occurredOn: '2026-08-01' }), entry({ eventId: 'evt-2', occurredOn: '2026-08-04' })],
      '2026-08-01T00:00:00Z',
      '2026-08-05T00:00:00Z',
      'UTC',
    );

    // §8.9(3): a timeline that silently skips empty days makes a three-week gap
    // look like three consecutive entries.
    expect(gaps).toEqual(['2026-08-02', '2026-08-03', '2026-08-05']);
  });

  it('reports every day when there are no entries at all', () => {
    expect(emptyDaysInRange([], '2026-08-01T00:00:00Z', '2026-08-03T00:00:00Z', 'UTC')).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('reports nothing for a fully covered range', () => {
    expect(
      emptyDaysInRange(
        [entry({ occurredOn: '2026-08-01' }), entry({ eventId: 'evt-2', occurredOn: '2026-08-02' })],
        '2026-08-01T00:00:00Z',
        '2026-08-02T00:00:00Z',
        'UTC',
      ),
    ).toEqual([]);
  });

  it('is inclusive of both ends', () => {
    expect(emptyDaysInRange([], '2026-08-03T00:00:00Z', '2026-08-03T23:00:00Z', 'UTC')).toEqual([
      '2026-08-03',
    ]);
  });

  it('returns nothing for an inverted range rather than spinning', () => {
    expect(emptyDaysInRange([], '2026-08-10T00:00:00Z', '2026-08-01T00:00:00Z', 'UTC')).toEqual([]);
  });

  it('bounds the walk so a malformed range cannot hang the request', () => {
    const gaps = emptyDaysInRange([], '2000-01-01T00:00:00Z', '2050-01-01T00:00:00Z', 'UTC');
    expect(gaps).toHaveLength(2000);
  });

  it('bucketises the range bounds in the given zone', () => {
    // The range end is 19:00 UTC = 4 August in Kolkata, so the 4th is in range.
    const gaps = emptyDaysInRange([], '2026-08-03T19:00:00Z', '2026-08-03T19:00:00Z', 'Asia/Kolkata');
    expect(gaps).toEqual(['2026-08-04']);
  });
});

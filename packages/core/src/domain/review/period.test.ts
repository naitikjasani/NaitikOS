import { describe, expect, it } from 'vitest';

import {
  REVIEW_KINDS,
  REVIEW_KIND_LABELS,
  REVIEW_STATES,
  isPeriodClosed,
  isReviewKind,
  isReviewState,
  periodContaining,
  previousPeriod,
  recentPeriods,
} from './period';
import type { ReviewPeriod } from './period';

function must(period: ReviewPeriod | null): ReviewPeriod {
  if (period === null) throw new Error('expected a period');
  return period;
}

describe('the vocabulary', () => {
  it('labels every kind and state it declares', () => {
    for (const kind of REVIEW_KINDS) expect(REVIEW_KIND_LABELS[kind]).not.toBe('');
    expect(REVIEW_STATES).toEqual(['drafted', 'editing', 'complete']);
  });

  it('guards against a string that is not in the enum', () => {
    expect(isReviewKind('weekly')).toBe(true);
    expect(isReviewKind('fortnightly')).toBe(false);
    expect(isReviewState('complete')).toBe(true);
    expect(isReviewState('done')).toBe(false);
  });
});

describe('periodContaining', () => {
  it('runs a week Monday to Sunday', () => {
    /* 2026-08-30 is a Sunday, so it is the *last* day of its week rather than
     * the first — the case a Sunday-first implementation gets wrong. */
    const week = must(periodContaining('weekly', '2026-08-30'));
    expect(week.fromDayKey).toBe('2026-08-24');
    expect(week.toDayKey).toBe('2026-08-30');
    expect(week.label).toBe('2026-W35');
  });

  it('gives every day of a week the same period', () => {
    const monday = must(periodContaining('weekly', '2026-08-24'));
    for (const day of ['2026-08-25', '2026-08-27', '2026-08-30']) {
      expect(must(periodContaining('weekly', day))).toEqual(monday);
    }
  });

  it('numbers the ISO week across a year edge', () => {
    /* 29 December 2025 is the Monday of the week containing 1 January 2026, a
     * Thursday — so ISO puts the whole week in 2026, and the last three days of
     * 2025 belong to a 2026 review. This is the case a naive `getFullYear()`
     * files under 2025 and nobody notices until the following December. */
    const early = must(periodContaining('weekly', '2025-12-31'));
    expect(early.label).toBe('2026-W01');
    expect(early.fromDayKey).toBe('2025-12-29');
    expect(early.toDayKey).toBe('2026-01-04');

    /* And the mirror: 31 December 2026 is a Thursday in a 53-week ISO year, so
     * its week runs into 2027 and is still labelled 2026. */
    const late = must(periodContaining('weekly', '2026-12-31'));
    expect(late.label).toBe('2026-W53');
    expect(late.fromDayKey).toBe('2026-12-28');
    expect(late.toDayKey).toBe('2027-01-03');

    /* A day that is calendar-2026 but ISO-2025. */
    expect(must(periodContaining('weekly', '2025-01-01')).label).toBe('2025-W01');
    expect(must(periodContaining('weekly', '2024-12-30')).label).toBe('2025-W01');
  });

  it('runs a month from the first to the last day, leap years included', () => {
    const august = must(periodContaining('monthly', '2026-08-30'));
    expect(august.fromDayKey).toBe('2026-08-01');
    expect(august.toDayKey).toBe('2026-08-31');
    expect(august.label).toBe('August 2026');

    expect(must(periodContaining('monthly', '2026-02-15')).toDayKey).toBe('2026-02-28');
    expect(must(periodContaining('monthly', '2024-02-15')).toDayKey).toBe('2024-02-29');
    expect(must(periodContaining('monthly', '2026-12-05')).toDayKey).toBe('2026-12-31');
  });

  it('runs a quarter over three whole months', () => {
    const q3 = must(periodContaining('quarterly', '2026-08-30'));
    expect(q3.fromDayKey).toBe('2026-07-01');
    expect(q3.toDayKey).toBe('2026-09-30');
    expect(q3.label).toBe('2026 Q3');

    expect(must(periodContaining('quarterly', '2026-01-01')).label).toBe('2026 Q1');
    expect(must(periodContaining('quarterly', '2026-12-31')).toDayKey).toBe('2026-12-31');
  });

  it('runs a year from January to December', () => {
    const year = must(periodContaining('annual', '2026-08-30'));
    expect(year.fromDayKey).toBe('2026-01-01');
    expect(year.toDayKey).toBe('2026-12-31');
    expect(year.label).toBe('2026');
  });

  it('refuses a day key that is not a real date, rather than picking a window', () => {
    for (const bad of ['', 'yesterday', '2026-8-3', '2026-02-31', '2026-13-01']) {
      expect(periodContaining('monthly', bad)).toBeNull();
    }
  });
});

describe('previousPeriod', () => {
  it('steps back a week across a year edge', () => {
    const first = must(periodContaining('weekly', '2025-12-31'));
    const before = must(previousPeriod(first));
    expect(before.label).toBe('2025-W52');
    expect(before.fromDayKey).toBe('2025-12-22');
    expect(before.toDayKey).toBe('2025-12-28');
  });

  it('steps back a month across a year edge', () => {
    const january = must(periodContaining('monthly', '2026-01-10'));
    expect(must(previousPeriod(january)).label).toBe('December 2025');
  });

  it('steps back a quarter and a year', () => {
    expect(must(previousPeriod(must(periodContaining('quarterly', '2026-02-02')))).label).toBe('2025 Q4');
    expect(must(previousPeriod(must(periodContaining('annual', '2026-02-02')))).label).toBe('2025');
  });
});

describe('isPeriodClosed', () => {
  const august = must(periodContaining('monthly', '2026-08-15'));

  it('is false for the period the operator is standing in', () => {
    /* The load-bearing case. A review of August drafted on 15 August would
     * describe half a month as a month, permanently. */
    expect(isPeriodClosed(august, '2026-08-15')).toBe(false);
  });

  it('is false on the last day, which is still being lived', () => {
    expect(isPeriodClosed(august, '2026-08-31')).toBe(false);
  });

  it('is true from the first day after the period', () => {
    expect(isPeriodClosed(august, '2026-09-01')).toBe(true);
    expect(isPeriodClosed(august, '2027-01-01')).toBe(true);
  });

  it('refuses to call a period closed on an unreadable day key', () => {
    expect(isPeriodClosed(august, 'tomorrow')).toBe(false);
  });
});

describe('recentPeriods', () => {
  it('returns the current period first and walks backwards', () => {
    const weeks = recentPeriods('weekly', '2026-01-05', 3);
    expect(weeks.map((week) => week.label)).toEqual(['2026-W02', '2026-W01', '2025-W52']);
  });

  it('includes the unfinished current period, leaving draftability to isPeriodClosed', () => {
    const months = recentPeriods('monthly', '2026-08-15', 2);
    expect(months.map((month) => month.label)).toEqual(['August 2026', 'July 2026']);
    expect(isPeriodClosed(must(months[0] ?? null), '2026-08-15')).toBe(false);
  });

  it('returns nothing for a non-positive count or an unreadable day', () => {
    expect(recentPeriods('weekly', '2026-08-30', 0)).toEqual([]);
    expect(recentPeriods('weekly', '2026-08-30', -4)).toEqual([]);
    expect(recentPeriods('weekly', 'not a day', 5)).toEqual([]);
  });

  it('caps a runaway request rather than walking to the epoch', () => {
    expect(recentPeriods('weekly', '2026-08-30', 100_000)).toHaveLength(200);
  });
});

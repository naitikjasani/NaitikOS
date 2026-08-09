import { describe, expect, it } from 'vitest';

import { axisLabel, dayIndex, dayKeyOf, monthLabel, weekStartIndex, weekdayOf } from './calendar';

describe('dayIndex / dayKeyOf', () => {
  it('round-trips the epoch and the dates around it', () => {
    expect(dayIndex('1970-01-01')).toBe(0);
    expect(dayKeyOf(0)).toBe('1970-01-01');
    expect(dayIndex('1969-12-31')).toBe(-1);
    expect(dayKeyOf(-1)).toBe('1969-12-31');
  });

  it('round-trips every day across two leap years and a century non-leap', () => {
    // 2024 is a leap year, 2100 is not, and 2000 was. All three break naive
    // implementations, and the record has to outlive the first two.
    for (const start of ['2024-02-26', '2100-02-26', '2000-02-26']) {
      const index = dayIndex(start);
      expect(index).not.toBeNull();
      if (index === null) continue;
      for (let offset = 0; offset < 8; offset += 1) {
        const key = dayKeyOf(index + offset);
        expect(dayIndex(key)).toBe(index + offset);
      }
    }
  });

  it('knows 2024 has a 29 February and 2100 does not', () => {
    expect(dayIndex('2024-02-29')).not.toBeNull();
    expect(dayIndex('2100-02-29')).toBeNull();
    expect(dayIndex('2000-02-29')).not.toBeNull();
  });

  /**
   * The check that `Date` does not do: `new Date('2026-02-31')` rolls into
   * March and reports success. A silently shifted day is a silently shifted
   * chart.
   */
  it('rejects a date that does not exist rather than rolling it forward', () => {
    expect(dayIndex('2026-02-31')).toBeNull();
    expect(dayIndex('2026-13-01')).toBeNull();
    expect(dayIndex('2026-00-10')).toBeNull();
    expect(dayIndex('2026-08-32')).toBeNull();
  });

  it('rejects anything that is not a day key', () => {
    expect(dayIndex('2026-8-3')).toBeNull();
    expect(dayIndex('2026-08-03T12:00:00Z')).toBeNull();
    expect(dayIndex('total')).toBeNull();
    expect(dayIndex('')).toBeNull();
  });

  it('spans decades without drift', () => {
    const from = dayIndex('2026-08-17');
    const to = dayIndex('2046-08-17');
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    // Twenty years including five leap days.
    expect((to ?? 0) - (from ?? 0)) .toBe(7305);
  });
});

describe('weekdayOf', () => {
  it('agrees with the calendar', () => {
    // 1970-01-01 was a Thursday.
    expect(weekdayOf(0)).toBe(4);
    // 2026-08-17 is a Monday.
    expect(weekdayOf(dayIndex('2026-08-17') ?? 0)).toBe(1);
    expect(weekdayOf(dayIndex('2026-08-23') ?? 0)).toBe(7);
  });

  it('is correct before the epoch, where a naive modulo goes negative', () => {
    expect(weekdayOf(-1)).toBe(3);
    expect(weekdayOf(-7)).toBe(4);
  });
});

describe('weekStartIndex', () => {
  it('finds the Monday of the week', () => {
    const monday = dayIndex('2026-08-17') ?? 0;
    for (let offset = 0; offset < 7; offset += 1) {
      expect(weekStartIndex(monday + offset)).toBe(monday);
    }
    expect(dayKeyOf(weekStartIndex(dayIndex('2026-08-23') ?? 0))).toBe('2026-08-17');
  });
});

describe('labels', () => {
  it('is compact, and adds a year only when the range needs it', () => {
    const day = dayIndex('2026-08-17') ?? 0;
    expect(axisLabel(day)).toBe('17 Aug');
    expect(axisLabel(day, true)).toBe('17 Aug 26');
    expect(monthLabel(day)).toBe('Aug 2026');
  });
});

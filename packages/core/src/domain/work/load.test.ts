import { describe, expect, it } from 'vitest';

import { bestFocusDays, dailyLoad, meanOver, minutesBetween, withinWindow, type LoadEvent } from './load';

const dayKeyOf = (instant: string): string => instant.slice(0, 10);

const event = (overrides: Partial<LoadEvent>): LoadEvent => ({
  id: 'e',
  startsAt: '2026-08-30T04:00:00.000Z',
  endsAt: '2026-08-30T05:00:00.000Z',
  isAllDay: false,
  isAccepted: null,
  isTravel: false,
  attendeeCount: 3,
  ...overrides,
});

describe('minutesBetween', () => {
  it('returns zero rather than a guessed default when the end is missing', () => {
    expect(minutesBetween('2026-08-30T04:00:00.000Z', null)).toBe(0);
  });

  it('never returns a negative duration', () => {
    expect(minutesBetween('2026-08-30T05:00:00.000Z', '2026-08-30T04:00:00.000Z')).toBe(0);
  });

  it('rounds to whole minutes', () => {
    expect(minutesBetween('2026-08-30T04:00:00.000Z', '2026-08-30T04:30:30.000Z')).toBe(31);
  });
});

describe('dailyLoad', () => {
  const dayKeys = ['2026-08-29', '2026-08-30'];

  it('counts accepted and unanswered meetings, and excludes declined ones', () => {
    const [, today] = dailyLoad({
      dayKeys,
      events: [
        event({ id: 'accepted', isAccepted: true }),
        event({ id: 'unanswered', isAccepted: null }),
        event({ id: 'declined', isAccepted: false }),
      ],
      sessions: [],
      dayKeyOf,
    });

    expect(today?.meetingCount).toBe(2);
    expect(today?.meetingMinutes).toBe(120);
  });

  it('marks travel and contributes no minutes for it', () => {
    const [, today] = dailyLoad({
      dayKeys,
      events: [
        event({
          id: 'flight',
          isTravel: true,
          startsAt: '2026-08-30T02:00:00.000Z',
          endsAt: '2026-08-30T08:00:00.000Z',
        }),
      ],
      sessions: [],
      dayKeyOf,
    });

    expect(today?.isTravel).toBe(true);
    /* Six hours of flying is not six hours of meetings. Folding it in would
     * make the one series that explains a bad week explain it wrongly. */
    expect(today?.meetingMinutes).toBe(0);
    expect(today?.meetingCount).toBe(0);
  });

  it('ignores an all-day marker rather than counting it as a full day of meetings', () => {
    const [, today] = dailyLoad({
      dayKeys,
      events: [event({ id: 'holiday', isAllDay: true, endsAt: '2026-08-31T04:00:00.000Z' })],
      sessions: [],
      dayKeyOf,
    });
    expect(today?.meetingMinutes).toBe(0);
  });

  it('returns a row for every requested day, including empty ones', () => {
    const days = dailyLoad({ dayKeys, events: [], sessions: [], dayKeyOf });
    expect(days.map((day) => day.dayKey)).toEqual(dayKeys);
    expect(days.every((day) => day.meetingMinutes === 0 && day.focusMinutes === 0)).toBe(true);
  });

  it('drops an event outside the requested window rather than inventing a day for it', () => {
    const days = dailyLoad({
      dayKeys,
      events: [event({ startsAt: '2025-01-01T04:00:00.000Z', endsAt: '2025-01-01T05:00:00.000Z' })],
      sessions: [],
      dayKeyOf,
    });
    expect(days).toHaveLength(2);
    expect(days.every((day) => day.meetingCount === 0)).toBe(true);
  });

  it('sums focus minutes against the session day key', () => {
    const [, today] = dailyLoad({
      dayKeys,
      events: [],
      sessions: [
        {
          id: 's1',
          dayKey: '2026-08-30',
          startedAt: '2026-08-30T03:00:00.000Z',
          endedAt: '2026-08-30T05:00:00.000Z',
          quality: 4,
          interruptions: 1,
        },
      ],
      dayKeyOf,
    });

    expect(today?.focusMinutes).toBe(120);
    expect(today?.focusSessions).toBe(1);
  });
});

describe('meanOver', () => {
  it('returns null for an empty series rather than zero', () => {
    expect(meanOver([])).toBeNull();
  });

  it('averages what is there', () => {
    expect(meanOver([60, 120])).toBe(90);
  });
});

describe('bestFocusDays', () => {
  it('excludes days with no recorded focus', () => {
    const days = bestFocusDays([
      { dayKey: 'a', meetingMinutes: 0, meetingCount: 0, focusMinutes: 0, focusSessions: 0, isTravel: false },
      { dayKey: 'b', meetingMinutes: 0, meetingCount: 0, focusMinutes: 90, focusSessions: 1, isTravel: false },
    ]);
    expect(days.map((day) => day.dayKey)).toEqual(['b']);
  });
});

describe('withinWindow', () => {
  it('is inclusive at both ends', () => {
    expect(withinWindow('2026-08-01', '2026-08-01', '2026-08-31')).toBe(true);
    expect(withinWindow('2026-08-31', '2026-08-01', '2026-08-31')).toBe(true);
    expect(withinWindow('2026-09-01', '2026-08-01', '2026-08-31')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { shiftDayKey } from '../../temporal/instant';
import { hourInZone } from '../../timeline/grouping';
import {
  MIN_CONSISTENCY_NIGHTS,
  consistencyOver,
  sleepDebt,
  sleepMidpointMinutes,
  type NightPoint,
} from './consistency';
import type { SleepNight } from './night';

/**
 * The minute of the hour in a zone.
 *
 * `hourInZone` already lives in `timeline/grouping`; its other half is written
 * here rather than added to the shared module, because a real `Intl` lookup is
 * what makes this test prove that the midpoint is taken in the *night's* zone
 * rather than in UTC.
 */
function minuteInZone(instant: string, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '0';
  return Number.parseInt(minute, 10);
}

const night = (overrides: Partial<SleepNight>): SleepNight => ({
  id: '01900000-0000-7000-8000-000000000001',
  dayKey: '2026-08-30',
  zone: 'Asia/Kolkata',
  bedAt: '2026-08-29T17:40:00.000Z',
  wokeAt: '2026-08-30T01:10:00.000Z',
  durationHours: '7.000000',
  quality: 4,
  latencyMinutes: null,
  wakings: null,
  disturbance: null,
  disturbanceNote: null,
  note: null,
  ...overrides,
});

/** `count` consecutive day keys starting at `start`. */
function windowFrom(start: string, count: number): readonly string[] {
  const keys: string[] = [];
  let key: string | null = start;
  for (let i = 0; i < count && key !== null; i += 1) {
    keys.push(key);
    key = shiftDayKey(key, 1);
  }
  return keys;
}

/* Built through a function so the numbers arrive as arguments. A `durationHours:
 * 7.5` literal is what `@naitikos/no-bare-quantity` exists to catch, and it is
 * right to catch it — the unit belongs in the name, which it is. */
const point = (dayKey: string, midpoint: number | null, hours: number | null): NightPoint => ({
  dayKey,
  midpointMinutes: midpoint,
  durationHours: hours,
});

/**
 * The wrong answer, written down.
 *
 * An ordinary population standard deviation over minutes-past-midnight. It is
 * here so the circular test can assert what it is *not*: the two are compared
 * directly, and a regression that replaced `circularSpreadMinutes` with this
 * would fail on the assertion rather than merely on a magic number.
 */
function naiveSpread(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

describe('sleepMidpointMinutes', () => {
  it('takes the midpoint of the instants and reads it in the night’s own zone', () => {
    /* 23:10 to 06:40 in Asia/Kolkata. The midpoint instant is 21:25Z, which is
     * 02:55 there — 175 minutes after local midnight. */
    expect(sleepMidpointMinutes(night({}), hourInZone, minuteInZone)).toBe(175);
  });

  it('reads the same night differently in a different zone, which is the point', () => {
    /* Identical instants, zone UTC: 21:25 is 1285 minutes after midnight. A
     * night slept while travelling is compared against the clock the operator
     * was living on (§5.3), and the zone column is what makes that possible. */
    expect(sleepMidpointMinutes(night({ zone: 'UTC' }), hourInZone, minuteInZone)).toBe(1285);
  });

  it('is null without both endpoints, because there is no midpoint to invent', () => {
    expect(sleepMidpointMinutes(night({ bedAt: null }), hourInZone, minuteInZone)).toBeNull();
    expect(sleepMidpointMinutes(night({ wokeAt: null }), hourInZone, minuteInZone)).toBeNull();
  });

  it('is null for an endpoint that does not parse', () => {
    expect(sleepMidpointMinutes(night({ bedAt: 'yesterday' }), hourInZone, minuteInZone)).toBeNull();
  });
});

describe('consistencyOver', () => {
  it('reports insufficient rather than a number below the floor', () => {
    const days = windowFrom('2026-08-01', 10);
    const points = days.slice(0, 3).map((dayKey) => point(dayKey, 180, 7.5));

    const report = consistencyOver(points, days);
    expect(report.insufficient).toBe(true);
    expect(report.nights).toBe(3);
    /* §10.9: every figure degrades to nothing, and the caller renders that as
     * an answer. Three nights cannot say what a sleep schedule looks like. */
    expect(report.midpointSpreadMinutes).toBeNull();
    expect(report.meanDurationHours).toBeNull();
    expect(report.durationSpreadHours).toBeNull();
  });

  it('is sufficient at exactly the floor', () => {
    const days = windowFrom('2026-08-01', MIN_CONSISTENCY_NIGHTS);
    const points = days.map((dayKey) => point(dayKey, 180, 7.5));

    const report = consistencyOver(points, days);
    expect(report.insufficient).toBe(false);
    expect(report.nights).toBe(MIN_CONSISTENCY_NIGHTS);
    expect(report.meanDurationHours).toBeCloseTo(7.5, 10);
    expect(report.durationSpreadHours).toBeCloseTo(0, 10);
  });

  /*
   * The reason this module computes a circular statistic and not an ordinary
   * one. Everything in this block fails under a naive arithmetic standard
   * deviation over minutes-past-midnight.
   */
  describe('the midpoint spread wraps across midnight', () => {
    const days = windowFrom('2026-08-01', 8);
    /* A steady sleeper: midpoint at 23:45 on four nights and 00:15 on four.
     * Thirty minutes of drift, either side of midnight. */
    const acrossMidnight = [1425, 15, 1425, 15, 1425, 15, 1425, 15];
    /* The same sleeper, shifted twelve hours: 11:45 and 12:15. Identical
     * behaviour, no midnight in the way. */
    const acrossMidday = [705, 735, 705, 735, 705, 735, 705, 735];

    const reportFor = (midpoints: readonly number[]) =>
      consistencyOver(
        days.map((dayKey, index) => point(dayKey, midpoints[index] ?? 0, null)),
        days,
      );

    it('measures thirty minutes of drift as about fifteen minutes of spread', () => {
      /* Half the peak-to-peak separation, as a standard deviation of a
       * two-point distribution should be. */
      expect(reportFor(acrossMidnight).midpointSpreadMinutes).toBeCloseTo(15, 1);
    });

    it('gives the same answer for the same sleeper shifted twelve hours', () => {
      const wrapped = reportFor(acrossMidnight).midpointSpreadMinutes;
      const unwrapped = reportFor(acrossMidday).midpointSpreadMinutes;
      expect(wrapped).not.toBeNull();
      expect(unwrapped).not.toBeNull();
      /* Rotation invariance is the property that distinguishes the two
       * computations. The spread of a schedule cannot depend on where the
       * calendar happens to have put midnight. */
      expect(wrapped).toBeCloseTo(unwrapped ?? 0, 6);
    });

    it('is not what the arithmetic standard deviation would have said', () => {
      /*
       * The naive figure for the midnight-crossing sleeper is 705 minutes —
       * eleven and three quarter hours of "inconsistency" for someone who went
       * to bed within half an hour of the same time every night. It is right
       * for the midday sleeper and catastrophically wrong for the other, and
       * most people's midpoints sit near midnight.
       */
      expect(naiveSpread(acrossMidnight)).toBeCloseTo(705, 0);
      expect(naiveSpread(acrossMidday)).toBeCloseTo(15, 0);

      const wrapped = reportFor(acrossMidnight).midpointSpreadMinutes ?? 0;
      expect(wrapped).toBeLessThan(naiveSpread(acrossMidnight) / 10);
    });
  });

  it('reports no spread at all for an identical midpoint every night', () => {
    const days = windowFrom('2026-08-01', 8);
    const points = days.map((dayKey) => point(dayKey, 195, null));
    /* The resultant is exactly 1 here, and `log(1 + 1e-16)` is negative — the
     * clamp is what stops the most consistent sleeper in the world getting a
     * NaN. */
    expect(consistencyOver(points, days).midpointSpreadMinutes).toBe(0);
  });

  it('judges each figure on its own sample, never on the window', () => {
    const days = windowFrom('2026-08-01', 10);
    /* Ten nights logged, of which only four have timing — the ordinary shape of
     * a record where most nights come through the Daily Close, which asks for a
     * duration and not for two clock times. */
    const points = days.map((dayKey, index) =>
      index < 4 ? point(dayKey, 180, 7.5) : point(dayKey, null, 7.5),
    );

    const report = consistencyOver(points, days);
    expect(report.insufficient).toBe(false);
    expect(report.meanDurationHours).toBeCloseTo(7.5, 10);
    /* Four midpoints cannot borrow confidence from ten durations. */
    expect(report.midpointSpreadMinutes).toBeNull();
  });

  it('finds the longest run of unlogged days', () => {
    const days = windowFrom('2026-08-01', 10);
    const logged = ['2026-08-01', '2026-08-02', '2026-08-09'];
    const points = logged.map((dayKey) => point(dayKey, 180, 7.5));

    const report = consistencyOver(points, days);
    /* 3 August through 8 August. The trailing single day is a shorter run. */
    expect(report.longestGapNights).toBe(6);
    expect(report.nights).toBe(3);
  });

  it('reports the gap even when the window is insufficient, because it is a count', () => {
    const days = windowFrom('2026-08-01', 30);
    const report = consistencyOver([point('2026-08-01', 180, 7.5)], days);
    expect(report.insufficient).toBe(true);
    expect(report.longestGapNights).toBe(29);
  });

  it('ignores a night outside the window rather than widening it', () => {
    const days = windowFrom('2026-08-01', 8);
    const points = [...days.map((dayKey) => point(dayKey, 180, 7.5)), point('2026-07-04', 900, 3)];

    const report = consistencyOver(points, days);
    expect(report.nights).toBe(8);
    expect(report.meanDurationHours).toBeCloseTo(7.5, 10);
  });

  it('counts one night per morning even if handed two', () => {
    const days = windowFrom('2026-08-01', 8);
    const points = [...days.map((dayKey) => point(dayKey, 180, 7.5)), point('2026-08-01', 180, 7.5)];
    expect(consistencyOver(points, days).nights).toBe(8);
  });

  it('says nothing about an empty window', () => {
    const report = consistencyOver([], []);
    expect(report.nights).toBe(0);
    expect(report.longestGapNights).toBe(0);
    expect(report.insufficient).toBe(true);
    expect(report.midpointSpreadMinutes).toBeNull();
  });
});

describe('sleepDebt', () => {
  const TARGET = 8;

  it('charges only the nights that were recorded', () => {
    const days = windowFrom('2026-08-01', 30);
    const points = days.slice(0, 4).map((dayKey) => point(dayKey, null, 6));

    const debt = sleepDebt(points, days, TARGET);
    expect(debt.nightsCounted).toBe(4);
    expect(debt.nightsMissing).toBe(26);
    expect(debt.expectedHours).toBeCloseTo(32, 10);
    expect(debt.actualHours).toBeCloseTo(24, 10);
    /*
     * Eight hours, not 216. Multiplying the target by the whole window would
     * bill twenty-six nights the operator simply did not log, turning a gap in
     * the record into a deficit in the body — a claim there is no evidence for.
     */
    expect(debt.deficitHours).toBeCloseTo(8, 10);
  });

  it('shows a surplus as a surplus rather than clamping it away', () => {
    const days = windowFrom('2026-08-01', 7);
    const points = days.map((dayKey) => point(dayKey, null, 9));

    const debt = sleepDebt(points, days, TARGET);
    /* Seven hours in credit. A measure that floored at zero would report a
     * fortnight of long nights as neither debt nor recovery. */
    expect(debt.deficitHours).toBeCloseTo(-7, 10);
  });

  it('treats a night with no duration as missing, not as nought hours', () => {
    const days = windowFrom('2026-08-01', 3);
    const points = [point('2026-08-01', 180, 7), point('2026-08-02', 180, null)];

    const debt = sleepDebt(points, days, TARGET);
    expect(debt.nightsCounted).toBe(1);
    expect(debt.nightsMissing).toBe(2);
    expect(debt.actualHours).toBeCloseTo(7, 10);
    expect(debt.expectedHours).toBeCloseTo(8, 10);
  });

  it('charges nothing at all for a window with no records', () => {
    const days = windowFrom('2026-08-01', 14);
    const debt = sleepDebt([], days, TARGET);
    expect(debt.expectedHours).toBe(0);
    expect(debt.actualHours).toBe(0);
    expect(debt.deficitHours).toBe(0);
    expect(debt.nightsMissing).toBe(14);
  });
});

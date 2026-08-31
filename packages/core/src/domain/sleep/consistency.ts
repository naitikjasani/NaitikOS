/**
 * Sleep consistency — §4.6, and the reason `sleep_night` is a table.
 *
 * §4.6 names five things: "Duration, quality, timing, consistency, and
 * disturbances." Four of them are properties of one night. Consistency is not —
 * it is the *relationship between* nights, and no per-metric series can express
 * it, which is exactly §9.2's test for when a thing earns a table.
 *
 * ## The midpoint, and why it is a circular quantity
 *
 * The single most useful number about a sleep schedule is the midpoint: the
 * clock time halfway between lights-out and waking. Its *variability* is what
 * "consistency" means — a person who sleeps seven hours starting at a different
 * hour every night is not a consistent sleeper, and duration alone cannot say
 * so.
 *
 * A midpoint is a time of day, so it lives on a circle. 03:00 and 23:00 are two
 * hours apart, not twenty. An arithmetic standard deviation over minutes-past-
 * midnight does not know that: it reports a sleeper whose midpoint sits at
 * 23:45 one night and 00:15 the next — thirty minutes of drift — as roughly
 * twelve hours of chaos. That is not an edge case. A midpoint near midnight is
 * the ordinary case for most people, so the naive statistic is wrong for the
 * population it would most often be shown to, and wrong in the alarming
 * direction.
 *
 * {@link consistencyOver} therefore computes the *circular* standard deviation:
 * each midpoint becomes an angle on a 24-hour circle, the unit vectors are
 * averaged, and the spread is derived from the length of the resultant. The
 * result is rotation-invariant — the same sleeper shifted twelve hours gets the
 * same answer — which the naive version conspicuously is not.
 *
 * ## What is deliberately absent
 *
 * No sleep score, no letter grade, no composite of duration and timing and
 * quality. Every wearable computes one and no two agree, because the weights
 * are a product decision rather than a finding (§10.0). The figures here are
 * each separately interpretable, and a reader who wants to weigh them may.
 */

import { isoFromMillis, parseInstant } from '../../temporal/instant';
import type { SleepNight } from './night';

export type NightPoint = {
  readonly dayKey: string;
  /** Minutes after local midnight, 0–1439. `null` when the night has no timing. */
  readonly midpointMinutes: number | null;
  readonly durationHours: number | null;
};

/**
 * Below this, the report says "insufficient" instead of a number.
 *
 * Seven — one week, and the smallest window in which a weekday/weekend pattern
 * is even representable. §10.9 requires that an estimate "degrade to
 * *'insufficient data'* rather than a guess", and a spread computed from three
 * nights is a guess wearing a decimal point.
 */
export const MIN_CONSISTENCY_NIGHTS = 7;

const MINUTES_IN_DAY = 1440;
const TAU = Math.PI * 2;

/**
 * The clock time halfway between lights-out and waking, as minutes after local
 * midnight.
 *
 * `null` unless both endpoints exist — a night captured through the Daily Close
 * has a duration and no timing, and there is no midpoint to invent from it.
 *
 * `hourOf` and `minuteOf` are injected for the same reason `focusByHour` injects
 * `hourOf`: zone resolution needs `Intl`, and §5.0 keeps `core` free of
 * anything that is not the language. The midpoint is taken **in the night's own
 * zone**, so a night slept while travelling is compared against the clock the
 * operator was actually living on, which is the whole point of §5.3 storing the
 * zone in the first place.
 */
export function sleepMidpointMinutes(
  night: SleepNight,
  hourOf: (instant: string, zone: string) => number,
  minuteOf: (instant: string, zone: string) => number,
): number | null {
  const { bedAt, wokeAt } = night;
  if (bedAt === null || wokeAt === null) return null;

  const bed = parseInstant(bedAt);
  const woke = parseInstant(wokeAt);
  if (bed === null || woke === null) return null;

  /*
   * The midpoint is found on the *instants* and only then read as a local
   * clock time. Averaging the two local times instead would have to decide what
   * the mean of 23:00 and 07:00 is, which is the same midnight-wrapping problem
   * one layer earlier and with less information to solve it.
   */
  const midpoint = isoFromMillis(Math.round((bed.getTime() + woke.getTime()) / 2));
  const minutes = hourOf(midpoint, night.zone) * 60 + minuteOf(midpoint, night.zone);
  return ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

export type ConsistencyReport = {
  /** Nights actually recorded inside the window. */
  readonly nights: number;
  /** Circular standard deviation of the midpoint, in minutes. */
  readonly midpointSpreadMinutes: number | null;
  readonly meanDurationHours: number | null;
  readonly durationSpreadHours: number | null;
  /** The longest run of consecutive days in the window with no record at all. */
  readonly longestGapNights: number;
  /** True below {@link MIN_CONSISTENCY_NIGHTS}. An answer, not an error (§10.9). */
  readonly insufficient: boolean;
};

/**
 * Population standard deviation.
 *
 * Population rather than sample: the window is not a sample drawn from a larger
 * population of nights, it is every night there was. Bessel's correction would
 * be answering a question nobody asked.
 */
function spread(values: readonly number[]): number {
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Circular standard deviation of a set of times of day, in minutes.
 *
 * Each time becomes a unit vector on a 24-hour circle; the mean vector's length
 * `R` measures how tightly the times cluster (`R = 1` is perfect agreement).
 * The standard deviation follows from `sqrt(-2 ln R)`, the usual definition for
 * a wrapped distribution, converted back from radians to minutes.
 *
 * `null` when `R` is zero: the times cancel exactly, so there is no mean
 * direction and therefore nothing for a spread to be measured *around*. The
 * formula diverges there, and a number would be a worse answer than declining
 * to give one. Floating-point summation rarely lands exactly on zero, so a set
 * of midpoints scattered evenly around the clock yields a very large spread
 * rather than a `null` — which is the truthful reading of it.
 */
function circularSpreadMinutes(minutes: readonly number[]): number | null {
  let cosSum = 0;
  let sinSum = 0;
  for (const value of minutes) {
    const angle = (value / MINUTES_IN_DAY) * TAU;
    cosSum += Math.cos(angle);
    sinSum += Math.sin(angle);
  }

  const resultant = Math.hypot(cosSum, sinSum) / minutes.length;
  if (resultant <= 0) return null;

  /*
   * Clamped twice, and both clamps earn their place.
   *
   * `min(resultant, 1)` because floating-point summation can land a perfectly
   * clustered set at 1 + 1e-16, whose logarithm is negative — the square root
   * would then be NaN for the *most* consistent sleeper there is.
   *
   * `max(0, …)` because `-2 * 0` is `-0`, and `Math.sqrt(-0)` is `-0`. A
   * negative zero travelling out of here is a float artefact, not a
   * measurement, and it makes two identical answers compare unequal.
   */
  const radians = Math.sqrt(Math.max(0, -2 * Math.log(Math.min(resultant, 1))));
  return (radians / TAU) * MINUTES_IN_DAY;
}

/**
 * Consistency over a window.
 *
 * `dayKeys` is the window, one entry per day and in order; `points` are the
 * nights recorded inside it. Points outside the window are ignored rather than
 * quietly widening it — the caller decided what it was asking about.
 *
 * Each figure is judged on **its own** sample size. A window can hold ten
 * nights of which only four have timing, because the Daily Close records a
 * duration without endpoints; reporting a midpoint spread from those four
 * because the window as a whole cleared the bar would be exactly the kind of
 * borrowed confidence §10.9 rules out.
 */
export function consistencyOver(
  points: readonly NightPoint[],
  dayKeys: readonly string[],
): ConsistencyReport {
  const window = new Set(dayKeys);

  /* Keyed by day key: the schema allows one night per morning and a duplicate
   * would weight that morning twice in every figure below. */
  const recorded = new Map<string, NightPoint>();
  for (const point of points) {
    if (window.has(point.dayKey)) recorded.set(point.dayKey, point);
  }

  const midpoints: number[] = [];
  const durations: number[] = [];
  for (const point of recorded.values()) {
    if (point.midpointMinutes !== null) midpoints.push(point.midpointMinutes);
    if (point.durationHours !== null) durations.push(point.durationHours);
  }

  let gap = 0;
  let longestGapNights = 0;
  for (const dayKey of dayKeys) {
    gap = recorded.has(dayKey) ? 0 : gap + 1;
    if (gap > longestGapNights) longestGapNights = gap;
  }

  const nights = recorded.size;
  const enough = (count: number): boolean => count >= MIN_CONSISTENCY_NIGHTS;

  return {
    nights,
    midpointSpreadMinutes: enough(midpoints.length) ? circularSpreadMinutes(midpoints) : null,
    meanDurationHours: enough(durations.length) ? average(durations) : null,
    durationSpreadHours: enough(durations.length) ? spread(durations) : null,
    /*
     * Reported even when the window is insufficient, because it is a count of
     * what is missing rather than an estimate of anything. "You logged two of
     * the last thirty nights" is the most useful sentence the report has when
     * the statistics have nothing to say.
     */
    longestGapNights,
    insufficient: !enough(nights),
  };
}

export type SleepDebt = {
  /** The target multiplied by the nights that were **recorded**, never the window. */
  readonly expectedHours: number;
  readonly actualHours: number;
  /** Expected minus actual. Negative is a surplus, and stays visible as one. */
  readonly deficitHours: number;
  readonly nightsCounted: number;
  readonly nightsMissing: number;
};

/**
 * Accumulated shortfall against a nightly target.
 *
 * **Only recorded nights are charged.** Multiplying the target by the whole
 * window would bill the operator eight hours of debt for every night they
 * simply did not log, which turns a gap in the record into a deficit in the
 * body — a claim the system has no evidence for and P5 does not permit it to
 * make. The unlogged nights are reported separately as `nightsMissing`, so a
 * figure computed from four of thirty days cannot be mistaken for a month.
 *
 * `deficitHours` is signed. Clamping it at zero would make the measure
 * asymmetric: a fortnight of long nights would read as neither debt nor credit,
 * and the operator would have no way to see that they had caught up.
 */
export function sleepDebt(
  points: readonly NightPoint[],
  dayKeys: readonly string[],
  targetHours: number,
): SleepDebt {
  const window = new Set(dayKeys);

  const counted = new Map<string, number>();
  for (const point of points) {
    if (!window.has(point.dayKey) || point.durationHours === null) continue;
    counted.set(point.dayKey, point.durationHours);
  }

  const nightsCounted = counted.size;
  const actualHours = [...counted.values()].reduce((sum, hours) => sum + hours, 0);
  const expectedHours = targetHours * nightsCounted;

  return {
    expectedHours,
    actualHours,
    deficitHours: expectedHours - actualHours,
    nightsCounted,
    /* A night recorded with a quality and no duration counts as missing here.
     * It contributes no hours, and pretending otherwise would mean inventing
     * the number this whole function is about. */
    nightsMissing: dayKeys.length - nightsCounted,
  };
}

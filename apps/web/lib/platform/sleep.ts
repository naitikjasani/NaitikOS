/**
 * The Sleep service — §4.6, assembled.
 *
 * §4.6 makes an unusually strong claim for this module:
 *
 *   "Sleep is the highest-leverage cross-domain variable in the entire system
 *    and is therefore in the MVP's Daily Close despite Sleep not being a full
 *    module until later."
 *
 * That is why every figure here is day-keyed on the same convention the routine,
 * medication and work strips use. The value of a sleep series is almost entirely
 * in what it is laid next to, and a series with its own private idea of where a
 * day begins would be worse than none.
 *
 * ## Nothing here asserts a cause
 *
 * §4.7 forbids the system saying "your mood is low because you skipped the gym",
 * and the prohibition runs in every direction. A short night and a bad day
 * appear next to each other and the system says nothing about which produced
 * which. §10.6's five controls govern any claim stronger than adjacency.
 *
 * ## Nothing here computes a score
 *
 * Every wearable produces one and no two agree, because the weights are a
 * product decision rather than a finding. Consistency, debt and efficiency are
 * three separate figures and stay that way.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { ConsistencyReport, DomainError, NightPoint, SleepDebt, SleepNight } from '@naitikos/core';
import {
  consistencyOver,
  dayKeyInZone,
  hourInZone,
  isoFromMillis,
  minuteInZone,
  shiftDayKey,
  sleepDebt,
  sleepMidpointMinutes,
  systemClock,
  windowDayKeys,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createSleepRepository } from '@naitikos/db';

/**
 * How far back the sleep window reaches.
 *
 * Thirty days. Long enough for `MIN_CONSISTENCY_NIGHTS` to be met with room to
 * spare even through a patchy fortnight, and short enough that the figure
 * describes how the operator is sleeping now rather than averaging over a
 * holiday six weeks ago.
 */
export const SLEEP_WINDOW_DAYS = 30;

/**
 * The nightly target debt is measured against.
 *
 * Eight hours, and it is a **setting written down in one place** rather than a
 * finding. The system has no basis for asserting the operator's individual
 * sleep need, and §10.0 keeps it out of the business of pretending otherwise —
 * the number is here so the page can say what it is comparing against.
 */
export const SLEEP_TARGET_HOURS = 8;

export type SleepBoard = {
  readonly todayDayKey: string;
  /** Newest first, for the list. The repository returns oldest-first for the maths. */
  readonly nights: readonly SleepNight[];
  readonly consistency: ConsistencyReport;
  readonly debt: SleepDebt;
  readonly targetHours: number;
  readonly windowDays: number;
  /** One entry per day in the window, oldest first — the shape the grid wants. */
  readonly series: readonly { readonly dayKey: string; readonly durationHours: number | null }[];
};

export async function loadSleep(db: Database, zone: string): Promise<Result<SleepBoard, DomainError>> {
  const sleep = createSleepRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const fromDayKey = shiftDayKey(todayDayKey, -(SLEEP_WINDOW_DAYS - 1)) ?? todayDayKey;

  const nights = await sleep.nightsBetween(fromDayKey, todayDayKey);
  if (!nights.ok) return nights;

  const dayKeys = windowDayKeys(todayDayKey, SLEEP_WINDOW_DAYS);

  /*
   * The midpoint is read in the zone the night was *recorded* in, which
   * `sleepMidpointMinutes` takes from the night itself rather than from the
   * argument to this function. A week abroad genuinely shifts the operator's
   * midpoint, and reading those nights in the home zone would report a
   * disruption that the body did not experience — §5.3's "a workout at 7am
   * during travel is a materially different fact", applied to sleep.
   */
  const points: readonly NightPoint[] = nights.value.map((night) => ({
    dayKey: night.dayKey,
    midpointMinutes: sleepMidpointMinutes(night, hourInZone, minuteInZone),
    durationHours: night.durationHours === null ? null : Number(night.durationHours),
  }));

  const byDay = new Map(points.map((point) => [point.dayKey, point]));

  return ok({
    todayDayKey,
    nights: [...nights.value].reverse(),
    consistency: consistencyOver(points, dayKeys),
    debt: sleepDebt(points, dayKeys, SLEEP_TARGET_HOURS),
    targetHours: SLEEP_TARGET_HOURS,
    windowDays: SLEEP_WINDOW_DAYS,
    /*
     * A night with no record contributes `null`, never `0`. §8.9 — missing data
     * is shown as missing — and the grid renders the two differently: a morning
     * the operator did not log is not a morning they did not sleep.
     */
    series: dayKeys.map((dayKey) => ({
      dayKey,
      durationHours: byDay.get(dayKey)?.durationHours ?? null,
    })),
  });
}

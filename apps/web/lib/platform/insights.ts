/**
 * The insight service — §2.1's "one deterministic insight family", wired.
 *
 * ## Where the findings surface, and where they do not
 *
 * §3.2 marks `/insights` as V2 and gives the MVP one place for a finding:
 * `/today`'s "Today's signal — at most ONE insight card". So there is no inbox
 * route in this milestone. `loadInsights` feeds the card on `/today`, and the
 * adherence figures themselves appear where they are actionable — on
 * `/mind/meds` and `/body/skin/routine`.
 *
 * The cap is enforced here rather than in the component: {@link topFinding}
 * returns *one*, and a screen that wanted three would have to change this file.
 * §3.3's whole argument is that an interface which shows everything shows
 * nothing, and an insight surface is the easiest place in a health application
 * to violate it.
 *
 * ## Out-of-sample confirmation needs somewhere to keep what it held
 *
 * §10.6 control 4 holds an inferential finding until a second window confirms
 * it, which means the battery has to be told what the previous run held. That
 * store does not exist yet — `insight` is a table in §9.2 and it is not written
 * to in the MVP, because the MVP's findings are all descriptive and none of
 * them is held.
 *
 * So `heldFindingIds` is threaded through and passed as empty. The consequence
 * is stated plainly rather than hidden: **if an inferential detector were
 * enabled today, its findings would be held forever and never promoted.** That
 * is the safe direction to fail in, and the fix is the `insight` repository that
 * V2's inbox needs anyway.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  AdherenceSeries,
  BatteryOutcome,
  DomainError,
  Finding,
  StreakSeries,
} from '@naitikos/core';
import {
  dayAdherence,
  expectedDosesPerDay,
  requiredSteps,
  runBattery,
  scheduleOn,
  windowDayKeys,
  medicationLabel,
  routineDayAdherence,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createMedicationRepository,
  createObservationRepository,
  createRoutineRepository,
} from '@naitikos/db';

import { zonedDayBounds } from '@naitikos/core';

/** The battery's look-back. Long enough to hold a baseline and a recent window. */
export const BATTERY_WINDOW_DAYS = 90;

export async function loadInsights(
  db: Database,
  options: { readonly toDayKey: string; readonly zone: string },
): Promise<Result<BatteryOutcome, DomainError>> {
  const dayKeys = windowDayKeys(options.toDayKey, BATTERY_WINDOW_DAYS);
  const first = dayKeys[0];
  const bounds = first === undefined ? null : zonedDayBounds(first, options.zone);
  const until = zonedDayBounds(options.toDayKey, options.zone);
  if (first === undefined || bounds === null || until === null) {
    return err({
      kind: 'validation',
      code: 'invalid_day',
      message: 'toDayKey must be a YYYY-MM-DD day key.',
      issues: [],
    });
  }

  const medications = createMedicationRepository(db);
  const routines = createRoutineRepository(db);
  const observations = createObservationRepository(db);

  const [register, schedules, doses, activeRoutines, historyCount] = await Promise.all([
    medications.active(),
    medications.schedules(),
    medications.eventsBetween(bounds.start, until.end),
    routines.activeRoutines(),
    observations.count(),
  ]);
  if (!register.ok) return err(register.error);
  if (!schedules.ok) return err(schedules.error);
  if (!doses.ok) return err(doses.error);
  if (!activeRoutines.ok) return err(activeRoutines.error);

  const routineIds = activeRoutines.value.map((routine) => routine.id);
  const [steps, logs] = await Promise.all([
    routines.stepsFor(routineIds),
    routines.logsBetween(routineIds, first, options.toDayKey),
  ]);
  if (!steps.ok) return err(steps.error);
  if (!logs.ok) return err(logs.error);

  const adherence: AdherenceSeries[] = [];
  const streaks: StreakSeries[] = [];

  for (const medication of register.value) {
    adherence.push({
      subject: `medication:${medication.id}`,
      label: medicationLabel(medication),
      kind: 'medication',
      days: dayKeys.map((dayKey) => {
        const schedule = scheduleOn(schedules.value, medication.id, dayKey, options.zone);
        const expected = schedule === null ? null : expectedDosesPerDay(schedule);
        const day = dayAdherence(medication.id, dayKey, options.zone, doses.value, expected);
        return { dayKey, expected: expected ?? 0, completed: day.taken, recorded: day.recorded };
      }),
    });
  }

  for (const routine of activeRoutines.value) {
    const own = steps.value.filter((step) => step.routineId === routine.id);
    const required = requiredSteps(own).length;
    const days = dayKeys.map((dayKey) => {
      const day = routineDayAdherence(routine, own, logs.value, dayKey);
      return { dayKey, expected: required, completed: day.completed, recorded: day.recorded };
    });

    adherence.push({
      subject: `routine:${routine.id}`,
      label: routine.name,
      kind: 'routine',
      days,
    });

    streaks.push({
      subject: `routine:${routine.id}`,
      label: routine.name,
      days: days.map((day) => ({
        dayKey: day.dayKey,
        complete: day.recorded && day.expected > 0 && day.completed >= day.expected,
      })),
    });
  }

  /*
   * `daysOfHistory` is approximated from the observation count rather than from
   * the first observation's date, which would be one more query on a path that
   * already makes seven. The approximation is conservative in the direction
   * that matters — a sparse first month reads as *fewer* days of history, so
   * the sixty-day gate opens later rather than earlier.
   */
  const daysOfHistory = Math.min(BATTERY_WINDOW_DAYS * 4, Math.floor(historyCount / 3));

  return ok(runBattery({ dayKey: options.toDayKey, daysOfHistory, adherence, streaks, heldFindingIds: [] }));
}

/**
 * The one finding `/today` shows. §3.2: "at most ONE insight card".
 *
 * Confirmed before exploratory before descriptive is already the battery's
 * order, so this is `[0]` — but it is a named function rather than an index
 * because the cap is a product rule, and a product rule with no name gets
 * removed by someone tidying up a component.
 */
export function topFinding(outcome: BatteryOutcome): Finding | null {
  return outcome.surfaced[0] ?? null;
}

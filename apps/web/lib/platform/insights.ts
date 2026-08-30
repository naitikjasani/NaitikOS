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
 * ## Out-of-sample confirmation, now closed
 *
 * §10.6 control 4 holds an inferential finding until a second window confirms
 * it, which means the battery has to be told what previous runs held. This file
 * used to pass an empty set and record the consequence: *"if an inferential
 * detector were enabled today, its findings would be held forever and never
 * promoted."*
 *
 * The correlation detector is that detector, so the loop is now closed:
 * `insightRepository.heldSignatures` supplies the set, and
 * {@link recordInsightNight} writes the night's held findings back. Held
 * findings are archived rows that are never surfaced — §10.6 keeps a finding
 * awaiting confirmation out of the inbox.
 *
 * **Signatures, not ids.** A finding's id contains the day key, so the same
 * correlation on two nights has two different ids; comparing on ids would match
 * nothing and reproduce the very bug this paragraph used to describe.
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
  shiftDayKey,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import type { InsightRow } from '@naitikos/db';
import {
  HELD_WINDOW_DAYS,
  createInsightRepository,
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

  const heldSince = zonedDayBounds(shiftDayKey(options.toDayKey, -HELD_WINDOW_DAYS) ?? options.toDayKey, options.zone);
  const held = await createInsightRepository(db).heldSignatures(heldSince?.start ?? bounds.start);
  if (!held.ok) return held;

  return ok(
    runBattery({
      dayKey: options.toDayKey,
      daysOfHistory,
      adherence,
      streaks,
      heldSignatures: held.value,
    }),
  );
}

/**
 * Persist a night's outcome.
 *
 * Called by the nightly job, not by a page render. A read that wrote would mean
 * opening `/today` twice in an evening produced two nights of confirmation
 * evidence — which would let control 4 be satisfied by refreshing a page, and a
 * control that a refresh can satisfy is not a control.
 */
export async function recordInsightNight(
  db: Database,
  outcome: BatteryOutcome,
  nowIso: string,
): Promise<Result<{ readonly surfaced: number; readonly held: number }, DomainError>> {
  return createInsightRepository(db).recordNight({
    /*
     * Descriptive findings are not stored.
     *
     * A count — "the evening routine was logged on 24 of the last 30 days" — is
     * recomputed correctly on every read and is true of a different window each
     * night. Storing it would put a new, nearly-identical row in the inbox every
     * morning, which is the feed §3.3 rules out and the fastest way to make a
     * person stop reading the one surface that occasionally matters.
     */
    surfaced: outcome.surfaced.filter((finding) => finding.confidence !== 'descriptive'),
    held: outcome.held,
    nowIso,
    newId: () => crypto.randomUUID(),
  });
}

/**
 * The inbox — surfaced insights that have not been dismissed.
 *
 * Read from `insight` rather than recomputed from the battery, and the
 * distinction matters. The battery's `surfaced` set is what *tonight's* data
 * supports; the inbox is what was surfaced on the night it was confirmed and
 * has not been dealt with since. An insight that stopped holding yesterday is
 * still the thing the operator was shown, and silently removing it would mean
 * the surface disagreed with the notification that pointed at it.
 */
export async function loadInsightInbox(
  db: Database,
): Promise<Result<readonly InsightRow[], DomainError>> {
  return createInsightRepository(db).inbox();
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

export type { InsightRow };

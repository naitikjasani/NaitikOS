/**
 * The Teeth service — §4.5, assembled almost entirely out of things that
 * already exist.
 *
 * §4.5 is a short section and it names five features. Four of them are already
 * built, filtered rather than reimplemented:
 *
 * | §4.5 asks for | Served by |
 * |---|---|
 * | Per-tooth procedure history | `procedure` + `toothNotation`, shipped with Health |
 * | Hygiene routine and adherence | The generic routine engine, `kind: 'dental'` |
 * | Appointment cadence | `appointment`, filtered by specialty |
 * | Sensitivity and pain log | `symptom`, filtered by body site |
 * | Cost tracking | `procedure.costMinor` — displayed, not summed into anything |
 *
 * §9.2 predicted exactly this for the routine engine: "One implementation,
 * three consumers — the alternative is three near-identical adherence systems."
 * This file is what that prediction being right looks like in practice: a
 * filter and a loader, and no new adherence code at all.
 *
 * ## The filters are string matches, and that is a real limitation
 *
 * A dental appointment is one whose specialty says so; a tooth symptom is one
 * whose body site does. Neither column is an enum, and neither should become
 * one — §9.2 leaves them free text because a specialty vocabulary is exactly
 * the kind of list that is wrong in year three. The cost is that an appointment
 * filed with no specialty does not appear here, which is stated on the screen
 * rather than silently absorbed.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  Appointment,
  DentalProcedure,
  DomainError,
  Routine,
  RoutineStep,
  RoutineWindowAdherence,
  Symptom,
} from '@naitikos/core';
import {
  byTooth,
  dayKeyInZone,
  isoFromMillis,
  routineWindowAdherence,
  systemClock,
  totalCost,
  windowDayKeys,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createHealthRepository, createRoutineRepository } from '@naitikos/db';

/** How far back the symptom log and the adherence grid look. */
export const TEETH_WINDOW_DAYS = 90;
/** The adherence window quoted on the hygiene screen. */
export const HYGIENE_WINDOW_DAYS = 30;

/**
 * Words that mark an appointment or a symptom as dental.
 *
 * Matched case-insensitively against `specialty` and `bodySite`. A small list
 * rather than a clever one: the operator types these, and a matcher that tried
 * to be exhaustive would start claiming appointments that are not dental.
 */
const DENTAL_WORDS: readonly string[] = Object.freeze([
  'dental',
  'dentist',
  'dentistry',
  'orthodont',
  'endodont',
  'periodont',
  'hygienist',
  'tooth',
  'teeth',
  'gum',
  'jaw',
  'molar',
]);

function isDental(value: string | null): boolean {
  if (value === null) return false;
  const lowered = value.toLowerCase();
  return DENTAL_WORDS.some((word) => lowered.includes(word));
}

export type ToothHistory = {
  readonly notation: string;
  readonly label: string;
  readonly procedures: readonly DentalProcedure[];
};

export type TeethOverview = {
  readonly procedures: readonly DentalProcedure[];
  readonly byTooth: ReadonlyMap<string, readonly DentalProcedure[]>;
  readonly costs: readonly { readonly currency: string; readonly minor: number }[];
  readonly routines: readonly { readonly routine: Routine; readonly steps: readonly RoutineStep[]; readonly adherence: RoutineWindowAdherence }[];
  readonly appointments: readonly Appointment[];
  readonly symptoms: readonly Symptom[];
  /** Appointments with no specialty recorded, which this page cannot classify. */
  readonly unclassifiedAppointments: number;
  readonly todayDayKey: string;
};

export async function loadTeeth(db: Database, zone: string): Promise<Result<TeethOverview, DomainError>> {
  const health = createHealthRepository(db);
  const routines = createRoutineRepository(db);

  const nowMillis = systemClock.nowMillis();
  const todayDayKey = dayKeyInZone(isoFromMillis(nowMillis), zone);
  const from = isoFromMillis(nowMillis - TEETH_WINDOW_DAYS * 86_400_000);
  const until = isoFromMillis(nowMillis + 86_400_000);

  const [procedures, appointments, symptoms, dental] = await Promise.all([
    health.procedures(),
    health.appointments(),
    health.symptomsBetween(from, until),
    /* The engine is kind-agnostic and the wire contract already filters on it;
     * Teeth is a consumer, not a second implementation (§9.2). */
    routines.activeRoutines('dental'),
  ]);

  if (!procedures.ok) return procedures;
  if (!appointments.ok) return appointments;
  if (!symptoms.ok) return symptoms;
  if (!dental.ok) return dental;

  const dayKeys = windowDayKeys(todayDayKey, HYGIENE_WINDOW_DAYS);
  const routineIds = dental.value.map((entry) => entry.id);

  const [steps, logs] = await Promise.all([
    routines.stepsFor(routineIds),
    routines.logsBetween(routineIds, dayKeys[0] ?? todayDayKey, todayDayKey),
  ]);
  if (!steps.ok) return steps;
  if (!logs.ok) return logs;

  const withAdherence = dental.value.map((entry) => {
    const own = steps.value.filter((step) => step.routineId === entry.id);
    return {
      routine: entry,
      steps: own,
      adherence: routineWindowAdherence(
        entry,
        own,
        logs.value.filter((log) => log.routineId === entry.id),
        dayKeys,
      ),
    };
  });

  /*
   * Only procedures with a tooth are grouped. A scale and polish has no tooth
   * and belongs in the chronological list, not under a heading that implies it
   * happened to one.
   */
  const dentalProcedures = procedures.value.filter((entry) => entry.toothNotation !== null || isDental(entry.name));

  return ok({
    procedures: dentalProcedures,
    byTooth: byTooth(dentalProcedures),
    costs: totalCost(dentalProcedures),
    routines: withAdherence,
    appointments: appointments.value.filter(
      (entry) => isDental(entry.specialty) || isDental(entry.title) || isDental(entry.provider),
    ),
    symptoms: symptoms.value.filter((entry) => isDental(entry.bodySite) || isDental(entry.name)),
    unclassifiedAppointments: appointments.value.filter((entry) => entry.specialty === null).length,
    todayDayKey,
  });
}

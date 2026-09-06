/**
 * One medication — §3.2's `/body/health/medications/:id`, "detail + adherence
 * + side effects".
 *
 * ## The dose history is the reason this page exists
 *
 * The register at `/body/health/medications` shows the current dose. It cannot
 * show how the operator got to it, and for a psychiatric medication that is
 * most of the clinically interesting information: 37.5 mg for a fortnight, then
 * 75, then 150 — a titration — reads completely differently from a single jump,
 * and a prescriber asks about it.
 *
 * The schema already holds this, and holds it deliberately. §9.5 makes a dose
 * change a **new `medication_schedule` row with its own validity interval**,
 * never an update of the old one, and `0002_medication_schedule_exclusion` adds
 * a database constraint forbidding two overlapping believed schedules. So the
 * history is not reconstructed here; it is read. This page is the only surface
 * in the system where that design is visible, which is a fair argument that it
 * should have existed before now.
 *
 * ## Side effects are suspicions, and stay labelled as suspicions
 *
 * The column is `suspectedMedicationId`, and §9.2 fixes what that means:
 * *"linked but never asserted as causal by the system."* `domain/health/
 * side-effect.ts` gives the specific reason it matters here rather than in the
 * abstract:
 *
 *   "An SNRI, an SSRI and isotretinoin share a long list of overlapping
 *    documented effects, so a system that picked one would be guessing with a
 *    confident interface."
 *
 * The operator's suspicion is a fact worth recording. This module carries it
 * without adding to it — no likelihood, no "commonly associated with", no
 * count of how many effects point at this substance, because a count is an
 * argument.
 *
 * ## Nothing here computes adherence
 *
 * `windowAdherence` does, in `core`, and it is the same function the
 * Consultation Pack and both register lenses call. §4.4's claim that Health
 * holds "the authoritative medication register consumed by Mind, Skin, and
 * adherence detection across the system" only stays true while there is one
 * calculation — and the part of it that would silently drift if copied is the
 * rule that a day with no record is not a missed dose.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Medication,
  MedicationSchedule,
  SideEffect,
  WindowAdherence,
} from '@naitikos/core';
import {
  dayKeyInZone,
  expectedDosesPerDay,
  isoFromMillis,
  medicationLabel,
  systemClock,
  windowAdherence,
  windowDayKeys,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createHealthRepository, createMedicationRepository } from '@naitikos/db';

/**
 * The adherence window on the detail page.
 *
 * Ninety days rather than the register's thirty. Thirty answers "am I taking
 * it"; this page is the one a person opens before an appointment, and a
 * quarter is the interval those actually run at. It is also long enough to
 * contain a dose change, which is what makes the two halves of the page relate
 * to each other rather than sit side by side.
 */
export const MEDICATION_DETAIL_WINDOW_DAYS = 90;

/** One row of the dose history, with the interval it was believed over. */
export type DosePeriod = {
  readonly scheduleId: string;
  readonly dose: string;
  readonly doseUnit: string;
  readonly frequency: string;
  readonly times: readonly string[];
  readonly fromDayKey: string;
  /** `null` for the schedule still in force. */
  readonly toDayKey: string | null;
  /**
   * Doses expected each day under this schedule, or `null`.
   *
   * `null` for `as_needed` and for anything less frequent than daily —
   * `expectedDosesPerDay` refuses rather than inventing a denominator, because
   * a weekly medication forced into a daily one reports 0 of 1 on six days in
   * seven for a perfectly adherent operator.
   */
  readonly expectedPerDay: number | null;
  /** True for the schedule with no end. */
  readonly current: boolean;
};

export type MedicationDetail = {
  readonly medication: Medication;
  readonly label: string;
  /** Oldest first. A titration reads forwards. */
  readonly doseHistory: readonly DosePeriod[];
  readonly adherence: WindowAdherence;
  readonly windowDays: number;
  readonly fromDayKey: string;
  readonly toDayKey: string;
  /**
   * Side effects the operator suspected of *this* medication.
   *
   * Never the whole list narrowed by a guess: an effect with no suspected
   * medication is not evidence about this one, and does not appear here.
   */
  readonly suspectedEffects: readonly SideEffect[];
  readonly zone: string;
};

export async function loadMedicationDetail(
  db: Database,
  medicationId: string,
  zone: string,
): Promise<Result<MedicationDetail | null, DomainError>> {
  const medications = createMedicationRepository(db);
  const health = createHealthRepository(db);

  const found = await medications.byId(medicationId);
  if (!found.ok) return found;
  /*
   * `null`, not an error. A soft-deleted or unknown id becomes a 404 at the
   * page, which is the honest answer — §9.4 keeps deleted rows, and a
   * repository that filters them out is telling the truth about what the
   * operator may read, not reporting a fault.
   */
  if (found.value === null) return ok(null);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const toDayKey = dayKeyInZone(nowIso, zone);
  const dayKeys = windowDayKeys(toDayKey, MEDICATION_DETAIL_WINDOW_DAYS);
  const from = isoFromMillis(systemClock.nowMillis() - MEDICATION_DETAIL_WINDOW_DAYS * 86_400_000);

  const [schedules, events, effects] = await Promise.all([
    medications.schedules([medicationId]),
    medications.eventsBetween(from, nowIso),
    health.sideEffects(),
  ]);
  if (!schedules.ok) return schedules;
  if (!events.ok) return events;
  if (!effects.ok) return effects;

  /*
   * `eventsBetween` is not scoped to one medication, so the filter is here.
   * Passing unrelated events into `windowAdherence` would not corrupt the
   * figure — `dayAdherence` checks `medicationId` on every event — but it would
   * make this file depend on that check staying, which is the kind of coupling
   * that survives right up until someone optimises the loop.
   */
  const mine = events.value.filter((event) => event.medicationId === medicationId);

  return ok({
    medication: found.value,
    label: medicationLabel(found.value),
    doseHistory: doseHistory(schedules.value, zone),
    adherence: windowAdherence(found.value, schedules.value, mine, dayKeys, zone),
    windowDays: MEDICATION_DETAIL_WINDOW_DAYS,
    fromDayKey: dayKeys[0] ?? toDayKey,
    toDayKey,
    suspectedEffects: suspectedOf(effects.value, medicationId),
    zone,
  });
}

/**
 * The schedule chain, oldest first.
 *
 * Ordered by `validFrom` here rather than trusting the repository's order,
 * because the register lists schedules newest-first — right for a register,
 * wrong for a titration, which is a sequence and reads in the direction it
 * happened.
 */
function doseHistory(schedules: readonly MedicationSchedule[], zone: string): readonly DosePeriod[] {
  return [...schedules]
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0))
    .map((schedule) => ({
      scheduleId: schedule.id,
      dose: schedule.dose,
      doseUnit: schedule.doseUnit,
      frequency: schedule.frequency,
      times: schedule.times,
      fromDayKey: dayKeyInZone(schedule.validFrom, zone),
      toDayKey: schedule.validTo === null ? null : dayKeyInZone(schedule.validTo, zone),
      expectedPerDay: expectedDosesPerDay(schedule),
      current: schedule.validTo === null,
    }));
}

/** Effects the operator pointed at this medication. Most recent onset first. */
function suspectedOf(effects: readonly SideEffect[], medicationId: string): readonly SideEffect[] {
  return effects
    .filter((effect) => effect.suspectedMedicationId === medicationId)
    .sort((a, b) => ((a.onsetAt ?? '') < (b.onsetAt ?? '') ? 1 : -1));
}

/**
 * A medication is not offered for deletion, and there is no edit here.
 *
 * §9.4 makes deletion soft and §9.5 makes a dose change a new schedule rather
 * than an edit, so both of those are writes with their own shape and their own
 * endpoint — `registerMedication` and the schedule writer. A detail page that
 * offered an inline "change dose" field would be the one place in the system
 * where the temptation to `UPDATE` a believed row appeared, and the dose
 * history above is exactly what that update would erase.
 */

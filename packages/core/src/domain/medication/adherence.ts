/**
 * Medication adherence — §2.1's "one deterministic insight family", and the
 * half of §4.7 that Mind reads rather than owns.
 *
 * §4.7 is explicit about ownership: "Medication data lives in Health; Mind reads
 * it." So this module is not under `domain/mind`. It is its own thing, and the
 * Mind surface at `/mind/meds` is a filtered lens over it (§3.3(3): "one row,
 * three lenses").
 *
 * ## The rule that governs every function here
 *
 * From the metric registry entry for `medication.adherence`:
 *
 *   "A day with no record is not counted as a missed dose — absence of data is
 *    not evidence of non-adherence, and conflating them makes every figure
 *    quietly wrong."
 *
 * This is not a nicety. The operator takes an SSRI and an SNRI; a psychiatrist
 * asking "have you been taking it?" is asking a clinical question, and an
 * adherence figure that silently counts every un-logged day as a missed dose
 * would answer it with a number that is *wrong in the direction that changes
 * prescribing*. So {@link windowAdherence} reports three quantities — days
 * recorded, doses taken, doses expected *on recorded days* — and the ratio is
 * over recorded days only, with the unrecorded count carried alongside so no
 * surface can present the ratio without it.
 *
 * ## Medication changes are chart furniture
 *
 * §4.7: "Medication changes are annotated on every chart in the system. A mood
 * trend without a 'started Escitalopram' marker is a misleading chart."
 * {@link medicationAnnotations} turns the register into those markers. It lives
 * here rather than in the chart layer because the rule is clinical, not visual:
 * a dose change is an annotation for the same reason a start is, and only this
 * module knows that a new `medication_schedule` row *is* a dose change.
 */

import type { Decimal } from '../../units/decimal';
import { compareDecimal, formatDecimal, parseDecimal } from '../../units/decimal';
import { dayKeyInZone } from '../../timeline/grouping';

export const ADHERENCE_METRIC = 'medication.adherence';

/* -------------------------------------------------------------------------
 * The register, as adherence needs to see it
 * ---------------------------------------------------------------------- */

export type Medication = {
  readonly id: string;
  readonly substance: string;
  readonly brandName: string | null;
  readonly strength: string | null;
  readonly strengthUnit: string | null;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly stopReason: string | null;
  readonly isPsychiatric: boolean;
};

export type MedicationSchedule = {
  readonly id: string;
  readonly medicationId: string;
  readonly dose: string;
  readonly doseUnit: string;
  /** `daily`, `twice_daily`, `weekly`, `as_needed`. */
  readonly frequency: string;
  /** Local clock times, `['08:00', '20:00']`. Empty means "use the frequency". */
  readonly times: readonly string[];
  readonly validFrom: string;
  readonly validTo: string | null;
};

export type MedicationEventKind = 'taken' | 'skipped' | 'delayed';

export type MedicationEvent = {
  readonly id: string;
  readonly medicationId: string;
  readonly scheduleId: string | null;
  readonly kind: MedicationEventKind;
  readonly scheduledFor: string | null;
  readonly takenAt: string | null;
  readonly zone: string | null;
};

/** `Venlafaxine XR 150 mg`, assembled once so every surface says it the same way. */
export function medicationLabel(medication: Medication): string {
  const name = medication.brandName ?? medication.substance;
  if (medication.strength === null || medication.strengthUnit === null) return name;
  return `${name} ${medication.strength} ${medication.strengthUnit}`;
}

/* -------------------------------------------------------------------------
 * How many doses were due
 * ---------------------------------------------------------------------- */

/**
 * Doses expected on one day, or `null` when the schedule has no daily
 * denominator.
 *
 * `null` for `as_needed` — there is nothing to adhere to — and `null` for
 * anything less frequent than daily. That second case is a deliberate refusal
 * rather than an omission: a weekly medication forced into a daily denominator
 * reports 0 of 1 on six days out of seven, which would drag the trailing mean
 * to roughly 0.14 for a perfectly adherent operator. Weekly adherence needs a
 * weekly window, and neither active medication is weekly, so the honest move is
 * to report nothing rather than something wrong.
 */
export function expectedDosesPerDay(schedule: Pick<MedicationSchedule, 'frequency' | 'times'>): number | null {
  if (schedule.times.length > 0) return schedule.times.length;
  switch (schedule.frequency.trim().toLowerCase()) {
    case 'daily':
    case 'once_daily':
      return 1;
    case 'twice_daily':
      return 2;
    case 'three_times_daily':
      return 3;
    case 'four_times_daily':
      return 4;
    default:
      return null;
  }
}

/** The schedule in force on a day, or `null`. Believed-interval arithmetic (§9.5). */
export function scheduleOn(
  schedules: readonly MedicationSchedule[],
  medicationId: string,
  dayKey: string,
  zone: string,
): MedicationSchedule | null {
  let best: MedicationSchedule | null = null;
  for (const schedule of schedules) {
    if (schedule.medicationId !== medicationId) continue;
    const from = dayKeyInZone(schedule.validFrom, zone);
    if (from > dayKey) continue;
    if (schedule.validTo !== null && dayKeyInZone(schedule.validTo, zone) <= dayKey) continue;
    if (best === null || dayKeyInZone(best.validFrom, zone) < from) best = schedule;
  }
  return best;
}

/* -------------------------------------------------------------------------
 * One day
 * ---------------------------------------------------------------------- */

export type DayAdherence = {
  readonly dayKey: string;
  readonly medicationId: string;
  readonly expected: number | null;
  readonly taken: number;
  readonly skipped: number;
  /** `null` when nothing was recorded, or when the schedule has no denominator. */
  readonly ratio: number | null;
  readonly recorded: boolean;
};

/**
 * Adherence for one medication on one day.
 *
 * A `delayed` event counts as taken. It is a dose that went in, late; counting
 * it as a miss would conflate "took it at eleven instead of eight" with "did
 * not take it", and the first of those is not a clinical event.
 *
 * The ratio is clamped at 1. A double-dose day is a real thing that happens and
 * it is not 200% adherence — the extra dose is a different fact, and the count
 * is right there in `taken` for anyone who wants it.
 */
export function dayAdherence(
  medicationId: string,
  dayKey: string,
  zone: string,
  events: readonly MedicationEvent[],
  expected: number | null,
): DayAdherence {
  let taken = 0;
  let skipped = 0;

  for (const event of events) {
    if (event.medicationId !== medicationId) continue;
    const at = event.takenAt ?? event.scheduledFor;
    if (at === null) continue;
    if (dayKeyInZone(at, event.zone ?? zone) !== dayKey) continue;
    if (event.kind === 'skipped') skipped += 1;
    else taken += 1;
  }

  const recorded = taken + skipped > 0;
  const ratio =
    expected === null || expected === 0 || !recorded ? null : Math.min(1, taken / expected);

  return { dayKey, medicationId, expected, taken, skipped, ratio, recorded };
}

/* -------------------------------------------------------------------------
 * A window
 * ---------------------------------------------------------------------- */

export type WindowAdherence = {
  readonly medicationId: string;
  readonly label: string;
  readonly windowDays: number;
  /** Days in the window on which *something* was recorded for this medication. */
  readonly recordedDays: number;
  /** Days in the window with no record at all. Never treated as misses. */
  readonly unrecordedDays: number;
  readonly dosesTaken: number;
  readonly dosesSkipped: number;
  /** Doses expected across recorded days only. */
  readonly dosesExpected: number;
  /** `dosesTaken / dosesExpected`, or `null` when nothing is comparable. */
  readonly ratio: number | null;
  /**
   * The sentence a surface renders.
   *
   * Assembled here so every surface says it identically, and so the unrecorded
   * count can never be dropped in the rendering. §4.7's "no negative framing"
   * applies: this reports counts, never "you missed".
   */
  readonly sentence: string;
  readonly days: readonly DayAdherence[];
};

export function windowAdherence(
  medication: Medication,
  schedules: readonly MedicationSchedule[],
  events: readonly MedicationEvent[],
  dayKeys: readonly string[],
  zone: string,
): WindowAdherence {
  const days: DayAdherence[] = [];
  let dosesTaken = 0;
  let dosesSkipped = 0;
  let dosesExpected = 0;
  let recordedDays = 0;

  for (const dayKey of dayKeys) {
    const schedule = scheduleOn(schedules, medication.id, dayKey, zone);
    const expected = schedule === null ? null : expectedDosesPerDay(schedule);
    const day = dayAdherence(medication.id, dayKey, zone, events, expected);
    days.push(day);

    if (!day.recorded) continue;
    recordedDays += 1;
    dosesTaken += day.taken;
    dosesSkipped += day.skipped;
    if (expected !== null) dosesExpected += expected;
  }

  const ratio = dosesExpected === 0 ? null : Math.min(1, dosesTaken / dosesExpected);
  const label = medicationLabel(medication);
  const unrecordedDays = dayKeys.length - recordedDays;

  const sentence =
    ratio === null
      ? `No doses recorded for ${label} in the last ${String(dayKeys.length)} days.`
      : `${String(dosesTaken)} of ${String(dosesExpected)} scheduled doses recorded as taken across ${String(recordedDays)} days with a record. ${
          unrecordedDays === 0
            ? 'Every day in the window has a record.'
            : `${String(unrecordedDays)} days have no record either way.`
        }`;

  return {
    medicationId: medication.id,
    label,
    windowDays: dayKeys.length,
    recordedDays,
    unrecordedDays,
    dosesTaken,
    dosesSkipped,
    dosesExpected,
    ratio,
    sentence,
    days,
  };
}

/* -------------------------------------------------------------------------
 * Chart annotations (§4.7)
 * ---------------------------------------------------------------------- */

export type MedicationAnnotationKind = 'started' | 'stopped' | 'dose_changed';

export type MedicationAnnotation = {
  readonly dayKey: string;
  readonly kind: MedicationAnnotationKind;
  readonly medicationId: string;
  /** `Started Escitalopram 10 mg`. Rendered verbatim on the chart. */
  readonly label: string;
};

/**
 * Every start, stop, and dose change in the register, as chart markers.
 *
 * A dose change is *the second and subsequent schedule* for a medication, in
 * `validFrom` order, whose dose differs from its predecessor's. Two schedules
 * with the same dose and a different frequency are a change too — the same
 * milligrams split across two times a day is a different regimen — so the
 * comparison is on the pair.
 *
 * Doses are compared as decimals rather than strings: `10` and `10.0` are the
 * same dose and would otherwise produce a phantom marker on a chart the moment
 * anyone re-entered a schedule by hand.
 */
export function medicationAnnotations(
  medications: readonly Medication[],
  schedules: readonly MedicationSchedule[],
  zone: string,
): readonly MedicationAnnotation[] {
  const annotations: MedicationAnnotation[] = [];

  for (const medication of medications) {
    const label = medicationLabel(medication);

    if (medication.startedAt !== null) {
      annotations.push({
        dayKey: dayKeyInZone(medication.startedAt, zone),
        kind: 'started',
        medicationId: medication.id,
        label: `Started ${label}`,
      });
    }
    if (medication.stoppedAt !== null) {
      annotations.push({
        dayKey: dayKeyInZone(medication.stoppedAt, zone),
        kind: 'stopped',
        medicationId: medication.id,
        label: `Stopped ${label}`,
      });
    }

    const ordered = schedules
      .filter((schedule) => schedule.medicationId === medication.id)
      .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));

    for (const [index, schedule] of ordered.entries()) {
      if (index === 0) continue;
      const previous = ordered[index - 1];
      if (previous === undefined) continue;
      if (!doseChanged(previous, schedule)) continue;
      annotations.push({
        dayKey: dayKeyInZone(schedule.validFrom, zone),
        kind: 'dose_changed',
        medicationId: medication.id,
        label: `${medication.brandName ?? medication.substance} → ${schedule.dose} ${schedule.doseUnit}`,
      });
    }
  }

  return annotations.sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

function doseChanged(previous: MedicationSchedule, next: MedicationSchedule): boolean {
  if (previous.frequency !== next.frequency) return true;
  if (previous.doseUnit !== next.doseUnit) return true;
  const before = decimalOrNull(previous.dose);
  const after = decimalOrNull(next.dose);
  if (before === null || after === null) return previous.dose !== next.dose;
  return compareDecimal(before, after) !== 0;
}

function decimalOrNull(value: string): Decimal | null {
  return parseDecimal(value);
}

/** The adherence ratio as the decimal string the observation log stores. */
export function adherenceValue(ratio: number): string {
  const parsed = parseDecimal(ratio.toFixed(4));
  return parsed === null ? '0' : formatDecimal(parsed, { trim: true });
}

/**
 * The Consultation Pack — §10.7, assembled.
 *
 * ## Nothing here calls a model
 *
 * §10.11 routes "Consultation Pack synthesis" to Opus at `xhigh`, and that call
 * drafts the *phrasing* of the questions and the connective prose. Every fact
 * on the page — every medication, every lab value, every date — is assembled
 * here from the record, because §10.0 puts the model outside the path of any
 * number a person reads.
 *
 * The consequence is that the pack works with no model, no API key and no
 * budget remaining. That is not a degraded mode; it is the design. A document
 * taken into a consultation must not depend on a third party being up, and a
 * pack that produced nothing on the one morning it mattered would be worse than
 * not having one.
 *
 * ## The question list is `deriveQuestions`, not a second implementation
 *
 * `/body/health/appointments/[id]` already derives a ranked question list from
 * labs, adherence, side effects, symptoms and conditions. The pack uses the same
 * function with the same inputs. Two implementations of "what should I ask"
 * would be two things to keep in step, and the one that got stale would be the
 * one printed and taken into the room.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  ConsultationPackDocument,
  DomainError,
  PackConditionRow,
  PackLabRow,
  PackMedicationRow,
  PackSpecialty,
  PackSymptomRow,
  PackTreatmentRow,
} from '@naitikos/core';
import {
  PACK_LIMITATION,
  adherenceNote,
  dayKeyInZone,
  deriveQuestions,
  effectiveFlag,
  formatMeasured,
  isRelevantTo,
  isoFromMillis,
  orderSection,
  shiftDayKey,
  sideEffectLeads,
  specialtyFor,
  systemClock,
  windowAdherence,
  windowDayKeys,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createHealthRepository,
  createLabRepository,
  createMedicationRepository,
} from '@naitikos/db';

/** How far back a pack reads by default. */
export const PACK_WINDOW_DAYS = 365;

/** The window adherence is computed over, matching the appointment screen. */
export const PACK_ADHERENCE_DAYS = 30;

export type PackRequest = {
  readonly specialty: string;
  readonly windowDays?: number;
  readonly zone: string;
};

export async function loadConsultationPack(
  db: Database,
  request: PackRequest,
): Promise<Result<ConsultationPackDocument, DomainError>> {
  const specialty = specialtyFor(request.specialty);
  const windowDays = request.windowDays ?? PACK_WINDOW_DAYS;

  const health = createHealthRepository(db);
  const labs = createLabRepository(db);
  const medications = createMedicationRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const toDayKey = dayKeyInZone(nowIso, request.zone);
  const fromDayKey = shiftDayKey(toDayKey, -windowDays) ?? toDayKey;
  const fromIso = zonedDayBounds(fromDayKey, request.zone)?.start ?? nowIso;
  const adherenceFromIso =
    zonedDayBounds(shiftDayKey(toDayKey, -PACK_ADHERENCE_DAYS) ?? toDayKey, request.zone)?.start ?? nowIso;

  const [conditions, sideEffects, symptoms, courses, tracked, active, schedules, events] =
    await Promise.all([
      health.conditions(),
      health.sideEffects(),
      health.symptomsBetween(fromIso, nowIso),
      health.treatmentCourses(),
      labs.trackedAnalytes(),
      medications.all(),
      medications.schedules(),
      medications.eventsBetween(adherenceFromIso, nowIso),
    ]);

  if (!conditions.ok) return conditions;
  if (!sideEffects.ok) return sideEffects;
  if (!symptoms.ok) return symptoms;
  if (!courses.ok) return courses;
  if (!tracked.ok) return tracked;
  if (!active.ok) return active;
  if (!schedules.ok) return schedules;
  if (!events.ok) return events;

  /* --- history ------------------------------------------------------- */

  const conditionRows: PackConditionRow[] = conditions.value.map((condition) => ({
    id: condition.id,
    name: condition.name,
    status: condition.status,
    severity: condition.severity,
    since: condition.validFrom,
    until: condition.validTo,
    diagnosedBy: condition.diagnosedBy,
    lead: isRelevantTo(specialty, condition.name),
  }));

  /* --- medications with adherence ------------------------------------ */

  const dayKeys = windowDayKeys(toDayKey, PACK_ADHERENCE_DAYS);

  const medicationRows: PackMedicationRow[] = active.value.map((medication) => {
    const own = schedules.value.filter((schedule) => schedule.medicationId === medication.id);
    const window = windowAdherence(
      medication,
      own,
      events.value.filter((event) => event.medicationId === medication.id),
      dayKeys,
      request.zone,
    );

    const asNeeded = own.length > 0 && own.every((schedule) => schedule.frequency === 'as_needed');
    const current = own.at(-1) ?? null;

    return {
      id: medication.id,
      label: window.label,
      dose: current === null ? null : `${formatMeasured(current.dose)} ${current.doseUnit}`,
      frequency: current?.frequency ?? null,
      startedAt: medication.startedAt,
      stoppedAt: medication.stoppedAt,
      adherence: asNeeded || window.dosesExpected <= 0 ? null : window.ratio,
      adherenceNote: adherenceNote({
        logged: window.dosesTaken,
        scheduled: window.dosesExpected,
        asNeeded,
      }),
      /*
       * A stopped medication does not lead, whatever its name matches. §10.7's
       * section is "current medications"; a drug stopped two years ago belongs
       * in the pack — a prescriber needs to know it was tried — but not at the
       * top of the page a consultation starts from.
       */
      lead: medication.stoppedAt === null && isRelevantTo(specialty, medication.substance, medication.brandName),
    };
  });

  /* --- labs with their previous value -------------------------------- */

  const labRows: PackLabRow[] = [];
  for (const entry of tracked.value) {
    const results = await labs.resultsForAnalyte(entry.slug);
    if (!results.ok) return results;

    const latest = results.value.at(-1);
    if (latest === undefined) continue;

    const previous = results.value.at(-2) ?? null;
    /* The whole printed range, not just its two numbers. `text` carries the
     * non-numeric forms ("Not detected", "< 0.5") that a report actually uses,
     * and dropping it would make a qualitative result look unclassified. */
    const flag = effectiveFlag(latest.flag, latest.value, {
      low: latest.referenceLow,
      high: latest.referenceHigh,
      text: latest.referenceText,
      unit: latest.unit,
    });

    labRows.push({
      resultId: latest.id,
      analyte: entry.slug,
      /* A qualitative result — "Not detected", "Negative" — has no numeric
       * value. Its `valueText` is the result, and substituting a dash for the
       * missing number would print a blank where the report said something. */
      value: latest.value === null ? (latest.valueText ?? '—') : formatMeasured(latest.value),
      unit: latest.unit,
      collectedAt: latest.collectedAt,
      rangeText: rangeTextOf(latest.referenceLow, latest.referenceHigh, latest.unit, latest.referenceText),
      flag: flag.flag,
      flagSource: flag.source,
      previous:
        previous === null
          ? null
          : {
              value: previous.value === null ? (previous.valueText ?? '—') : formatMeasured(previous.value),
              collectedAt: previous.collectedAt,
            },
      /*
       * An out-of-range result leads regardless of specialty. A flagged value is
       * the one thing on this page a clinician of any discipline would want to
       * see, and burying it behind a keyword list that did not happen to contain
       * the analyte's name would be the filter causing the harm it exists to
       * avoid.
       */
      lead: flag.flag !== null || isRelevantTo(specialty, entry.slug),
    });
  }

  /* --- symptoms ------------------------------------------------------ */

  const byName = new Map<string, { count: number; row: PackSymptomRow }>();
  for (const symptom of symptoms.value) {
    const existing = byName.get(symptom.name);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    byName.set(symptom.name, {
      count: 1,
      row: {
        id: symptom.id,
        name: symptom.name,
        bodySite: symptom.bodySite,
        startedAt: symptom.startedAt,
        endedAt: symptom.endedAt,
        severity: symptom.severity,
        occurrences: 1,
        lead: isRelevantTo(specialty, symptom.name, symptom.bodySite),
      },
    });
  }
  const symptomRows: PackSymptomRow[] = [...byName.values()].map((entry) => ({
    ...entry.row,
    occurrences: entry.count,
  }));

  /* --- treatments already attempted ---------------------------------- */

  const treatmentRows: PackTreatmentRow[] = courses.value.map((course) => ({
    id: course.id,
    label:
      course.cumulativeDose === null || course.cumulativeDoseUnit === null
        ? course.name
        : `${course.name} — ${formatMeasured(course.cumulativeDose)} ${course.cumulativeDoseUnit} cumulative`,
    startedAt: course.startedAt,
    endedAt: course.endedAt,
    outcome: course.outcomeNote ?? course.outcome,
    lead: isRelevantTo(specialty, course.name, course.outcomeNote),
  }));

  /* --- the questions, from the same function the appointment screen uses */

  const derived = deriveQuestions({
    labs: labRows
      .filter((row) => row.flag !== null)
      .map((row) => ({
        resultId: row.resultId,
        analyte: row.analyte,
        value: row.value,
        unit: row.unit,
        collectedAt: row.collectedAt,
        rangeText: row.rangeText ?? 'no range printed',
        flag: row.flag,
        flagSource: row.flagSource,
        previous: row.previous,
      })),
    adherence: medicationRows
      .filter((row) => row.adherence !== null)
      .map((row) => ({
        medicationId: row.id,
        label: row.label,
        daysTaken: Math.round((row.adherence ?? 0) * PACK_ADHERENCE_DAYS),
        daysExpected: PACK_ADHERENCE_DAYS,
        windowDays: PACK_ADHERENCE_DAYS,
      })),
    sideEffects: sideEffects.value.map((effect) => ({
      sideEffectId: effect.id,
      effect: effect.effect,
      medicationLabel:
        medicationRows.find((row) => row.id === effect.suspectedMedicationId)?.label ?? null,
      onsetAt: effect.onsetAt,
      reportedToPrescriber: !sideEffectLeads(effect),
    })),
    symptoms: symptomRows.map((row) => ({
      name: row.name,
      count: row.occurrences,
      since: row.startedAt,
    })),
    conditions: conditions.value.map((condition) => ({
      conditionId: condition.id,
      name: condition.name,
      status: condition.status,
      recordedFrom: condition.recordedFrom,
    })),
    nowIso,
  });

  return ok({
    specialty,
    fromDayKey,
    toDayKey,
    conditions: orderSection(conditionRows, (row) => row.since),
    medications: orderSection(medicationRows, (row) => row.startedAt),
    labs: orderSection(labRows, (row) => row.collectedAt),
    symptoms: orderSection(symptomRows, (row) => row.startedAt),
    treatments: orderSection(treatmentRows, (row) => row.startedAt),
    questions: derived.questions,
    limitation: PACK_LIMITATION,
    generatedForDayKey: toDayKey,
  });
}

/**
 * The printed range, as text.
 *
 * A one-sided range is written as such rather than filled in — "< 5.0" is what
 * the report said, and inventing a lower bound of zero would be putting a number
 * on the page that no laboratory printed.
 */
function rangeTextOf(
  low: string | null,
  high: string | null,
  unit: string | null,
  printed: string | null = null,
): string | null {
  /* What the report literally printed wins over anything reconstructed from
   * bounds. "Not detected" is the range, and rendering "0–0" instead would be
   * this file inventing a numeric claim the laboratory did not make. */
  if (printed !== null && printed.trim() !== '') return printed;

  const suffix = unit === null || unit === '' ? '' : ` ${unit}`;
  if (low !== null && high !== null) return `${formatMeasured(low)}–${formatMeasured(high)}${suffix}`;
  if (high !== null) return `< ${formatMeasured(high)}${suffix}`;
  if (low !== null) return `> ${formatMeasured(low)}${suffix}`;
  return null;
}

export type { ConsultationPackDocument, PackSpecialty };

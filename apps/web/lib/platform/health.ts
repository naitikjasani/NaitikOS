/**
 * The Health service — §4.4's orchestration.
 *
 * ## Where the question list is assembled
 *
 * `deriveQuestions` is pure and takes five pre-fetched lists, which is what
 * keeps it testable without a database. This file is the other half: the five
 * queries, and the join between a lab result and the previous result for the
 * same analyte — which is the one piece of the evidence line that needs
 * history rather than the latest row.
 *
 * The adherence numbers come from the medication register that already exists.
 * That reuse is the point of §4.4's claim that Health "writes the authoritative
 * medication register consumed by Mind, Skin, and adherence detection across
 * the system": there is one adherence calculation in this codebase, and the
 * Consultation Pack reads it rather than reimplementing it.
 *
 * ## Why the overview is one call
 *
 * `/body/health` needs conditions, medications, the next appointment, the
 * latest vitals and the tracked analytes. Five round trips on a page load is
 * five chances to be slow; `Promise.all` over five independent reads is one.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  AdherenceHighlight,
  AnalyteDefinition,
  Appointment,
  AppointmentQuestion,
  Condition,
  DerivedQuestions,
  DomainError,
  EffectiveFlag,
  Hlc,
  LabFlag,
  LabHighlight,
  Medication,
  MetricRegistry,
  RangeShift,
  SideEffect,
  Symptom,
  VitalReading,
} from '@naitikos/core';
import {
  analyteBySlug,
  currentConditions,
  deriveQuestions,
  describeRange,
  effectiveFlag,
  formatMeasured,
  dayKeyInZone,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  labMetricKey,
  medicationLabel,
  nextAppointment,
  pairReadings,
  rangeShifts,
  symptomFrequency,
  systemClock,
  unreported,
  windowAdherence,
  windowDayKeys,
} from '@naitikos/core';
import type { Database, LabPanelRow, LabResultRow } from '@naitikos/db';
import {
  createHealthRepository,
  createLabRepository,
  createMedicationRepository,
  createMetricRepository,
} from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

/** How far back the overview and the question derivation look. */
export const HEALTH_WINDOW_DAYS = 90;
/** The adherence window quoted in a consultation question. */
export const ADHERENCE_WINDOW_DAYS = 30;

function writeContext(registry: MetricRegistry, envelope: OfflineEnvelope, newId: () => string) {
  const physicalMillis = systemClock.nowMillis();
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  const state =
    envelope.clientHlc === undefined ? seed : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis).state;

  return {
    registry,
    hlcState: state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId,
  };
}

function windowStart(days: number): string {
  return isoFromMillis(systemClock.nowMillis() - days * 86_400_000);
}

/* -------------------------------------------------------------------------
 * The overview
 * ---------------------------------------------------------------------- */

export type AnalyteSummary = {
  readonly slug: string;
  readonly displayName: string;
  readonly latestValue: string | null;
  readonly unit: string | null;
  readonly flag: LabFlag | null;
  readonly flagSource: EffectiveFlag['source'];
  readonly collectedAt: string | null;
  readonly resultCount: number;
};

export type HealthOverview = {
  readonly conditions: readonly Condition[];
  readonly medications: readonly Medication[];
  readonly nextAppointment: Appointment | null;
  readonly latestVitals: VitalReading | null;
  readonly analytes: readonly AnalyteSummary[];
  readonly unreportedSideEffects: readonly SideEffect[];
  readonly openSymptomCount: number;
};

export async function loadHealthOverview(db: Database): Promise<Result<HealthOverview, DomainError>> {
  const health = createHealthRepository(db);
  const labs = createLabRepository(db);
  const medications = createMedicationRepository(db);

  const from = windowStart(HEALTH_WINDOW_DAYS);
  const until = isoFromMillis(systemClock.nowMillis() + 86_400_000);

  const [conditions, active, appointments, vitals, tracked, sideEffects, symptoms] = await Promise.all([
    health.conditions(),
    medications.active(),
    health.appointments(),
    health.vitalsBetween(from, until),
    labs.trackedAnalytes(),
    health.sideEffects(),
    health.symptomsBetween(from, until),
  ]);

  for (const result of [conditions, active, appointments, vitals, tracked, sideEffects, symptoms]) {
    if (!result.ok) return result;
  }
  if (!conditions.ok || !active.ok || !appointments.ok || !vitals.ok || !tracked.ok || !sideEffects.ok || !symptoms.ok) {
    return conditions as Result<never, DomainError>;
  }

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const readings = pairReadings(vitals.value);

  const analytes = await Promise.all(
    tracked.value.map(async (entry) => summariseAnalyte(labs, entry.slug, entry.count)),
  );

  return ok({
    conditions: currentConditions(conditions.value, nowIso),
    medications: active.value,
    nextAppointment: nextAppointment(appointments.value, nowIso),
    latestVitals: readings[0] ?? null,
    analytes: analytes.filter((entry): entry is AnalyteSummary => entry !== null),
    unreportedSideEffects: unreported(sideEffects.value),
    openSymptomCount: symptoms.value.filter((symptom) => symptom.endedAt === null).length,
  });
}

async function summariseAnalyte(
  labs: ReturnType<typeof createLabRepository>,
  slug: string,
  count: number,
): Promise<AnalyteSummary | null> {
  const definition = analyteBySlug(slug);
  const results = await labs.resultsForAnalyte(slug);
  if (!results.ok) return null;

  const latest = results.value.at(-1);
  if (latest === undefined) return null;

  const flag = effectiveFlag(latest.flag, latest.value, {
    low: latest.referenceLow,
    high: latest.referenceHigh,
    text: latest.referenceText,
    unit: latest.unit,
  });

  return {
    slug,
    /* An uncatalogued analyte keeps the name the report printed. It has a row
     * and no metric, so the display name is all there is — and that is exactly
     * what the operator will recognise. */
    displayName: definition?.displayName ?? slug,
    latestValue: latest.value === null ? null : formatMeasured(latest.value),
    unit: latest.unit,
    flag: flag.flag,
    flagSource: flag.source,
    collectedAt: latest.collectedAt,
    resultCount: count,
  };
}

/* -------------------------------------------------------------------------
 * One analyte's history
 * ---------------------------------------------------------------------- */

export type AnalytePoint = {
  readonly resultId: string;
  readonly collectedAt: string | null;
  readonly value: string | null;
  readonly unit: string | null;
  readonly rangeText: string;
  readonly flag: LabFlag | null;
  readonly flagSource: EffectiveFlag['source'];
  readonly panelId: string;
};

export type AnalyteHistory = {
  readonly definition: AnalyteDefinition | null;
  readonly slug: string;
  readonly displayName: string;
  readonly points: readonly AnalytePoint[];
  /** Empty unless the printed range actually changed between reports. */
  readonly shifts: readonly RangeShift[];
};

export async function loadAnalyteHistory(db: Database, slug: string): Promise<Result<AnalyteHistory, DomainError>> {
  const labs = createLabRepository(db);
  const results = await labs.resultsForAnalyte(slug);
  if (!results.ok) return results;

  const definition = analyteBySlug(slug);

  return ok({
    definition,
    slug,
    displayName: definition?.displayName ?? slug,
    points: results.value.map((result) => {
      const flag = effectiveFlag(result.flag, result.value, {
        low: result.referenceLow,
        high: result.referenceHigh,
        text: result.referenceText,
        unit: result.unit,
      });
      return {
        resultId: result.id,
        collectedAt: result.collectedAt,
        value: result.value === null ? null : formatMeasured(result.value),
        unit: result.unit,
        rangeText: describeRange({
          low: result.referenceLow,
          high: result.referenceHigh,
          text: result.referenceText,
          unit: result.unit,
        }),
        flag: flag.flag,
        flagSource: flag.source,
        panelId: result.labPanelId,
      };
    }),
    shifts: rangeShifts(
      results.value.map((result) => ({
        panelId: result.labPanelId,
        collectedAt: result.collectedAt,
        low: result.referenceLow,
        high: result.referenceHigh,
        unit: result.unit,
      })),
    ),
  });
}

/* -------------------------------------------------------------------------
 * The question list — P5's deliverable
 * ---------------------------------------------------------------------- */

export type AppointmentPreparation = {
  readonly appointment: Appointment;
  readonly saved: readonly AppointmentQuestion[];
  readonly derived: DerivedQuestions;
};

export async function loadAppointmentPreparation(
  db: Database,
  appointmentId: string,
  zone: string,
): Promise<Result<AppointmentPreparation | null, DomainError>> {
  const health = createHealthRepository(db);
  const labs = createLabRepository(db);
  const medications = createMedicationRepository(db);

  const found = await health.appointmentById(appointmentId);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const from = windowStart(HEALTH_WINDOW_DAYS);
  const adherenceFrom = windowStart(ADHERENCE_WINDOW_DAYS);

  const [conditions, sideEffects, symptoms, tracked, active, schedules, events] = await Promise.all([
    health.conditions(),
    health.sideEffects(),
    health.symptomsBetween(from, nowIso),
    labs.trackedAnalytes(),
    medications.active(),
    medications.schedules(),
    medications.eventsBetween(adherenceFrom, nowIso),
  ]);

  if (!conditions.ok) return conditions;
  if (!sideEffects.ok) return sideEffects;
  if (!symptoms.ok) return symptoms;
  if (!tracked.ok) return tracked;
  if (!active.ok) return active;
  if (!schedules.ok) return schedules;
  if (!events.ok) return events;

  const labHighlights: LabHighlight[] = [];
  for (const entry of tracked.value) {
    const results = await labs.resultsForAnalyte(entry.slug);
    if (!results.ok) return results;
    const highlight = toHighlight(entry.slug, results.value);
    if (highlight !== null) labHighlights.push(highlight);
  }

  /*
   * The doses, not the days.
   *
   * `windowAdherence` counts doses expected across *recorded* days only — a day
   * with no record is unknown, never a miss (§4.7). Carrying that denominator
   * straight into the question is what makes the evidence line honest: "22 of
   * the last 30" would be a different, worse claim.
   */
  const dayKeys = windowDayKeys(dayKeyInZone(nowIso, zone), ADHERENCE_WINDOW_DAYS);
  const adherence: AdherenceHighlight[] = active.value.map((medication) => {
    const window = windowAdherence(
      medication,
      schedules.value.filter((schedule) => schedule.medicationId === medication.id),
      events.value.filter((event) => event.medicationId === medication.id),
      dayKeys,
      zone,
    );
    return {
      medicationId: medication.id,
      label: window.label,
      daysTaken: window.dosesTaken,
      daysExpected: window.dosesExpected,
      windowDays: ADHERENCE_WINDOW_DAYS,
    };
  });

  const derived = deriveQuestions({
    labs: labHighlights,
    adherence,
    sideEffects: sideEffects.value.map((effect) => ({
      sideEffectId: effect.id,
      effect: effect.effect,
      medicationLabel: labelFor(active.value, effect.suspectedMedicationId),
      onsetAt: effect.onsetAt,
      reportedToPrescriber: effect.reportedToPrescriber,
    })),
    symptoms: symptomFrequency(symptoms.value).map((entry) => ({
      name: entry.name,
      count: entry.count,
      since: earliestStart(symptoms.value, entry.name),
    })),
    conditions: conditions.value.map((condition) => ({
      conditionId: condition.id,
      name: condition.name,
      status: condition.status,
      recordedFrom: condition.recordedFrom,
    })),
    nowIso,
  });

  return ok({ appointment: found.value, saved: found.value.preVisitQuestions, derived });
}

/**
 * The most recent result for an analyte, with the one before it.
 *
 * Only the latest is offered as a question — an out-of-range result from
 * eighteen months ago that has since been corrected is not a question, it is
 * history, and putting it on a printed list wastes the minutes the list exists
 * to protect.
 */
function toHighlight(
  slug: string,
  results: readonly (LabResultRow & { readonly collectedAt: string | null })[],
): LabHighlight | null {
  const latest = results.at(-1);
  if (latest === undefined) return null;

  const previous = results.at(-2) ?? null;
  const flag = effectiveFlag(latest.flag, latest.value, {
    low: latest.referenceLow,
    high: latest.referenceHigh,
    text: latest.referenceText,
    unit: latest.unit,
  });

  return {
    resultId: latest.id,
    analyte: analyteBySlug(slug)?.displayName ?? slug,
    value: latest.value === null ? '' : formatMeasured(latest.value),
    unit: latest.unit,
    flag: flag.flag,
    flagSource: flag.source,
    rangeText: describeRange({
      low: latest.referenceLow,
      high: latest.referenceHigh,
      text: latest.referenceText,
      unit: latest.unit,
    }),
    collectedAt: latest.collectedAt,
    previous:
      previous === null
        ? null
        : { value: previous.value === null ? '' : formatMeasured(previous.value), collectedAt: previous.collectedAt },
  };
}

function labelFor(medications: readonly Medication[], id: string | null): string | null {
  if (id === null) return null;
  const found = medications.find((medication) => medication.id === id);
  return found === undefined ? null : medicationLabel(found);
}

function earliestStart(symptoms: readonly Symptom[], name: string): string | null {
  const key = name.trim().toLowerCase();
  const starts = symptoms
    .filter((symptom) => symptom.name.trim().toLowerCase() === key && symptom.startedAt !== null)
    .map((symptom) => symptom.startedAt as string)
    .sort();
  return starts[0] ?? null;
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export async function loadMetricRegistry(db: Database): Promise<Result<MetricRegistry, DomainError>> {
  return createMetricRepository(db).registry();
}

export function healthWriteContext(registry: MetricRegistry, envelope: OfflineEnvelope) {
  return writeContext(registry, envelope, () => crypto.randomUUID());
}

/** Kept beside the panel loader so both spell the metric key the same way. */
export function metricKeyForAnalyte(slug: string): string {
  return labMetricKey(slug);
}

/** Re-exported so route handlers do not each import the repository factory. */
export { createHealthRepository, createLabRepository };
export type { LabPanelRow };

/**
 * Vitals — §4.4's first feature, and the simplest thing in Health core.
 *
 * ## A blood pressure is one reading with two numbers
 *
 * §9.2 only makes something an entity when it has internal structure, and a
 * vital sign has none: it is a number at a moment. So vitals are plain
 * observations, with no `vital` table.
 *
 * That creates exactly one problem, and it is the whole of this module.
 * Systolic and diastolic are two metrics — different bounds, different axes —
 * but 118/76 is *one* measurement, and storing them as two unrelated
 * observations loses the pairing. Six weeks later "was that 118 taken with the
 * 76 or with the 92?" has no answer, and the pair is the clinically meaningful
 * object.
 *
 * The fix is the subject reference §9.3(3) already provides: every observation
 * in one reading shares `subject = { type: 'vital_reading', id }`, so the pair
 * reassembles with a group-by and nothing new in the schema.
 *
 * ## This module does not classify a blood pressure
 *
 * There are published thresholds. They differ between guidelines, they depend
 * on measurement conditions this system does not capture (rested, seated, arm
 * supported, cuff size, one reading or the average of three), and applying them
 * would put the word "hypertensive" on a screen on the authority of a phone.
 *
 * P5: "the deliverable of a medical insight is a better question for your next
 * appointment". A number and its trend is that question. A category is an
 * answer, and this system is not entitled to it.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';
import type { ObservationInput } from '../../observations/observation';

export const VITAL_METRICS = Object.freeze({
  systolic: 'body.vitals.bp_systolic',
  diastolic: 'body.vitals.bp_diastolic',
  restingHeartRate: 'body.vitals.heart_rate_resting',
  temperature: 'body.vitals.temperature',
  oxygenSaturation: 'body.vitals.spo2',
});

/** What binds the two halves of a blood pressure together. */
export const VITAL_READING_SUBJECT_TYPE = 'vital_reading';

export type VitalKind = keyof typeof VITAL_METRICS;

export const VITAL_LABELS: Readonly<Record<VitalKind, string>> = Object.freeze({
  systolic: 'Systolic',
  diastolic: 'Diastolic',
  restingHeartRate: 'Resting heart rate',
  temperature: 'Temperature',
  oxygenSaturation: 'Oxygen saturation',
});

export type VitalReadingInput = {
  /** Client-generated UUIDv7, so the reading has its identity offline (§5.7). */
  readonly id: string;
  readonly observedAt: string;
  readonly observedZone: string;
  readonly systolic?: number | null;
  readonly diastolic?: number | null;
  readonly restingHeartRate?: number | null;
  /** Degrees Celsius. Decimal string, because 36.8 is not an integer. */
  readonly temperatureCelsius?: string | null;
  readonly oxygenSaturation?: number | null;
};

/**
 * Turn a reading into observations.
 *
 * Fails on an empty reading and on a half-entered blood pressure. The second
 * is the one worth having: a systolic with no diastolic is a slip of the
 * keyboard, and admitting it would write a number that plots on a chart with
 * no partner and no way to tell it apart from a real one later.
 */
export function planVitalReading(input: VitalReadingInput): Result<readonly ObservationInput[], DomainError> {
  if (parseInstant(input.observedAt) === null) {
    return err(validationError('vital_observed_at_invalid', 'observedAt must be an ISO-8601 instant.'));
  }
  if (!isIanaZone(input.observedZone)) {
    return err(validationError('vital_zone_invalid', 'observedZone must be an IANA zone name (§5.3).'));
  }

  const hasSystolic = input.systolic !== undefined && input.systolic !== null;
  const hasDiastolic = input.diastolic !== undefined && input.diastolic !== null;
  if (hasSystolic !== hasDiastolic) {
    return err(
      validationError(
        'vital_blood_pressure_incomplete',
        'A blood pressure needs both numbers. One without the other is a slip, not a reading.',
      ),
    );
  }

  const observations: ObservationInput[] = [];
  const subject = { type: VITAL_READING_SUBJECT_TYPE, id: input.id } as const;
  const base = { observedAt: input.observedAt, observedZone: input.observedZone, subject } as const;

  if (hasSystolic && hasDiastolic) {
    const systolic = input.systolic as number;
    const diastolic = input.diastolic as number;
    /*
     * Diastolic below systolic is arithmetic, not clinical judgement — the
     * pressure between beats cannot exceed the pressure during one, and a
     * reading where it does is a transposed pair. Rejecting it here is the
     * difference between catching the typo now and explaining a chart in 2031.
     */
    if (diastolic >= systolic) {
      return err(
        validationError(
          'vital_blood_pressure_transposed',
          'Diastolic is not below systolic — the two numbers look transposed.',
        ),
      );
    }
    observations.push(
      { ...base, metricKey: VITAL_METRICS.systolic, value: { kind: 'integer', value: systolic } },
      { ...base, metricKey: VITAL_METRICS.diastolic, value: { kind: 'integer', value: diastolic } },
    );
  }

  if (input.restingHeartRate !== undefined && input.restingHeartRate !== null) {
    observations.push({
      ...base,
      metricKey: VITAL_METRICS.restingHeartRate,
      value: { kind: 'integer', value: input.restingHeartRate },
    });
  }

  if (input.temperatureCelsius !== undefined && input.temperatureCelsius !== null) {
    observations.push({
      ...base,
      metricKey: VITAL_METRICS.temperature,
      value: { kind: 'number', value: input.temperatureCelsius, unit: 'celsius' },
    });
  }

  if (input.oxygenSaturation !== undefined && input.oxygenSaturation !== null) {
    observations.push({
      ...base,
      metricKey: VITAL_METRICS.oxygenSaturation,
      value: { kind: 'integer', value: input.oxygenSaturation },
    });
  }

  if (observations.length === 0) {
    return err(validationError('vital_reading_empty', 'A reading with no measurements in it.'));
  }

  return ok(observations);
}

/* -------------------------------------------------------------------------
 * Reassembly
 * ---------------------------------------------------------------------- */

/** The shape a read returns: one observation, flattened. */
export type VitalObservation = {
  readonly metricKey: string;
  readonly value: string;
  readonly observedAt: string;
  readonly subjectId: string | null;
};

export type VitalReading = {
  readonly id: string;
  readonly observedAt: string;
  readonly systolic: string | null;
  readonly diastolic: string | null;
  readonly restingHeartRate: string | null;
  readonly temperatureCelsius: string | null;
  readonly oxygenSaturation: string | null;
};

/**
 * Group observations back into readings, most recent first.
 *
 * Observations with no subject are dropped rather than given a synthetic
 * reading of their own. Every writer here sets one, so a missing subject means
 * the row came from somewhere this function does not understand, and inventing
 * a reading id for it would put a fabricated identity in front of the operator.
 */
export function pairReadings(observations: readonly VitalObservation[]): readonly VitalReading[] {
  const byReading = new Map<string, { observedAt: string; values: Map<string, string> }>();

  for (const row of observations) {
    if (row.subjectId === null) continue;
    const existing = byReading.get(row.subjectId);
    if (existing === undefined) {
      byReading.set(row.subjectId, { observedAt: row.observedAt, values: new Map([[row.metricKey, row.value]]) });
    } else {
      existing.values.set(row.metricKey, row.value);
      if (row.observedAt < existing.observedAt) existing.observedAt = row.observedAt;
    }
  }

  return [...byReading.entries()]
    .map(([id, entry]) => ({
      id,
      observedAt: entry.observedAt,
      systolic: entry.values.get(VITAL_METRICS.systolic) ?? null,
      diastolic: entry.values.get(VITAL_METRICS.diastolic) ?? null,
      restingHeartRate: entry.values.get(VITAL_METRICS.restingHeartRate) ?? null,
      temperatureCelsius: entry.values.get(VITAL_METRICS.temperature) ?? null,
      oxygenSaturation: entry.values.get(VITAL_METRICS.oxygenSaturation) ?? null,
    }))
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
}

/** `118/76`, or `null` when the pair is incomplete. */
export function formatBloodPressure(reading: VitalReading): string | null {
  if (reading.systolic === null || reading.diastolic === null) return null;
  return `${trimZeros(reading.systolic)}/${trimZeros(reading.diastolic)}`;
}

function trimZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/u, '');
}

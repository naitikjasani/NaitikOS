import { describe, expect, it } from 'vitest';

import { formatBloodPressure, pairReadings, planVitalReading, VITAL_METRICS } from './vitals';

const BASE = {
  id: '0192f000-0000-7000-8000-000000000001',
  observedAt: '2026-10-04T07:30:00.000Z',
  observedZone: 'Asia/Kolkata',
} as const;

describe('planning a vital reading', () => {
  it('writes both halves of a blood pressure against one subject', () => {
    const result = planVitalReading({ ...BASE, systolic: 118, diastolic: 76 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const subjects = new Set(result.value.map((observation) => observation.subject?.id));
    expect(subjects).toEqual(new Set([BASE.id]));
    expect(result.value.map((o) => o.metricKey)).toEqual([VITAL_METRICS.systolic, VITAL_METRICS.diastolic]);
  });

  /**
   * A systolic with no diastolic is a keyboard slip. Admitting it writes a
   * number that plots on a chart with no partner and no way, later, to tell it
   * apart from a real one.
   */
  it('refuses half a blood pressure', () => {
    const result = planVitalReading({ ...BASE, systolic: 118 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('vital_blood_pressure_incomplete');
  });

  it('refuses a transposed pair, which is arithmetic and not clinical judgement', () => {
    const result = planVitalReading({ ...BASE, systolic: 76, diastolic: 118 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('vital_blood_pressure_transposed');
  });

  it('accepts the other vitals independently, and sends temperature with its unit', () => {
    const result = planVitalReading({
      ...BASE,
      restingHeartRate: 58,
      temperatureCelsius: '36.8',
      oxygenSaturation: 98,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);

    const temperature = result.value.find((o) => o.metricKey === VITAL_METRICS.temperature);
    expect(temperature?.value).toEqual({ kind: 'number', value: '36.8', unit: 'celsius' });
  });

  it('rejects an empty reading and a bad zone', () => {
    expect(planVitalReading(BASE).ok).toBe(false);
    const zone = planVitalReading({ ...BASE, observedZone: 'Mars/Olympus', restingHeartRate: 60 });
    expect(zone.ok).toBe(false);
    if (zone.ok) return;
    expect(zone.error.code).toBe('vital_zone_invalid');
  });
});

describe('reassembling readings', () => {
  const observation = (metricKey: string, value: string, subjectId: string | null, observedAt: string) => ({
    metricKey,
    value,
    observedAt,
    subjectId,
  });

  it('groups by subject and orders most recent first', () => {
    const readings = pairReadings([
      observation(VITAL_METRICS.systolic, '118', 'r1', '2026-10-01T07:00:00.000Z'),
      observation(VITAL_METRICS.diastolic, '76', 'r1', '2026-10-01T07:00:00.000Z'),
      observation(VITAL_METRICS.systolic, '124', 'r2', '2026-10-04T07:00:00.000Z'),
      observation(VITAL_METRICS.diastolic, '80', 'r2', '2026-10-04T07:00:00.000Z'),
    ]);

    expect(readings.map((reading) => reading.id)).toEqual(['r2', 'r1']);
    expect(formatBloodPressure(readings[0] as (typeof readings)[number])).toBe('124/80');
    expect(formatBloodPressure(readings[1] as (typeof readings)[number])).toBe('118/76');
  });

  /**
   * A synthetic reading id would put a fabricated identity in front of the
   * operator. Every writer here sets a subject, so a row without one came from
   * somewhere this function does not understand.
   */
  it('drops observations with no subject rather than inventing one', () => {
    expect(pairReadings([observation(VITAL_METRICS.restingHeartRate, '60', null, '2026-10-01T07:00:00.000Z')])).toEqual(
      [],
    );
  });

  it('returns null for an incomplete pair instead of half a blood pressure', () => {
    const readings = pairReadings([observation(VITAL_METRICS.systolic, '118', 'r1', '2026-10-01T07:00:00.000Z')]);
    expect(formatBloodPressure(readings[0] as (typeof readings)[number])).toBeNull();
  });
});

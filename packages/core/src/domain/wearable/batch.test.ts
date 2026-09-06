import { describe, expect, it } from 'vitest';

import { createMetricRegistry } from '../../observations/metric';
import { HEALTH_METRICS } from '../health/metrics';
import { VITAL_METRICS } from '../health/vitals';
import { MAX_REPORTED_REJECTIONS, normaliseBatch, skippedTotal } from './batch';
import type { RawSample } from './batch';
import { WEARABLE_METRICS, WEARABLE_METRIC_DEFINITIONS } from './metrics';

/** The real vocabulary, not a stub — the bounds under test are the seeded ones. */
const registry = createMetricRegistry([...WEARABLE_METRIC_DEFINITIONS, ...HEALTH_METRICS]);

let counter = 0;
const options = {
  platform: 'apple_health',
  registry,
  fallbackZone: 'Asia/Kolkata',
  newId: () => `id-${String(++counter)}`,
} as const;

function raw(over: Partial<RawSample> = {}): RawSample {
  return {
    identifier: 'HKQuantityTypeIdentifierHeartRate',
    value: 62,
    unit: 'count/min',
    observedAt: '2026-09-06T04:30:00Z',
    ...over,
  };
}

describe('normaliseBatch', () => {
  it('maps a platform identifier onto a registered metric', () => {
    const batch = normaliseBatch([raw()], options);

    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]?.metricKey).toBe(WEARABLE_METRICS.heartRate);
    expect(batch.rows[0]?.value).toBe('62.000000');
    expect(batch.rows[0]?.unit).toBe('bpm');
  });

  it('converts into the canonical unit rather than storing what arrived', () => {
    const batch = normaliseBatch(
      [raw({ identifier: 'HKQuantityTypeIdentifierDistanceWalkingRunning', value: 1500, unit: 'm' })],
      options,
    );

    // 1500 m is 1.5 km, and the metric is registered in km.
    expect(batch.rows[0]?.value).toBe('1.500000');
    expect(batch.rows[0]?.unit).toBe('km');
  });

  it('never emits exponential notation, which numeric(20,6) would refuse', () => {
    const batch = normaliseBatch(
      [raw({ identifier: 'HKQuantityTypeIdentifierDistanceWalkingRunning', value: 0.0001, unit: 'm' })],
      options,
    );

    // String(1e-7) is "1e-7". The column takes decimals, not JS notation.
    expect(batch.rows[0]?.value).toBe('0.000000');
    expect(batch.rows[0]?.value).not.toContain('e');
  });

  it('skips an identifier this system has no metric for, without failing', () => {
    const batch = normaliseBatch(
      [raw(), raw({ identifier: 'HKQuantityTypeIdentifierAppleWalkingSteadiness' }), raw({ identifier: 'HKQuantityTypeIdentifierAppleWalkingSteadiness' })],
      options,
    );

    expect(batch.rows).toHaveLength(1);
    expect(batch.skipped['HKQuantityTypeIdentifierAppleWalkingSteadiness']).toBe(2);
    expect(batch.rejected).toEqual([]);
    expect(skippedTotal(batch)).toBe(2);
  });

  it('rejects a known metric arriving in an unknown unit', () => {
    // The asymmetry that matters: an unknown *metric* is skipped, an unknown
    // *unit* on a metric we understand is refused. Storing pounds in a column
    // that means kilograms is the failure this whole file exists to prevent.
    const batch = normaliseBatch([raw({ unit: 'furlongs/fortnight' })], options);

    expect(batch.rows).toEqual([]);
    expect(batch.rejected[0]?.reason).toContain('furlongs/fortnight');
    expect(batch.rejected[0]?.reason).toContain('count/min');
  });

  it('rejects a timestamp with no offset rather than guessing local time', () => {
    const batch = normaliseBatch([raw({ observedAt: '2026-09-06 10:00:00' })], options);

    expect(batch.rows).toEqual([]);
    expect(batch.rejected[0]?.reason).toContain('no UTC offset');
  });

  it('accepts an offset that is not Z, and stores the instant it names', () => {
    const batch = normaliseBatch([raw({ observedAt: '2026-09-06T10:00:00+05:30' })], options);

    expect(batch.rows[0]?.observedAt).toBe('2026-09-06T04:30:00.000Z');
  });

  it('rejects a reading outside the registered bounds', () => {
    // A wrist sensor reports nonsense during motion. 400 bpm is the sensor
    // being confused, not the heart doing something interesting.
    const batch = normaliseBatch([raw({ value: 400 })], options);

    expect(batch.rows).toEqual([]);
    expect(batch.rejected[0]?.reason).toContain('outside the registered range');
  });

  it('rounds an integer metric before checking its bounds', () => {
    const batch = normaliseBatch(
      [raw({ identifier: 'HKQuantityTypeIdentifierStepCount', value: 12.6, unit: 'count' })],
      options,
    );

    expect(batch.rows[0]?.value).toBe('13.000000');
  });

  it('rejects a non-finite value', () => {
    const batch = normaliseBatch([raw({ value: Number.NaN })], options);

    expect(batch.rows).toEqual([]);
    expect(batch.rejected[0]?.reason).toContain('finite');
  });

  it('drops a duplicate instant within the batch', () => {
    // Postgres cannot resolve a conflict against a row in the same statement,
    // so this pass is what makes the insert's ON CONFLICT survivable.
    const batch = normaliseBatch([raw(), raw()], options);

    expect(batch.rows).toHaveLength(1);
    expect(batch.duplicates).toBe(1);
  });

  it('treats two identifiers mapping to one metric as a duplicate', () => {
    // Keyed by metric and instant, not identifier and instant — the unique
    // index is on the metric, so anything else would fail at insert.
    const batch = normaliseBatch(
      [
        raw({ identifier: 'HKQuantityTypeIdentifierHeartRate', unit: 'count/min' }),
        raw({ identifier: 'HKQuantityTypeIdentifierHeartRate', unit: 'bpm' }),
      ],
      options,
    );

    expect(batch.rows).toHaveLength(1);
    expect(batch.duplicates).toBe(1);
  });

  it('takes the row zone when it has one and the profile zone otherwise', () => {
    const batch = normaliseBatch(
      [raw(), raw({ observedAt: '2026-09-06T05:30:00Z', observedZone: 'Europe/London' })],
      options,
    );

    expect(batch.rows[0]?.observedZone).toBe('Asia/Kolkata');
    expect(batch.rows[1]?.observedZone).toBe('Europe/London');
  });

  it('maps blood oxygen onto the vital rather than inventing a second metric', () => {
    // Apple reports a fraction; the vital is registered as a percentage.
    const batch = normaliseBatch(
      [raw({ identifier: 'HKQuantityTypeIdentifierOxygenSaturation', value: 0.97, unit: 'count' })],
      options,
    );

    expect(batch.rows[0]?.metricKey).toBe(VITAL_METRICS.oxygenSaturation);
    expect(batch.rows[0]?.value).toBe('97.000000');
  });

  it('reads Google Fit identifiers under the Google platform and not under Apple', () => {
    const asGoogle = normaliseBatch(
      [raw({ identifier: 'com.google.step_count.delta', value: 120, unit: 'count' })],
      { ...options, platform: 'google_fit' },
    );
    const asApple = normaliseBatch(
      [raw({ identifier: 'com.google.step_count.delta', value: 120, unit: 'count' })],
      options,
    );

    expect(asGoogle.rows).toHaveLength(1);
    expect(asApple.rows).toEqual([]);
    expect(asApple.skipped['com.google.step_count.delta']).toBe(1);
  });

  it('caps described rejections but keeps counting them', () => {
    const many = Array.from({ length: MAX_REPORTED_REJECTIONS + 20 }, (_unused, index) =>
      raw({ value: 400, observedAt: `2026-09-06T04:${String(index).padStart(2, '0')}:00Z` }),
    );

    const batch = normaliseBatch(many, options);

    expect(batch.rejected).toHaveLength(MAX_REPORTED_REJECTIONS);
    expect(batch.rejectedTotal).toBe(MAX_REPORTED_REJECTIONS + 20);
  });

  it('rejects rather than skips when a mapping names an unseeded metric', () => {
    // The failure mode this catches: a mapping added, the seed not re-run. A
    // foreign-key violation on insert would name a constraint, not a cause.
    const empty = createMetricRegistry([]);
    const batch = normaliseBatch([raw()], { ...options, registry: empty });

    expect(batch.rejected[0]?.reason).toContain('Run the seed');
  });

  it('returns an empty batch for empty input', () => {
    const batch = normaliseBatch([], options);

    expect(batch).toEqual({ rows: [], skipped: {}, rejected: [], duplicates: 0, rejectedTotal: 0 });
  });
});

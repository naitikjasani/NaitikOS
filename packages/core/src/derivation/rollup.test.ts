import { describe, expect, it } from 'vitest';

import type { MetricDefinition } from '../observations/metric';
import type { Observation } from '../observations/observation';
import { aggregate, dailyRollup } from './rollup';

function metric(overrides: Partial<MetricDefinition>): Pick<MetricDefinition, 'key' | 'aggregation'> {
  return {
    key: 'body.weight' as MetricDefinition['key'],
    aggregation: 'mean',
    ...overrides,
  } as Pick<MetricDefinition, 'key' | 'aggregation'>;
}

let sequence = 0;
function observation(overrides: Partial<Observation> = {}): Observation {
  sequence += 1;
  return {
    id: `obs-${String(sequence)}` as Observation['id'],
    metricKey: 'body.weight' as Observation['metricKey'],
    value: '74.000000',
    valueText: null,
    unit: 'kg',
    observedAt: '2026-08-17T02:30:00.000Z',
    observedZone: 'Asia/Kolkata',
    recordedAt: '2026-08-17T02:30:00.000Z',
    sourceId: 'src' as Observation['sourceId'],
    confidence: null,
    subjectType: null,
    subjectId: null,
    context: null,
    supersededById: null,
    supersededAt: null,
    supersedeReason: null,
    hlc: 'hlc' as Observation['hlc'],
    ...overrides,
  };
}

describe('aggregate', () => {
  it('applies each rule', () => {
    const values = [1, 2, 3, 4];
    expect(aggregate(values, 'sum')).toBe(10);
    expect(aggregate(values, 'mean')).toBe(2.5);
    expect(aggregate(values, 'median')).toBe(2.5);
    expect(aggregate([1, 2, 3], 'median')).toBe(2);
    expect(aggregate(values, 'last')).toBe(4);
    expect(aggregate(values, 'min')).toBe(1);
    expect(aggregate(values, 'max')).toBe(4);
    expect(aggregate(values, 'count')).toBe(4);
  });

  it('has nothing to say about nothing', () => {
    expect(aggregate([], 'mean')).toBeNull();
    expect(aggregate([], 'count')).toBeNull();
  });
});

describe('dailyRollup', () => {
  /**
   * §9.2's claim, made real: "Summing bodyweight over a week is nonsense and
   * averaging training volume hides a taper; the registry is what stops a chart
   * from doing either." The aggregation is not a parameter — it comes from the
   * metric.
   */
  it('takes the combining rule from the metric, not from the caller', () => {
    const readings = [observation({ value: '74' }), observation({ value: '76' })];

    expect(dailyRollup(readings, metric({ aggregation: 'mean' }))[0]?.value).toBe(75);
    expect(dailyRollup(readings, metric({ aggregation: 'sum' }))[0]?.value).toBe(150);
    expect(dailyRollup(readings, metric({ aggregation: 'max' }))[0]?.value).toBe(76);
  });

  /**
   * §5.3: "a workout at 7am during travel is a materially different fact from
   * one at 7am at home." 02:30 UTC is 08:00 in Kolkata — the same day — and
   * 03:30 in London, which is also the same day but arrived at differently.
   * The zone stored on the observation decides, not the reader's.
   */
  it('files each observation under the day it happened in its own zone', () => {
    // 20:00 UTC on the 17th is 01:30 on the 18th in Kolkata.
    const evening = observation({ observedAt: '2026-08-17T20:00:00.000Z', observedZone: 'Asia/Kolkata' });
    expect(dailyRollup([evening], metric({}))[0]?.dayKey).toBe('2026-08-18');

    const london = observation({ observedAt: '2026-08-17T20:00:00.000Z', observedZone: 'Europe/London' });
    expect(dailyRollup([london], metric({}))[0]?.dayKey).toBe('2026-08-17');
  });

  it('can be forced into a single frame, for a travel comparison', () => {
    const evening = observation({ observedAt: '2026-08-17T20:00:00.000Z', observedZone: 'Asia/Kolkata' });
    expect(dailyRollup([evening], metric({}), { zone: 'Europe/London' })[0]?.dayKey).toBe('2026-08-17');
  });

  it('ignores observations of other metrics', () => {
    const mixed = [
      observation({ value: '74' }),
      observation({ metricKey: 'mind.mood' as Observation['metricKey'], value: '4' }),
    ];
    expect(dailyRollup(mixed, metric({}))).toEqual([{ dayKey: '2026-08-17', value: 74 }]);
  });

  it('orders by day, and orders within a day so `last` means last', () => {
    const readings = [
      observation({ observedAt: '2026-08-17T10:00:00.000Z', value: '76' }),
      observation({ observedAt: '2026-08-17T02:00:00.000Z', value: '74' }),
      observation({ observedAt: '2026-08-16T02:00:00.000Z', value: '73' }),
    ];
    const rolled = dailyRollup(readings, metric({ aggregation: 'last' }));
    expect(rolled.map((point) => point.dayKey)).toEqual(['2026-08-16', '2026-08-17']);
    expect(rolled[1]?.value).toBe(76);
  });

  it('drops an unparseable value rather than poisoning the day with NaN', () => {
    const readings = [observation({ value: 'heavy' }), observation({ value: '74' })];
    expect(dailyRollup(readings, metric({}))[0]?.value).toBe(74);
  });
});

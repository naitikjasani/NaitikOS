import { describe, expect, it } from 'vitest';

import { WEARABLE_METRIC_DEFINITIONS } from './metrics';
import {
  SAMPLE_RETENTION_DAYS,
  aggregateFor,
  downsampleCutoff,
  downsampleableAggregations,
  hourBucket,
} from './downsample';

describe('downsampleCutoff', () => {
  it('is ninety days back, per §9.7', () => {
    expect(downsampleCutoff('2026-09-06T03:00:00Z')).toBe('2026-06-08T03:00:00.000Z');
    expect(SAMPLE_RETENTION_DAYS).toBe(90);
  });

  it('truncates to the hour, so a re-run collapses the same set', () => {
    // §5.2 requires the nightly run be idempotent. A cutoff carrying minutes
    // would split one hour across two runs, and the second would overwrite a
    // complete aggregate with a partial one.
    const onTheHour = downsampleCutoff('2026-09-06T03:00:00Z');
    const fortySevenMinutesLater = downsampleCutoff('2026-09-06T03:47:19.412Z');

    expect(fortySevenMinutesLater).toBe(onTheHour);
  });

  it('honours a shorter retention when one is passed', () => {
    expect(downsampleCutoff('2026-09-06T03:00:00Z', 1)).toBe('2026-09-05T03:00:00.000Z');
  });

  it('refuses an input that is not an instant', () => {
    expect(() => downsampleCutoff('yesterday')).toThrow(/instant/);
  });
});

describe('hourBucket', () => {
  it('floors to the hour in UTC', () => {
    expect(hourBucket('2026-09-06T04:59:59.999Z')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('puts a half-hour offset into the hour the instant actually falls in', () => {
    // 10:15 in Asia/Kolkata is 04:45 UTC, so the bucket is 04:00 — not 10:00.
    // Hours are the same sixty minutes everywhere, which is exactly why this
    // bucketing is done in UTC while day bucketing is not.
    expect(hourBucket('2026-09-06T10:15:00+05:30')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('refuses an input that is not an instant', () => {
    expect(() => hourBucket('2026-09-06')).not.toThrow();
    expect(() => hourBucket('not a time')).toThrow(/instant/);
  });
});

describe('aggregateFor', () => {
  it('translates the domain vocabulary into SQL aggregate names', () => {
    expect(aggregateFor('mean')).toBe('avg');
    expect(aggregateFor('sum')).toBe('sum');
    expect(aggregateFor('min')).toBe('min');
    expect(aggregateFor('max')).toBe('max');
  });

  it('refuses to collapse the three that have no honest hourly form', () => {
    // `last` would keep one arbitrary reading per hour and call it an
    // aggregate; `count` counts firmware behaviour; `median` has no cheap
    // GROUP BY form. A metric that maps to null keeps its raw rows, which is
    // the safe direction: the table grows, and growth is visible.
    expect(aggregateFor('last')).toBeNull();
    expect(aggregateFor('count')).toBeNull();
    expect(aggregateFor('median')).toBeNull();
  });

  it('lists only the collapsible aggregations', () => {
    expect([...downsampleableAggregations()].sort()).toEqual(['max', 'mean', 'min', 'sum']);
  });
});

describe('the wearable vocabulary against the retention policy', () => {
  it('registers every device stream with an aggregation that survives a collapse', () => {
    // The guarantee this test exists for: a wearable metric registered as
    // `last` would silently keep its raw rows forever, and §9.7's whole
    // argument for a separate table is that this one stays bounded. Naming the
    // offenders rather than counting them, so a failure says which.
    const uncollapsible = WEARABLE_METRIC_DEFINITIONS.filter(
      (definition) => aggregateFor(definition.aggregation) === null,
    ).map((definition) => definition.key);

    expect(uncollapsible).toEqual([]);
  });

  it('sums the cumulative streams and averages the instantaneous ones', () => {
    // Getting this backwards is invisible until the raw rows are gone.
    // Averaging steps under-reports a day sixtyfold; summing heart rate is
    // not a quantity anybody has ever wanted.
    const byKey = new Map(WEARABLE_METRIC_DEFINITIONS.map((d) => [String(d.key), d.aggregation]));

    expect(byKey.get('body.steps')).toBe('sum');
    expect(byKey.get('body.energy.active')).toBe('sum');
    expect(byKey.get('body.distance.walking')).toBe('sum');
    expect(byKey.get('body.heart_rate')).toBe('mean');
    expect(byKey.get('body.heart_rate.variability')).toBe('mean');
    expect(byKey.get('body.respiratory_rate')).toBe('mean');
  });
});

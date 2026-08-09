/**
 * Observations → daily values, aggregated the way the registry says.
 *
 * §6.2 gives `derivation/` one job: "pure functions: observations → derived
 * facts". This is the one every chart in the application goes through, and it
 * exists because of a single sentence in §9.2:
 *
 *   "Summing bodyweight over a week is nonsense and averaging training volume
 *    hides a taper; **the registry is what stops a chart from doing either.**"
 *
 * That is a claim the registry cannot make on its own — `metric.aggregation` is
 * just a column until something reads it. This file is the something. Every
 * chart takes a `MetricDefinition` and gets the combining rule for free, and
 * there is deliberately no way to ask for a sum of a `mean` metric: the
 * aggregation is not a parameter.
 *
 * ## Zone handling
 *
 * A day is a day **in the zone the observation was captured in**, taken from
 * `observation.observedZone` rather than from the reader's current setting.
 * §5.3: "a workout at 7am during travel is a materially different fact from one
 * at 7am at home, and discarding the zone destroys information you cannot
 * recover." A trip to London does not retroactively move three weeks of Indian
 * evenings onto the previous date.
 */

import type { MetricAggregation, MetricDefinition } from '../observations/metric';
import type { Observation } from '../observations/observation';
import type { DailyValue } from '../statistics/types';
import { dayKeyInZone } from '../timeline/grouping';

/**
 * Combine several values recorded on one day into the day's value.
 *
 * Exported because the weekly and monthly rollups apply the same rule one level
 * up, and because a caller with values from somewhere other than the
 * observation log — a set list, a routine log — should combine them identically.
 */
export function aggregate(values: readonly number[], how: MetricAggregation): number | null {
  if (values.length === 0) return null;

  switch (how) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'mean':
      return values.reduce((total, value) => total + value, 0) / values.length;
    case 'median': {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[middle] ?? null;
      return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    }
    case 'last':
      // The caller supplies values in observation order, so "last" is the last
      // one written — which for a corrected reading is the correction.
      return values.at(-1) ?? null;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return values.length;
  }
}

/**
 * The one place a stored decimal string becomes a float.
 *
 * `statistics/types.ts` explains the boundary at length. Everything upstream of
 * here is exact; everything downstream is drawn on a screen 360 pixels wide.
 *
 * An unparseable value is dropped rather than coerced to zero — a `NaN` in a
 * mean poisons the whole day, and a zero is a measurement nobody took.
 */
function numericValue(observation: Observation): number | null {
  const parsed = Number(observation.value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type RollupOptions = {
  /**
   * Override the zone each day is resolved in.
   *
   * Almost always wrong, and provided for one legitimate case: comparing a
   * travel period against a home period on a single axis, where the point *is*
   * to re-file everything into one frame. The default — each observation's own
   * zone — is what §5.3 requires.
   */
  readonly zone?: string;
};

/**
 * One value per day, aggregated per the metric's declared rule.
 *
 * Superseded observations are the caller's problem: the repository's
 * `currentOnly` filter (the default) has already removed them, and re-filtering
 * here would silently disagree with an explicit `currentOnly: false` query
 * asking for the historical view.
 */
export function dailyRollup(
  observations: readonly Observation[],
  metric: Pick<MetricDefinition, 'key' | 'aggregation'>,
  options: RollupOptions = {},
): readonly DailyValue[] {
  const byDay = new Map<string, number[]>();

  // Chronological, so `last` means last.
  const ordered = [...observations]
    .filter((observation) => observation.metricKey === metric.key)
    .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));

  for (const observation of ordered) {
    const value = numericValue(observation);
    if (value === null) continue;

    const dayKey = dayKeyInZone(observation.observedAt, options.zone ?? observation.observedZone);
    const existing = byDay.get(dayKey);
    if (existing === undefined) byDay.set(dayKey, [value]);
    else existing.push(value);
  }

  return [...byDay.entries()]
    .flatMap(([dayKey, values]) => {
      const combined = aggregate(values, metric.aggregation);
      return combined === null ? [] : [{ dayKey, value: combined }];
    })
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

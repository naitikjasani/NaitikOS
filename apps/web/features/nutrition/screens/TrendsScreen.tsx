'use client';

import type { ReactNode } from 'react';
import { nutrientForMetricKey } from '@naitikos/core';
import { EmptyState, Stack, Text, TrendChart } from '@naitikos/design-system';
import type { ChartData, Series } from '@naitikos/design-system';

import type { TrendSeries } from '@/lib/platform/nutrition';

/**
 * `/body/nutrition/trends` — ninety days of macros.
 *
 * ## A day with no meals is a gap, not a zero
 *
 * §8.9(3): "Missing data is shown as missing. Gaps are gaps. Lines break.
 * Interpolation across a week of no data is fabrication." A day nobody logged
 * is not a day of zero protein, and drawing it at the baseline would put a
 * cliff into the chart that describes forgetfulness rather than eating. So the
 * rollup's days are joined against the window and absent days carry `null`.
 *
 * ## The target is a second series, not a reference line
 *
 * Drawing it as a series means it appears in the chart's data table (§8.9(6))
 * and moves when the target moved, which is the whole point of targets being
 * time-bounded. A static horizontal rule would show today's target across
 * ninety days of history it was never in force for.
 *
 * ## The axis starts at zero
 *
 * §8.9(1) allows truncation when it is marked, and for a macro it is not worth
 * it: protein legitimately reaches zero on a day nothing was logged, and a
 * truncated axis on a nutrient chart makes an ordinary day look like a crisis.
 */

export type TrendsScreenProps = {
  readonly series: readonly TrendSeries[];
  readonly phase: string | null;
  readonly windowDays: number;
};

export function TrendsScreen({ series, phase, windowDays }: TrendsScreenProps): ReactNode {
  const withData = series.filter((entry) => entry.points.length > 0);

  if (withData.length === 0) {
    return (
      <EmptyState
        icon="nav.body"
        title="Nothing to plot yet"
        description="A trend needs days. Log meals for a week or two and this fills in — until then there is nothing here that would not be an invented line."
      />
    );
  }

  return (
    <Stack gap="5">
      {phase !== null && (
        <Text role="caption" tone="tertiary">
          Current phase: {phase}. Targets shown are the ones in force on each day, not today&apos;s.
        </Text>
      )}

      {withData.map((entry) => (
        <TrendChart
          key={entry.metricKey}
          title={nutrientForMetricKey(entry.metricKey)?.displayName ?? entry.metricKey}
          description={`Daily total over the last ${String(windowDays)} days.`}
          data={chartFor(entry)}
          caveat="A day with nothing logged is drawn as a gap, not as zero. It records that nothing was logged, which is not the same as nothing eaten."
        />
      ))}
    </Stack>
  );
}

function chartFor(entry: TrendSeries): ChartData {
  const points = entry.points.map((point) => ({ at: point.dayKey, value: point.value }));

  const series: Series[] = [
    {
      id: entry.metricKey,
      label: nutrientForMetricKey(entry.metricKey)?.displayName ?? entry.metricKey,
      /* Slot 1 for the value and slot 2 for the target, fixed per entity.
       * §8.9(5): colour follows the entity, never its rank. */
      slot: 1 as const,
      unit: entry.unit,
      points,
    },
  ];

  if (entry.target !== null) {
    const target = entry.target;
    series.push({
      id: `${entry.metricKey}:target`,
      label: 'Target',
      slot: 2,
      unit: entry.unit,
      points: points.map((point) => ({ at: point.at, value: target })),
    });
  }

  return {
    series,
    yAxis: { zeroBaseline: true, unit: entry.unit },
  };
}

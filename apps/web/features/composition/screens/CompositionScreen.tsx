'use client';

import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_TREND_WINDOW_DAYS,
  TREND_CAVEAT,
  dailyRollup,
  linearTrend,
  movingAverage,
  shiftDayKey,
  summariseTrend,
  trendBand,
  type MetricDefinition,
  type Observation,
} from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TrendChart,
} from '@naitikos/design-system';

import { queryKeys } from '@/lib/query/QueryProvider';

/**
 * `/body/composition` — bodyweight, and the only number that means anything.
 *
 * §4.6, restated because it is the entire design of this screen:
 *
 *   "Day-to-day variation of 1–2 kg is water, not tissue: the honest number for
 *    a bulk is the seven-day moving average, not the raw reading."
 *
 * So the **trend is the headline** and the raw readings are the faint series
 * behind it. Reversed — raw number large, trend small — the operator reads
 * yesterday against today, concludes they gained 1.4 kg overnight, and acts on
 * a number that is water.
 *
 * ## Three honesty properties, each from a specific rule
 *
 * - **The line breaks where readings stop.** §8.9(3). A fortnight of not
 *   weighing yourself is a gap, not a straight line across it.
 * - **The trend refuses to exist on thin data.** `movingAverage` returns `null`
 *   until a majority of the window has readings, so the first three days of a
 *   bulk show raw points and no trend — which is the truth.
 * - **The axis is truncated and says so.** §8.9(1). A 74–79 kg axis is the
 *   useful one and it is also the dramatic one; `ChartFrame` badges the
 *   truncation and `TrendChart` marks the break.
 */

const WINDOW_DAYS = 90;

const METRIC_KEY = 'body.weight';

/**
 * The observation rows, plus the registry entries for the metrics in them.
 *
 * The second half is what makes §9.2's "the registry is what stops a chart from
 * doing either" true on the client, where there is no registry to read.
 */
type ObservationsResponse = {
  readonly observations: readonly Observation[];
  readonly metrics: Readonly<Record<string, Pick<MetricDefinition, 'key' | 'displayName' | 'canonicalUnit' | 'valueType' | 'aggregation'>>>;
};

/**
 * Note the absence of a `zone` prop.
 *
 * Each reading is filed under the day *it* was captured in, taken from the
 * observation's own `observedZone` — §5.3 — so there is no screen-level zone to
 * apply. A prop here would be an invitation to re-file three weeks of Indian
 * mornings under London dates the first time the operator travels.
 */
export function CompositionScreen({ todayDayKey }: { readonly todayDayKey: string }): ReactNode {
  const fromDayKey = shiftDayKey(todayDayKey, -(WINDOW_DAYS - 1)) ?? todayDayKey;

  const params = useMemo(
    () => ({ metricKeys: 'body.weight', limit: 500 }),
    [],
  );

  const weights = useQuery({
    queryKey: queryKeys.observations(params),
    queryFn: async (): Promise<ObservationsResponse> => {
      const response = await fetch(`/api/observations?metricKeys=${METRIC_KEY}&limit=500`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Could not load weights (${String(response.status)}).`);
      return (await response.json()) as ObservationsResponse;
    },
  });

  /*
   * Rolled up by `core`, with the metric definition the *server* supplied.
   *
   * Two properties come free from doing it this way rather than mapping the
   * rows here by hand:
   *
   *  - The combining rule for a day with two weigh-ins is `body.weight`'s
   *    registered `mean`, not a choice this screen made. §9.2 removes that
   *    choice on purpose, and a chart that re-made it would be the exact
   *    failure the registry exists to prevent.
   *  - Each reading is filed under the day it was captured in, from its own
   *    `observedZone` (§5.3), because that is what `dailyRollup` does.
   */
  const samples = useMemo(() => {
    const metric = weights.data?.metrics[METRIC_KEY];
    if (metric === undefined) return [];
    return dailyRollup(weights.data?.observations ?? [], metric);
  }, [weights.data]);

  if (weights.isLoading) return <LoadingState label="Loading bodyweight" />;
  if (weights.error !== null) {
    return <ErrorState title="Could not load bodyweight" description="The record is intact; this view is not." />;
  }

  if (samples.length === 0) {
    return (
      <EmptyState
        icon="data.chart"
        title="No bodyweight recorded"
        description="Log a weight from the quick-capture rail and the trend appears here."
      />
    );
  }

  const inWindow = samples.filter((sample) => sample.dayKey >= fromDayKey);
  const trend = movingAverage(inWindow);
  const summary = summariseTrend(inWindow, 7);
  const fit = linearTrend(inWindow);
  const band = fit === null ? [] : trendBand(inWindow, fit);
  const bandByDay = new Map(band.map((point) => [point.dayKey, point]));

  return (
    <Stack gap="5">
      <Card variant="flat">
        <CardBody>
          <Inline justify="between" align="center">
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Seven-day trend
              </Text>
              <Text role="metric-l" as="p">
                {summary.latest === null ? '—' : summary.latest.toFixed(1)}
                <Text role="body-sm" tone="tertiary" as="span">
                  {' '}
                  kg
                </Text>
              </Text>
              {/*
                The trend is absent until the window has enough days, and saying
                so is better than showing the raw number in the trend's place —
                which is the raw number wearing a trend line's clothes.
              */}
              {summary.latest === null && (
                <Text role="caption" tone="tertiary">
                  {String(summary.sampleDays)} of {String(DEFAULT_TREND_WINDOW_DAYS)} days recorded — not enough
                  for a trend yet.
                </Text>
              )}
            </Stack>

            {summary.change !== null && summary.changeFromDayKey !== null && (
              <Stack gap="1">
                <Text role="caption" tone="tertiary">
                  Since {summary.changeFromDayKey}
                </Text>
                <Inline gap="1" align="center">
                  {/*
                    A badge with a direction word, never a colour alone. §8.2:
                    colour never encodes valence — and gaining weight is neither
                    good nor bad without knowing what the operator is doing.
                  */}
                  <Badge tone="neutral" icon={summary.change >= 0 ? 'data.trend-up' : 'data.trend-down'}>
                    {summary.change >= 0 ? '+' : ''}
                    {summary.change.toFixed(2)} kg
                  </Badge>
                </Inline>
              </Stack>
            )}
          </Inline>
        </CardBody>
      </Card>

      <TrendChart
        title="Bodyweight"
        description={`The last ${String(WINDOW_DAYS)} days. The trend is the seven-day average.`}
        caveat={TREND_CAVEAT}
        height={240}
        data={{
          series: [
            {
              id: 'trend',
              label: 'Seven-day trend',
              slot: 1,
              unit: 'kg',
              points: trend.map((point) => ({
                at: point.dayKey,
                value: point.value,
                ...(bandByDay.has(point.dayKey)
                  ? {
                      lower: bandByDay.get(point.dayKey)?.lower ?? 0,
                      upper: bandByDay.get(point.dayKey)?.upper ?? 0,
                    }
                  : {}),
              })),
            },
            {
              id: 'raw',
              label: 'Daily reading',
              slot: 2,
              unit: 'kg',
              points: inWindow.map((sample) => ({ at: sample.dayKey, value: sample.value })),
            },
          ],
          // Truncated, and therefore marked. A bodyweight axis from zero shows
          // a flat line at the top of an empty plot.
          yAxis: { zeroBaseline: false, unit: 'kg' },
        }}
      />
    </Stack>
  );
}

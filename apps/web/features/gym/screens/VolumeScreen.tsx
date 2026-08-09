'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { shiftDayKey } from '@naitikos/core';
import {
  BarChart,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Stack,
  Text,
  type BarDatum,
} from '@naitikos/design-system';

import { queryKeys } from '@/lib/query/QueryProvider';
import { fetchVolume } from '../services/gymClient';

/**
 * `/body/gym/volume` — §4.1's "volume/intensity/frequency analysis by muscle
 * group".
 *
 * ## The chart states its own method
 *
 * Attributed volume is not a measurement. A bench press trains chest, triceps
 * and front delts, and no observation says in what proportion — so the split is
 * a convention (`volume.ts`'s `SECONDARY_MUSCLE_SHARE`), the totals across
 * muscles deliberately exceed the session total, and both facts are printed
 * under the axis rather than left for someone to discover.
 *
 * That is P5 applied to a chart: the number is useful *because* it is consistent
 * over twenty years, not because it is accurate, and presenting it without
 * saying so would be presenting a convention as a finding.
 *
 * ## Excluded sets are shown
 *
 * A month of pull-ups with no recorded bodyweight contributes nothing to this
 * chart, and the honest response is to say how many sets were dropped and why —
 * not to render a chart that is quietly missing a third of the training.
 */

const WINDOW_DAYS = 28;

/** Fixed per muscle, so filtering the list cannot repaint the survivors. */
const SLOT_FOR_MUSCLE: Readonly<Record<string, BarDatum['slot']>> = {
  chest: 1,
  back: 2,
  quads: 3,
  hamstrings: 4,
  shoulders: 5,
  glutes: 6,
  biceps: 7,
  triceps: 8,
};

export function VolumeScreen({
  todayDayKey,
  zone,
}: {
  readonly todayDayKey: string;
  readonly zone: string;
}): ReactNode {
  const fromDayKey = shiftDayKey(todayDayKey, -(WINDOW_DAYS - 1)) ?? todayDayKey;

  const volume = useQuery({
    queryKey: queryKeys.gymVolume(fromDayKey, todayDayKey, zone),
    queryFn: () => fetchVolume(fromDayKey, todayDayKey, zone),
  });

  if (volume.isLoading) return <LoadingState label="Computing volume" />;
  if (volume.error !== null) {
    return <ErrorState title="Could not compute volume" description="The record is intact; this view is not." />;
  }

  const data = volume.data;
  if (data === undefined) return null;

  if (data.byMuscle.length === 0) {
    return (
      <EmptyState
        icon="data.chart"
        title="Nothing in this window"
        description={`No sets logged in the last ${String(WINDOW_DAYS)} days.`}
      />
    );
  }

  /*
   * Eight bars, because the palette has eight slots and a ninth series would be
   * a generated hue — which the dataviz rule forbids outright. Muscles past the
   * eighth fold into "Other" rather than being dropped: dropping them would
   * make the chart quietly understate the month.
   */
  const top = data.byMuscle.slice(0, 8);
  const rest = data.byMuscle.slice(8);
  const bars: BarDatum[] = top.map((entry) => ({
    id: entry.muscle,
    label: entry.label,
    value: Number(entry.volume),
    slot: SLOT_FOR_MUSCLE[entry.muscle] ?? 8,
    detail: `${String(entry.sets)} sets`,
  }));

  if (rest.length > 0) {
    bars.push({
      id: 'other',
      label: `Other (${String(rest.length)})`,
      value: rest.reduce((total, entry) => total + Number(entry.volume), 0),
      slot: 8,
    });
  }

  const excludedTotal = Object.values(data.total.excluded).reduce((sum, count) => sum + count, 0);

  return (
    <Stack gap="5">
      <Card variant="flat">
        <CardBody>
          <Inline justify="between" align="center">
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Total volume, {String(WINDOW_DAYS)} days
              </Text>
              <Text role="metric-l" as="p">
                {Number(data.total.volume).toLocaleString('en-GB')}
                <Text role="body-sm" tone="tertiary" as="span">
                  {' '}
                  kg
                </Text>
              </Text>
            </Stack>
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Training days
              </Text>
              <Text role="metric-m" as="p">
                {String(data.sessionDays.length)}
              </Text>
            </Stack>
          </Inline>
        </CardBody>
      </Card>

      <BarChart
        title="Attributed volume by muscle group"
        description={data.method.note}
        data={bars}
        unit="kg"
      />

      {/*
        Said out loud rather than left as a silent shortfall. §8.9(3) — "missing
        data is shown as missing" — applies to a set excluded from arithmetic as
        much as to a gap in a line.
      */}
      {excludedTotal > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="1">
              <Text role="body-sm">
                {String(excludedTotal)} sets are not counted above.
              </Text>
              <Text role="caption" tone="tertiary">
                {String(data.total.excluded['warmup'] ?? 0)} warm-ups (excluded by definition),{' '}
                {String(data.total.excluded['bodyweight_unknown'] ?? 0)} bodyweight movements with no recorded
                bodyweight, {String(data.total.excluded['incomplete'] ?? 0)} incomplete.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

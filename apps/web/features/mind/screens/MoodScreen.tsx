'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MIND_SCALES, shiftDayKey } from '@naitikos/core';
import {
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TrendChart,
} from '@naitikos/design-system';

import { fetchMindOverview, type ScaleSeries } from '../services/mindClient';

/**
 * `/mind/mood` — mood and energy over a long window.
 *
 * ## Why this is not `/mind`
 *
 * The pillar overview shows all three scales over a month, alongside episodes,
 * practices and the journal. It answers *how am I now*. This answers *how has
 * this year gone*, which is a different question and needs a different window:
 * six months, so a medication change or a season has room to show.
 *
 * Anxiety is deliberately absent. §3.2 gives it `/mind/anxiety` and an episode
 * log, because an anxiety reading without its episodes is the number without
 * the thing it describes. Mood and energy have no episode table and are exactly
 * what a long line is for.
 *
 * ## Every chart carries the medication markers
 *
 * §8.9(2) makes this mandatory rather than nice: *"A mood chart without the
 * 'started Escitalopram' marker is actively misleading."* The service returns
 * the annotations whether or not a screen asks for them, which is what stops a
 * new chart shipping without them by omission — this one included.
 *
 * ## Nothing here says why
 *
 * §4.7 forbids the system claiming a cause, and a long mood line beside a
 * medication marker is the single most tempting place in the product to break
 * that. The marker says *this happened then*. The adjacency is the whole
 * offering; the reading is the operator's, and a clinician's.
 */
export function MoodScreen({ zone, toDayKey }: { readonly zone: string; readonly toDayKey: string }): ReactNode {
  const fromDayKey = shiftDayKey(toDayKey, -(MOOD_WINDOW_DAYS - 1)) ?? toDayKey;

  const overview = useQuery({
    queryKey: ['mind', 'mood', fromDayKey, toDayKey, zone],
    queryFn: () => fetchMindOverview(fromDayKey, toDayKey, zone),
  });

  if (overview.isPending) return <LoadingState label="Reading the record" />;
  if (overview.data === undefined) {
    return <EmptyState title="Could not read the record" description="Nothing was changed." />;
  }

  const scales = overview.data.scales.filter((scale) => scale.id === 'mood' || scale.id === 'energy');
  const recorded = scales.reduce(
    (total, scale) => total + scale.points.filter((point) => point.value !== null).length,
    0,
  );

  return (
    <Stack gap="5">
      <Inline gap="3" justify="between" align="baseline">
        <Text role="body-sm" tone="secondary">
          {fromDayKey} to {toDayKey}
        </Text>
        <Text role="caption" tone="tertiary">
          {recorded === 0 ? 'nothing recorded' : `${String(recorded)} readings`}
        </Text>
      </Inline>

      {recorded === 0 ?
        <EmptyState
          title="No mood or energy recorded in this window"
          description="Both are Daily Close fields. A long line needs a long run of days, and there is nothing here yet to draw one from."
        />
      : scales.map((scale) => (
          <ScaleCard key={scale.id} scale={scale} annotations={overview.data.annotations} />
        ))
      }

      <Card variant="outlined">
        <CardBody>
          <Text role="caption" tone="tertiary">
            {/*
              Stated on the page rather than left implicit. A vertical line on a
              mood chart invites a causal reading, and §4.7 forbids the system
              offering one. Saying what the marker is *for* is the honest way to
              keep the adjacency useful.
            */}
            Vertical markers are medication starts and stops. They are placed so a change is visible beside the
            line, not because this system has any view on what the change did.
          </Text>
        </CardBody>
      </Card>
    </Stack>
  );
}

/**
 * Six months.
 *
 * Long enough for a medication change or a winter to show, short enough that
 * the line is still readable at one point per day. A year at this density is a
 * smear; a month is what `/mind` already shows.
 */
export const MOOD_WINDOW_DAYS = 182;

function ScaleCard({
  scale,
  annotations,
}: {
  readonly scale: ScaleSeries;
  readonly annotations: readonly {
    readonly dayKey: string;
    readonly kind: string;
    readonly medicationId: string;
    readonly label: string;
  }[];
}): ReactNode {
  const definition = MIND_SCALES[scale.id];

  return (
    <TrendChart
      title={scale.label}
      description={definition.direction === 'down_is_better' ? '1 none · 5 severe' : '1 low · 5 high'}
      data={{
        series: [
          {
            id: scale.id,
            /* The same fixed slot the overview uses. §8.9(5): colour follows the
             * entity, so mood is the same colour on both pages. */
            slot: scale.id === 'mood' ? 1 : 2,
            label: scale.label,
            points: scale.points.map((point) => ({ at: point.dayKey, value: point.value })),
          },
        ],
        annotations: annotations.map((annotation) => ({
          id: `${annotation.medicationId}-${annotation.kind}-${annotation.dayKey}`,
          at: annotation.dayKey,
          label: annotation.label,
          kind: 'point' as const,
        })),
        /* Zero-based and full scale, as on the overview. Truncating a 1–5
         * self-report to 2–4 turns a one-point answering difference into a
         * dramatic slope — §8.9(1), in the module where that matters most. */
        yAxis: { zeroBaseline: true, min: 0, max: 5, unit: '' },
      }}
      caveat={scale.movement.sentence}
    />
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
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
import { fetchProgression, type WireProgressionPoint } from '../services/gymClient';

/**
 * `/body/gym/exercises/:id` — §3.2's "exercise detail + all-time progression".
 *
 * ## Four measures, and why the operator picks between them
 *
 * | Measure | Answers | Fails to answer |
 * |---|---|---|
 * | Top set | "am I lifting more weight?" | a set of 5 vs a set of 12 |
 * | Relative | "am I stronger *for my size*?" | sessions with no bodyweight |
 * | Estimated max | "am I stronger, across rep ranges?" | anything above 12 reps |
 * | Volume | "am I doing more work?" | maximised by easy high-rep sets |
 *
 * None of them is *the* progression, which is why the chart makes the choice
 * explicit rather than picking one and labelling it "progress". A novice on a
 * linear programme reads the top set; someone running a block with varied rep
 * ranges reads the estimated max; someone auditing a deload reads volume.
 *
 * The relative line is the one worth switching to during a bulk. §4.1 lists
 * bodyweight as a read dependency of Gym for exactly this reason: the absolute
 * number rises for reasons that are not strength, and the two lines diverging is
 * the signal.
 *
 * ## The y-axis starts where the data does
 *
 * `zeroBaseline: false`, and §8.9(1) then requires the truncation to be marked —
 * which `ChartFrame` does, as a badge, and `TrendChart` reinforces with the axis
 * glyph. A bench press chart from 0 kg compresses two years of progress into the
 * top fifth of the plot; one from 55 kg is legible and, marked, honest.
 */

type Measure = 'topLoad' | 'relativeTopLoad' | 'bestEstimatedMax' | 'volume';

const MEASURES: readonly { readonly id: Measure; readonly label: string; readonly unit: string; readonly caveat?: string }[] = [
  { id: 'topLoad', label: 'Top set', unit: 'kg' },
  {
    id: 'relativeTopLoad',
    label: 'Relative',
    unit: '× bw',
    caveat:
      'The top set as a multiple of that session’s bodyweight. Sessions with no recorded bodyweight are gaps. During a bulk the absolute line rises for reasons that are not strength — the two diverging is the point.',
  },
  {
    id: 'bestEstimatedMax',
    label: 'Estimated max',
    unit: 'kg',
    caveat:
      'Estimated by Epley from the best set. Not offered above twelve repetitions, where every rep-max formula stops being reliable.',
  },
  { id: 'volume', label: 'Volume', unit: 'kg' },
];

export function ExerciseDetailScreen({ exerciseId }: { readonly exerciseId: string }): ReactNode {
  const [measure, setMeasure] = useState<Measure>('topLoad');

  const progression = useQuery({
    queryKey: queryKeys.gymProgression(exerciseId, 0),
    queryFn: () => fetchProgression(exerciseId),
  });

  if (progression.isLoading) return <LoadingState label="Loading progression" />;
  if (progression.error !== null) {
    return <ErrorState title="Could not load this exercise" description="The record is intact; this view is not." />;
  }

  const data = progression.data;
  if (data === undefined) return null;

  const active = MEASURES.find((item) => item.id === measure) ?? MEASURES[0];
  const points = data.points.map((point) => ({
    at: point.dayKey,
    // A session that produced nothing countable is a gap, not a zero (§8.9(3)).
    value: valueOf(point, measure),
  }));

  const hasAny = points.some((point) => point.value !== null);

  return (
    <Stack gap="5">
      <Stack gap="2">
        <Text role="title-2" as="h2">
          {data.exercise.name}
        </Text>
        <Inline gap="1">
          <Badge tone="neutral">{data.exercise.primaryMuscle.replace('_', ' ')}</Badge>
          {data.exercise.equipment !== null && <Badge tone="neutral">{data.exercise.equipment}</Badge>}
          {data.exercise.isUnilateral && <Badge tone="accent">per side</Badge>}
          {data.exercise.isBodyweight && <Badge tone="accent">bodyweight</Badge>}
        </Inline>
      </Stack>

      {data.exercise.formNotes !== null && (
        <Card variant="flat">
          <CardBody>
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Your notes
              </Text>
              <Text role="body-sm">{data.exercise.formNotes}</Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {!hasAny ? (
        <EmptyState
          icon="data.chart"
          title="Nothing logged yet"
          description="Progression appears once this movement has been performed."
        />
      ) : (
        <Stack gap="3">
          <Inline gap="2">
            {MEASURES.map((item) => (
              <Button
                key={item.id}
                variant={item.id === measure ? 'primary' : 'secondary'}
                size="sm"
                /* Selection exposed to assistive technology, not implied by
                   fill alone (§8.13). */
                aria-pressed={item.id === measure}
                onClick={() => {
                  setMeasure(item.id);
                }}
              >
                {item.label}
              </Button>
            ))}
          </Inline>

          <TrendChart
            title={`${active?.label ?? 'Progression'} over time`}
            description={`${String(data.points.length)} sessions`}
            {...(active?.caveat === undefined ? {} : { caveat: active.caveat })}
            data={{
              series: [
                {
                  id: measure,
                  label: active?.label ?? 'Progression',
                  slot: 1,
                  unit: active?.unit ?? 'kg',
                  points,
                },
              ],
              // Truncated on purpose, and therefore marked. See the header.
              yAxis: { zeroBaseline: false, unit: active?.unit ?? 'kg' },
            }}
          />
        </Stack>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Recent sessions
        </Text>
        {data.points
          .slice()
          .reverse()
          .slice(0, 10)
          .map((point) => (
            <Card key={point.sessionId} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center">
                  <Text role="body-sm" as="span">
                    {point.dayKey}
                  </Text>
                  <Text role="mono" as="span">
                    {point.topLoad ?? '—'} kg × {point.topLoadReps ?? '—'}
                    {point.relativeTopLoad === null ? '' : ` (${point.relativeTopLoad}× bw)`} ·{' '}
                    {String(point.workingSets)} sets
                  </Text>
                </Inline>
              </CardBody>
            </Card>
          ))}
      </Stack>
    </Stack>
  );
}

function valueOf(point: WireProgressionPoint, measure: Measure): number | null {
  const raw = point[measure];
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

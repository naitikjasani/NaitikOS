'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  GOAL_STATUS_LABELS,
  PROGRESS_STATUS_LABELS,
  TREND_CAVEAT,
  describeTarget,
  explainProgress,
} from '@naitikos/core';
import type { GoalProgress, GoalStatus, GoalTarget } from '@naitikos/core';
import type { ChartData } from '@naitikos/design-system';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TrendChart,
} from '@naitikos/design-system';

import type { GoalDetail } from '@/lib/platform/goals';
import { closeGoal } from '../services/goalClient';

/**
 * `/life/goals/:id` — the target, the trajectory, and the evidence.
 *
 * ## The chart is the fitted band plus a dashed projection
 *
 * §8.9(4): "Confidence must be visible where it exists. Trend lines carry a
 * band. **A projection is rendered dashed with an interval.**" `trendBand` and
 * `projectForward` produce both; the renderer dashes any point flagged
 * `isProjection`. Nothing here draws a bare line.
 *
 * The `TREND_CAVEAT` under it is not decoration either. Daily readings are
 * autocorrelated, so the interval is *narrower than the truth* — the caveat is
 * the honest label on a persuasive shape, and `core` owns the string so a
 * redesign cannot quietly drop it.
 *
 * ## Closing a goal asks why, and keeps the answer
 *
 * §4.10's "goal archaeology (why did this stop mattering?)". The note is the
 * only part of a closed goal anybody reads in year three, and a close button
 * that did not ask for one would throw away the entire feature.
 */
export function GoalDetailScreen({ detail }: { readonly detail: GoalDetail }): ReactNode {
  const router = useRouter();
  const { goal, targets, progress } = detail;

  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<Exclude<GoalStatus, 'active'>>('achieved');

  const close = useMutation({
    mutationFn: async () => {
      await closeGoal({ id: goal.id, status, closingNote: note.trim() === '' ? null : note.trim() });
    },
    onSuccess: () => {
      setClosing(false);
      router.refresh();
    },
  });

  return (
    <Stack gap="6">
      <Card variant="raised">
        <CardBody>
          <Stack gap="2">
            <Inline justify="between" align="center" wrap>
              <Text role="title-3" as="h2">
                {goal.title}
              </Text>
              <Badge tone={goal.status === 'active' ? 'accent' : 'neutral'}>
                {GOAL_STATUS_LABELS[goal.status]}
              </Badge>
            </Inline>
            <Text role="caption" tone="tertiary">
              {goal.startedAt === null ? '' : `Started ${goal.startedAt.slice(0, 10)}`}
              {goal.horizonAt === null ? '' : ` · horizon ${goal.horizonAt.slice(0, 10)}`}
            </Text>
            {goal.description !== null && (
              <Text role="body-sm" tone="secondary">
                {goal.description}
              </Text>
            )}
            {goal.closingNote !== null && (
              <Text role="body-sm" tone="secondary">
                {goal.closingNote}
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      {targets.map((target, index) => {
        const own = progress[index];
        if (own === undefined) return null;
        return <TargetSection key={target.id} target={target} progress={own} />;
      })}

      {goal.status === 'active' &&
        (closing ? (
          <Card variant="raised">
            <CardBody>
              <Stack gap="4">
                <Text role="title-3" as="h2">
                  Close this goal
                </Text>
                <Inline gap="2" wrap>
                  {(['achieved', 'abandoned', 'paused', 'superseded'] as const).map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={option === status ? 'primary' : 'secondary'}
                      aria-pressed={option === status}
                      onClick={() => {
                        setStatus(option);
                      }}
                    >
                      {GOAL_STATUS_LABELS[option]}
                    </Button>
                  ))}
                </Inline>
                <TextAreaField
                  label="Why it stopped mattering"
                  value={note}
                  rows={3}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                  hint="The part worth reading in year three. Kept forever."
                />
                <Inline gap="2" justify="between" align="center">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setClosing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={close.isPending}
                    onClick={() => {
                      close.mutate();
                    }}
                  >
                    Close it
                  </Button>
                </Inline>
              </Stack>
            </CardBody>
          </Card>
        ) : (
          <Inline justify="end">
            <Button
              variant="ghost"
              onClick={() => {
                setClosing(true);
              }}
            >
              Close this goal
            </Button>
          </Inline>
        ))}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/life/goals">
          All goals
        </Link>
      </Text>
    </Stack>
  );
}

function TargetSection({
  target,
  progress,
}: {
  readonly target: GoalTarget;
  readonly progress: GoalProgress;
}): ReactNode {
  const points = [
    ...progress.band.map((point) => ({
      at: point.dayKey,
      value: point.value,
      lower: point.lower,
      upper: point.upper,
    })),
    ...progress.projection.map((point) => ({
      at: point.dayKey,
      value: point.value,
      lower: point.lower,
      upper: point.upper,
      /* §8.9(4). The renderer dashes anything flagged here. */
      isProjection: true as const,
    })),
  ];

  const data: ChartData = {
    series: [{ id: target.id, label: target.metricKey, slot: 1, ...(target.unit === '' ? {} : { unit: target.unit }), points }],
    /* The target as a horizontal reference is deliberately *not* an annotation:
       §8.9(2)'s annotations are events on the time axis (medication starts,
       travel), and a value line is a different object. It is stated in words
       above the chart instead of being drawn as one. */
    yAxis: {
      label: target.metricKey,
      ...(target.unit === '' ? {} : { unit: target.unit }),
      zeroBaseline: false,
      ...(points.length === 0 ? {} : { min: Math.min(...points.map((point) => point.lower)) * 0.98 }),
    },
  };

  return (
    <Stack gap="3">
      <Inline justify="between" align="center" wrap>
        <Text role="body" as="span">
          {target.metricKey} — {describeTarget(target)}
        </Text>
        <Badge tone={progress.status === 'away' ? 'caution' : progress.status === 'met' || progress.status === 'on_track' ? 'accent' : 'neutral'}>
          {PROGRESS_STATUS_LABELS[progress.status]}
        </Badge>
      </Inline>

      <Text role="caption" tone="tertiary">
        {explainProgress(progress, target)}
        {progress.fit === null ? '' : ` Fit r² ${progress.fit.rSquared.toFixed(2)} — how well the line describes the readings, not how likely it is to hold.`}
      </Text>

      {points.length >= 2 ? (
        <TrendChart title={target.metricKey} data={data} caveat={TREND_CAVEAT} />
      ) : (
        <Card variant="flat">
          <CardBody>
            <Text role="body-sm" tone="secondary">
              Not enough readings to draw a line yet. Nothing is being projected.
            </Text>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

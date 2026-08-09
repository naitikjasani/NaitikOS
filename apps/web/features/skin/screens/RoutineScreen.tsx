'use client';

import { type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { ROUTINE_PERIOD_LABELS, systemClock } from '@naitikos/core';
import {
  AdherenceGrid,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Progress,
  Stack,
  Text,
} from '@naitikos/design-system';

import { clearRoutineStep, fetchRoutines, logRoutineStep } from '../services/skinClient';

/**
 * `/body/skin/routine` — AM/PM routine and adherence (§4.2, §9.2).
 *
 * ## Tapping cycles, and the third state is "no record"
 *
 * done → skipped → cleared → done. Three states rather than two, because
 * "cleared" is not "skipped": one says the step did not happen, the other says
 * nothing was recorded. Every adherence figure in the system depends on that
 * distinction, and a two-state toggle would force the operator to lie in one
 * direction or the other whenever they mis-tapped.
 *
 * ## The grid shows days with a log, not days with a full routine
 *
 * `AdherenceGrid`'s `levelFor` already separates no-record (level 0) from
 * recorded-zero (level 1), which is exactly the distinction this screen needs:
 * a day the operator opened the app and skipped everything looks different from
 * a day they never opened it.
 *
 * ## No streak celebration
 *
 * The current streak is reported as a number in a sentence. There is no flame,
 * no "keep it up", and no recovery streak after a break — §14.1's second
 * finding: "after a gap of three or more days the system offers optional
 * backfill and says nothing about the gap. No guilt copy, no 'you missed 4
 * days,' no recovery streak."
 */

const WINDOW_DAYS = 56;

export function RoutineScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();

  const routines = useQuery({
    queryKey: ['routines', dayKey, 'skincare'],
    queryFn: () => fetchRoutines(dayKey, { kind: 'skincare', windowDays: WINDOW_DAYS }),
  });

  const tap = useMutation({
    mutationFn: async (input: {
      readonly routineId: string;
      readonly stepId: string;
      readonly next: 'done' | 'skipped' | null;
    }) => {
      if (input.next === null) {
        await clearRoutineStep({ routineId: input.routineId, stepId: input.stepId, occurredOn: dayKey });
        return;
      }
      await logRoutineStep({
        id: uuidV7(systemClock.nowMillis()),
        routineId: input.routineId,
        stepId: input.stepId,
        occurredOn: dayKey,
        completedAt: input.next === 'done' ? nowIso : null,
        zone,
        status: input.next,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['routines'] });
    },
  });

  if (routines.isLoading) return <LoadingState label="Loading" />;

  const data = routines.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon="domain.routine"
        title="No routine defined"
        description="A routine is a named list of steps with a period. Defining one is not built yet; rows are inserted directly for now."
      />
    );
  }

  return (
    <Stack gap="5">
      {data.map((view) => (
        <Card key={view.routine.id} variant="raised">
          <CardBody>
            <Stack gap="4">
              <Stack gap="1">
                <Text role="title-3" as="h2">
                  {view.routine.name}
                </Text>
                <Text role="caption" tone="tertiary">
                  {ROUTINE_PERIOD_LABELS[view.routine.period]}
                  {view.routine.expectedAt === null ? '' : ` · ${view.routine.expectedAt}`}
                </Text>
              </Stack>

              <Stack gap="2">
                {view.steps.map((step) => {
                  const status = view.today[step.id] ?? null;
                  const next = status === null ? 'done' : status === 'done' ? 'skipped' : null;

                  return (
                    <Inline key={step.id} justify="between" align="center">
                      <Text role="body-sm" as="span">
                        {step.label}
                        {step.isOptional ? ' · optional' : ''}
                      </Text>
                      <Button
                        size="sm"
                        variant={status === 'done' ? 'primary' : 'secondary'}
                        /*
                         * The accessible name carries the step as well as the
                         * state. A row of six buttons all announced as "Done"
                         * is unusable without sight of the label beside them,
                         * and §8.13 requires the control to be understandable
                         * from its own accessible name.
                         */
                        aria-label={`${step.label}: ${status === null ? 'not recorded' : status}. Activate to cycle.`}
                        onClick={() => {
                          tap.mutate({ routineId: view.routine.id, stepId: step.id, next });
                        }}
                        disabled={tap.isPending}
                      >
                        {/* The visible label says what the state *is*, not what the tap does. */}
                        {status === null ? 'Not recorded' : status === 'done' ? 'Done' : 'Skipped'}
                      </Button>
                    </Inline>
                  );
                })}
              </Stack>

              <Stack gap="2">
                {/* Both inputs, always. Never the percentage alone. */}
                <Text role="body-sm" tone="secondary">
                  {view.adherence.sentence}
                </Text>
                {view.adherence.ratio !== null && (
                  <Progress
                    value={view.adherence.ratio * 100}
                    label={`${String(view.adherence.stepsCompleted)} of ${String(view.adherence.stepsRequired)} required steps`}
                  />
                )}
                {view.adherence.currentStreak > 0 && (
                  <Text role="caption" tone="tertiary">
                    {String(view.adherence.currentStreak)} consecutive complete days.
                  </Text>
                )}
              </Stack>

              <AdherenceGrid
                title={`${view.routine.name} — last ${String(WINDOW_DAYS)} days`}
                fromDayKey={view.adherence.days[0]?.dayKey ?? dayKey}
                toDayKey={dayKey}
                data={{
                  series: [
                    {
                      id: view.routine.id,
                      label: 'Steps completed',
                      slot: 1,
                      unit: 'steps',
                      points: view.adherence.days.map((day) => ({
                        at: day.dayKey,
                        /*
                         * A day with no log has no value at all — not a zero.
                         * `levelFor` renders the two differently, which is the
                         * whole reason this is `null` rather than `0`.
                         */
                        value: day.recorded ? day.completed : null,
                      })),
                    },
                  ],
                  yAxis: { zeroBaseline: true, unit: 'steps' },
                }}
              />
            </Stack>
          </CardBody>
        </Card>
      ))}
    </Stack>
  );
}

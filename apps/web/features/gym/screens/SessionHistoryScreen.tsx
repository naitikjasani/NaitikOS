'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AdherenceGrid, Card, CardBody, EmptyState, ErrorState, Inline, LoadingState, Stack, Text } from '@naitikos/design-system';
import { shiftDayKey } from '@naitikos/core';

import { queryKeys } from '@/lib/query/QueryProvider';
import { fetchSessions } from '../services/gymClient';

/**
 * `/body/gym/history` — past sessions, and the frequency they happened at.
 *
 * The grid answers §8.9's "did I do the thing, on which days?" and the list
 * answers "what did I do". Both, because the two questions have different
 * shapes: a pattern of missed Tuesdays is invisible in a list and a session's
 * contents are invisible in a grid.
 *
 * The grid's value is *sets logged that day*, so a light session and a heavy one
 * are distinguishable — but a day with a session and no sets still shows as
 * filled at the palest step, because it happened. `AdherenceGrid` draws that
 * distinction; this screen only has to supply the right numbers.
 */

const WINDOW_DAYS = 90;

export function SessionHistoryScreen({ todayDayKey }: { readonly todayDayKey: string }): ReactNode {
  const sessions = useQuery({
    queryKey: queryKeys.gymSessions(),
    queryFn: fetchSessions,
  });

  if (sessions.isLoading) return <LoadingState label="Loading sessions" />;
  if (sessions.error !== null) {
    return <ErrorState title="Could not load your sessions" description="The record is intact; this view is not." />;
  }

  const recent = sessions.data?.recent ?? [];
  const fromDayKey = shiftDayKey(todayDayKey, -(WINDOW_DAYS - 1)) ?? todayDayKey;

  if (recent.length === 0) {
    return (
      <EmptyState
        icon="nav.body"
        title="No sessions yet"
        description="Sessions appear here once you have logged one."
      />
    );
  }

  /*
   * Sets per day, not sessions per day. Two sessions in one day is one training
   * day (the same rule `programAdherence` applies), and the magnitude worth
   * seeing is how much work was done rather than how many times the app was
   * opened.
   */
  const byDay = new Map<string, number>();
  for (const summary of recent) {
    byDay.set(summary.dayKey, (byDay.get(summary.dayKey) ?? 0) + summary.setCount);
  }

  return (
    <Stack gap="5">
      <AdherenceGrid
        title="Training days"
        description={`The last ${String(WINDOW_DAYS)} days. Shade is sets logged.`}
        fromDayKey={fromDayKey}
        toDayKey={todayDayKey}
        data={{
          series: [
            {
              id: 'sets',
              label: 'Sets logged',
              slot: 1,
              unit: 'sets',
              points: [...byDay.entries()].map(([dayKey, value]) => ({ at: dayKey, value })),
            },
          ],
          yAxis: { zeroBaseline: true, unit: 'sets' },
        }}
      />

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Sessions
        </Text>
        {recent.map((summary) => (
          <Card key={summary.session.id} variant="outlined">
            <CardBody>
              <Inline justify="between" align="center">
                <Stack gap="1">
                  <Text role="body" as="span">
                    {summary.session.title ?? 'Training session'}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {summary.dayKey} · {String(summary.exerciseCount)} exercises
                  </Text>
                </Stack>
                <Text role="metric-m" as="span">
                  {String(summary.setCount)}
                  <Text role="caption" tone="tertiary" as="span">
                    {' '}
                    sets
                  </Text>
                </Text>
              </Inline>
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { PRACTICE_KIND_LABELS, PRACTICE_KINDS, practiceDelta, shiftDayKey, systemClock } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  NumberField,
  ScaleField,
  Stack,
  Text,
} from '@naitikos/design-system';

import { fetchMindOverview, logPractice } from '../services/mindClient';

/**
 * `/mind/practices` — meditation, breathwork, grounding.
 *
 * ## The before-and-after pair is the feature
 *
 * A duration log records that twelve minutes passed, which is not the question.
 * `stateBefore` / `stateAfter` is, and `core` returns `null` rather than zero
 * when either is missing — so a practice logged on a day too flat to rate does
 * not silently count as "no change" and drag the average towards neutral.
 *
 * The screen shows the delta per session and never averages it. An average
 * delta over a fortnight would be the first inferential claim in Mind, and
 * §2.1 keeps every non-adherence insight out of the MVP.
 */

const WINDOW_DAYS = 90;

export function PracticesScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const fromDayKey = shiftDayKey(dayKey, -(WINDOW_DAYS - 1)) ?? dayKey;

  const [kind, setKind] = useState<string>('meditation');
  const [minutes, setMinutes] = useState<number | null>(10);
  const [before, setBefore] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(null);

  const overview = useQuery({
    queryKey: ['mind', 'overview', fromDayKey, dayKey, zone],
    queryFn: () => fetchMindOverview(fromDayKey, dayKey, zone),
  });

  const log = useMutation({
    mutationFn: async () => {
      await logPractice({
        id: uuidV7(systemClock.nowMillis()),
        kind,
        startedAt: nowIso,
        zone,
        durationMinutes: minutes,
        stateBefore: before,
        stateAfter: after,
      });
    },
    onSuccess: async () => {
      setBefore(null);
      setAfter(null);
      await queryClient.invalidateQueries({ queryKey: ['mind', 'overview'] });
    },
  });

  const practices = overview.data?.practices ?? [];

  return (
    <Stack gap="5">
      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            <Inline gap="2" wrap>
              {PRACTICE_KINDS.map((candidate) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant={candidate === kind ? 'primary' : 'secondary'}
                  aria-pressed={candidate === kind}
                  onClick={() => {
                    setKind(candidate);
                  }}
                >
                  {PRACTICE_KIND_LABELS[candidate]}
                </Button>
              ))}
            </Inline>

            <NumberField
              label="Minutes"
              value={minutes}
              onValueChange={setMinutes}
              min={1}
              max={240}
              step={1}
            />

            <ScaleField label="Before" value={before} onValueChange={setBefore} minLabel="Low" maxLabel="High" />
            <ScaleField label="After" value={after} onValueChange={setAfter} minLabel="Low" maxLabel="High" />

            <Button
              variant="primary"
              fullWidth
              onClick={() => {
                log.mutate();
              }}
              disabled={log.isPending}
            >
              Record
            </Button>
          </Stack>
        </CardBody>
      </Card>

      {overview.isLoading ? (
        <LoadingState label="Loading practices" />
      ) : practices.length === 0 ? (
        <EmptyState
          icon="domain.practice"
          title="Nothing recorded yet"
          description="A practice is a duration and, if you rated them, a before and an after."
        />
      ) : (
        <Stack gap="2">
          {practices.map((practice) => {
            const delta = practiceDelta(practice);
            return (
              <Card key={practice.id} variant="outlined">
                <CardBody>
                  <Inline justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {PRACTICE_KIND_LABELS[practice.kind]} · {practice.startedAt.slice(0, 10)}
                    </Text>
                    <Text role="mono" as="span">
                      {practice.durationMinutes === null ? '—' : `${String(practice.durationMinutes)} min`}
                      {/*
                        A gap, not a zero. `practiceDelta` returns null when
                        either end is missing, and an em dash is what that
                        looks like.
                      */}
                      {delta === null ? '' : ` · ${delta > 0 ? '+' : ''}${String(delta)}`}
                    </Text>
                  </Inline>
                </CardBody>
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

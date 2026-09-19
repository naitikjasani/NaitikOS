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
 * The screen shows the pair per session and never averages it. An average delta
 * over a fortnight would be the first inferential claim in Mind, and §2.1 keeps
 * every non-adherence insight out of the MVP.
 *
 * ## Both ends, not just the difference
 *
 * The row used to render the signed delta alone — "+2" — which is the one form
 * of this number that is not a fact about the session. A `+2` from 1 to 3 and a
 * `+2` from 3 to 5 are different afternoons, and a lone signed integer beside a
 * duration reads as a score: something that could have been higher. §4.7's
 * no-negative-framing rule is not only about colour, and "2 → 4" is the reading
 * the operator gave, said back with nothing added.
 *
 * `practiceDelta` still decides whether there is anything to show at all,
 * because it is the thing that returns `null` rather than zero when either end
 * is missing (§10.6 — a gap is shown as a gap, never interpolated to neutral).
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
  /* See `JournalScreen` for the reasoning: a write the operator cannot see
     happen is a write they will do twice. Cleared on the next edit so the
     sentence is never a stale claim about what is on screen. */
  const [justRecorded, setJustRecorded] = useState(false);

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
      setJustRecorded(true);
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
                    setJustRecorded(false);
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
              onValueChange={(next) => {
                setJustRecorded(false);
                setMinutes(next);
              }}
              min={1}
              max={240}
              step={1}
            />

            {/*
              "Before" and "After" alone are adverbs with no noun — before what
              was measured, exactly? Naming the thing being rated is what makes
              the pair answerable at all, and the anchors stay the scale's ends
              rather than a verdict on them: "Low" and "High" describe where on
              the five points the answer sits, and neither is the right answer.
            */}
            <ScaleField
              label="How you felt before"
              value={before}
              onValueChange={(next) => {
                setJustRecorded(false);
                setBefore(next);
              }}
              minLabel="Low"
              maxLabel="High"
            />
            <ScaleField
              label="How you felt after"
              value={after}
              onValueChange={(next) => {
                setJustRecorded(false);
                setAfter(next);
              }}
              minLabel="Low"
              maxLabel="High"
            />

            <Text role="caption" tone="tertiary">
              Both are optional. A session with only one of them recorded is kept as it was given — it is
              never counted as no change.
            </Text>

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

            {(justRecorded || log.error !== null) && (
              <Text role="caption" tone="secondary" aria-live="polite">
                {log.error === null
                  ? 'Recorded.'
                  : 'That did not record. Nothing was lost — what you entered is still here.'}
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      {overview.isLoading ? (
        <LoadingState label="Loading practices" />
      ) : practices.length === 0 ? (
        <EmptyState
          icon="domain.practice"
          title="Nothing recorded yet"
          description="A practice is a duration and, if you rated them, a before and an after. Neither is required."
        />
      ) : (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Recorded practices
          </Text>
          {/*
            The arrow, explained once, in the list rather than in a tooltip.
            §8.12: a tooltip may not carry information the reader needs, and on a
            phone there is nothing to hover. Rows with only a duration are rows
            where one end was not rated, and saying so here is cheaper than a
            per-row em dash that would read as a missing score.
          */}
          <Text role="caption" tone="tertiary">
            Where both ends were rated, the pair is shown as before → after on the same five-point scale.
            Rows with a duration alone had one end left blank.
          </Text>
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
                        A gap, not a zero, and both ends rather than the
                        difference. `practiceDelta` returns null when either end
                        is missing, so a session rated at only one end shows its
                        duration and nothing else — which is what "not enough
                        data yet" looks like at the level of one row (§10.6).
                      */}
                      {delta === null || practice.stateBefore === null || practice.stateAfter === null
                        ? ''
                        : ` · ${String(practice.stateBefore)} → ${String(practice.stateAfter)}`}
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

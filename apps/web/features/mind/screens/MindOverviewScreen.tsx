'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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
import { MIND_SCALES, shiftDayKey, toneFor } from '@naitikos/core';

import { fetchMindOverview, type ScaleSeries } from '../services/mindClient';
import { CrisisCard } from '../components/CrisisCard';

/**
 * `/mind` — the pillar overview.
 *
 * ## The order on this screen is a clinical decision, not a layout one
 *
 * The crisis card is first when it is present, and nothing else moves to
 * accommodate it. §4.7's crisis principle would be defeated by a card that
 * appeared below three charts on a screen somebody is scrolling with one hand.
 *
 * Then the three scales, then episodes, then the journal. Not by importance —
 * by *how much reading each one asks for*. A scale is a number; an episode list
 * is a paragraph; the journal is the whole evening.
 *
 * ## No summary judgement anywhere
 *
 * There is no "you've had a good week" line on this page and there will not be
 * one. §4.7: "State is reported neutrally; deterioration is reported factually
 * and calmly." Each scale renders `movement.sentence`, which is built in `core`
 * precisely so no component can improvise a warmer or colder version of it.
 */

const WINDOW_DAYS = 90;

export function MindOverviewScreen({
  dayKey,
  zone,
}: {
  readonly dayKey: string;
  readonly zone: string;
}): ReactNode {
  const fromDayKey = shiftDayKey(dayKey, -(WINDOW_DAYS - 1)) ?? dayKey;

  const overview = useQuery({
    queryKey: ['mind', 'overview', fromDayKey, dayKey, zone],
    queryFn: () => fetchMindOverview(fromDayKey, dayKey, zone),
  });

  if (overview.isLoading) return <LoadingState label="Loading" />;
  if (overview.error !== null) {
    return <ErrorState title="Could not load this view" description="The record is intact; this view is not." />;
  }

  const data = overview.data;
  if (data === undefined) return null;

  const hasAnything = data.scales.some((scale) => scale.points.length > 0);

  return (
    <Stack gap="5">
      {/* First, always, and nothing above it. See the header. */}
      {data.crisis !== null && <CrisisCard plan={data.crisis.plan} />}

      {/*
        The invitation, and only on a settled stretch.

        `core`'s `shouldInvitePlanning` returns true when there is no plan on
        file *and* no current run of severe days — §4.7 wants the plan "entered
        by them when well", and asking for calm anticipatory work during a bad
        week converts a bad week into a bad week plus a form.

        It links out to `/settings/profile` rather than opening a form here, so
        the act of writing one is always deliberate.
      */}
      {data.invitePlanning && (
        <Card variant="flat">
          <CardBody>
            <Stack gap="1">
              <Text role="body-sm">
                There is no crisis plan on file.
              </Text>
              <Text role="caption" tone="tertiary">
                It is a page of your own words, shown back to you unchanged if a run of hard days is
                recorded. Worth writing on a settled day like this one.{' '}
                <Link className="nos-inline-link" href="/settings/profile">
                  Write one
                </Link>
                .
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {!hasAnything ? (
        <EmptyState
          icon="data.chart"
          title="Nothing recorded yet"
          description="Mood, energy and anxiety are three taps in the Daily Close. They appear here once there is a day or two of them."
        />
      ) : (
        <>
          {data.scales.map((scale) => (
            <ScaleCard key={scale.id} scale={scale} annotations={data.annotations} />
          ))}
          {/* The long view. This screen answers "how am I now"; six months is a
              different question and gets its own page rather than a range
              selector here, which would make this screen two screens. */}
          <Link className="nos-inline-link" href="/mind/mood">
            <Text role="caption" as="span">
              Mood and energy over six months
            </Text>
          </Link>
        </>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline justify="between" align="center">
              <Text role="title-3" as="h2">
                Anxiety episodes
              </Text>
              <Link className="nos-inline-link" href="/mind/anxiety">
                <Text role="caption" as="span">
                  All episodes
                </Text>
              </Link>
            </Inline>

            {data.episodes.length === 0 ? (
              <Text role="body-sm" tone="secondary">
                No episodes recorded in this window.
              </Text>
            ) : (
              data.episodes.slice(0, 5).map((episode) => (
                <Inline key={episode.id} justify="between" align="center">
                  <Text role="body-sm" as="span">
                    {episode.startedAt.slice(0, 10)}
                    {episode.trigger === null ? '' : ` · ${episode.trigger}`}
                  </Text>
                  {episode.intensity !== null && (
                    <Badge tone={toneFor('anxiety', episode.intensity) === 'attention' ? 'caution' : 'neutral'}>
                      {String(episode.intensity)} / 5
                    </Badge>
                  )}
                </Inline>
              ))
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline justify="between" align="center">
              <Text role="title-3" as="h2">
                Journal
              </Text>
              <Inline gap="3" align="center">
                <Link className="nos-inline-link" href="/mind/journal/prompts">
                  <Text role="caption" as="span">
                    Prompts
                  </Text>
                </Link>
                <Link className="nos-inline-link" href="/mind/journal">
                  <Text role="caption" as="span">
                    Open
                  </Text>
                </Link>
              </Inline>
            </Inline>

            {data.prompt === null ? null : (
              <Text role="body-sm" tone="secondary">
                Today’s prompt: {data.prompt.prompt}
              </Text>
            )}

            {/*
              Headings and word counts only, never an excerpt. See the note at
              the top of `core/domain/mind/journal.ts`.
            */}
            {data.journal.slice(0, 5).map((entry) => (
              <Inline key={entry.id} justify="between" align="center">
                <Link className="nos-inline-link" href={`/mind/journal/${entry.id}`}>
                  <Text role="body-sm" as="span">
                    {entry.heading}
                  </Text>
                </Link>
                <Text role="caption" tone="tertiary" as="span">
                  {entry.dayKey}
                </Text>
              </Inline>
            ))}
          </Stack>
        </CardBody>
      </Card>

      {/*
        Last, by this screen's own ordering rule — see the header. Therapy asks
        for more reading than anything above it, and unlike the journal there is
        nothing on it to skim: it is somewhere to go deliberately rather than a
        card to glance at. One line, and no session count beside it, for the
        reason argued in `TherapyScreen`.
      */}
      <Link className="nos-inline-link" href="/mind/therapy">
        <Text role="caption" as="span">
          Therapy sessions and between-session notes
        </Text>
      </Link>
    </Stack>
  );
}

function ScaleCard({
  scale,
  annotations,
}: {
  readonly scale: ScaleSeries;
  readonly annotations: MindAnnotations;
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
            label: scale.label,
            /*
             * A fixed slot per scale, not an array index. §8.9(5): colour
             * follows the entity, so mood stays the same colour whether or not
             * anxiety was recorded that week.
             */
            slot: scale.id === 'mood' ? 1 : scale.id === 'energy' ? 2 : 3,
            points: scale.points.map((point) => ({ at: point.dayKey, value: point.value })),
          },
        ],
        /*
         * §4.7: medication changes are annotated on *every* chart in the system.
         * The service returns them whether or not this screen asks, so a new
         * chart cannot ship without them by forgetting.
         */
        annotations: annotations.map((annotation) => ({
          id: `${annotation.medicationId}-${annotation.kind}-${annotation.dayKey}`,
          at: annotation.dayKey,
          label: annotation.label,
          kind: 'point' as const,
        })),
        /*
         * Full scale, zero-based. A 1–5 self-report has five meaningful values
         * and truncating it to 2–4 would turn a one-point answering difference
         * into a dramatic slope — the §8.9(1) failure, in the module where a
         * dramatic slope is least appropriate.
         */
        yAxis: { zeroBaseline: true, min: 0, max: 5, unit: '' },
      }}
      caveat={scale.movement.sentence}
    />
  );
}

type MindAnnotations = readonly {
  readonly dayKey: string;
  readonly kind: string;
  readonly medicationId: string;
  readonly label: string;
}[];

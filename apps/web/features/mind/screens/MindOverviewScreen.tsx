'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TrendChart,
} from '@naitikos/design-system';
import { MIND_SCALES, shiftDayKey } from '@naitikos/core';

import { fetchMindOverview, type ScaleSeries } from '../services/mindClient';
import { CrisisCard } from '../components/CrisisCard';

/**
 * `/mind` — the pillar overview.
 *
 * Laid out in the five bands settled in `HealthOverviewScreen` — act, attend,
 * state, record, doors — with one thing above all of them.
 *
 * ## The order on this screen is a clinical decision, not a layout one
 *
 * The crisis card is first when it is present, and nothing else moves to
 * accommodate it — not even the act band. §4.7's crisis principle would be
 * defeated by a card that appeared below three charts on a screen somebody is
 * scrolling with one hand.
 *
 * Below it the bands run in the usual order, which also happens to be this
 * screen's older ordering rule: *how much reading each one asks for*. A scale
 * is a number; an episode list is a paragraph; the journal is the whole
 * evening.
 *
 * ## No summary judgement anywhere, and no colour standing in for one
 *
 * There is no "you've had a good week" line on this page and there will not be
 * one. §4.7: "State is reported neutrally; deterioration is reported factually
 * and calmly." Each scale renders `movement.sentence`, which is built in `core`
 * precisely so no component can improvise a warmer or colder version of it.
 *
 * The same rule governs colour, and this screen used to break it — see
 * {@link IntensityBadge}.
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
    return (
      <ErrorState
        title="Could not load this view"
        description="The record is intact; this view is not."
      />
    );
  }

  const data = overview.data;
  if (data === undefined) return null;

  const hasAnything = data.scales.some((scale) => scale.points.length > 0);

  return (
    <Stack gap="6">
      {/* First, always, and nothing above it. See the header. */}
      {data.crisis !== null && <CrisisCard plan={data.crisis.plan} />}

      {/* 1 — Act. Mood, energy and anxiety are recorded in the Close (§3.2),
          and the journal is the other thing this pillar is opened to do. Both
          were reachable only by scrolling past three charts to a caption-sized
          link at the bottom of the page. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/today/close">Record today</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/mind/journal">Write in the journal</Link>
        </Button>
      </Inline>

      {/*
        2 — Attend. The invitation, and only on a settled stretch.

        `core`'s `shouldInvitePlanning` returns true when there is no plan on
        file *and* no current run of severe days — §4.7 wants the plan "entered
        by them when well", and asking for calm anticipatory work during a bad
        week converts a bad week into a bad week plus a form.

        It links out to `/settings/profile` rather than opening a form here, so
        the act of writing one is always deliberate.
      */}
      {data.invitePlanning && (
        <Card variant="outlined">
          <CardHeader as="h2" title="There is no crisis plan on file" />
          <CardBody>
            <Stack gap="3">
              <Text role="body-sm" tone="secondary">
                It is a page of your own words, shown back to you unchanged if a run of hard days is
                recorded. Worth writing on a settled day like this one.
              </Text>
              <Inline gap="3" wrap>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/settings/profile">Write one</Link>
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      )}

      {/* 3 — State. */}
      {!hasAnything ? (
        <Card variant="outlined">
          <CardHeader as="h2" title="Mood, energy and anxiety" />
          <CardBody>
            <EmptyState
              size="sm"
              icon="data.chart"
              title="Nothing recorded yet"
              description="Three taps in the Daily Close. The charts appear once there is a day or two of them — before that there is no line to draw, and drawing one anyway would be a shape the record has not earned."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          {data.scales.map((scale) => (
            <ScaleCard key={scale.id} scale={scale} annotations={data.annotations} />
          ))}
          {/* The long view. This screen answers "how am I now"; six months is a
              different question and gets its own page rather than a range
              selector here, which would make this screen two screens. */}
          <Inline gap="3" wrap>
            <Button asChild variant="ghost" size="sm">
              <Link href="/mind/mood">Mood and energy over six months</Link>
            </Button>
          </Inline>
        </>
      )}

      {/* 4 — Record. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Anxiety episodes"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/mind/anxiety">All episodes</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'No episodes in the last 90 days',
            description:
              'An episode records when it started, how long it lasted and what preceded it — the detail that is gone by the following week and is the only thing that makes a pattern findable later.',
          }}
        >
          {data.episodes.length === 0 ? null : (
            <Stack gap="3">
              {data.episodes.slice(0, 5).map((episode) => (
                <Inline key={episode.id} justify="between" align="center" gap="3" wrap>
                  <Text role="body-sm" as="span">
                    {episode.startedAt.slice(0, 10)}
                    {episode.trigger === null ? '' : ` · ${episode.trigger}`}
                  </Text>
                  {episode.intensity !== null && <IntensityBadge intensity={episode.intensity} />}
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Journal"
          {...(data.prompt === null ? {} : { description: `Today’s prompt: ${data.prompt.prompt}` })}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/mind/journal">Open</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing written yet',
            description:
              'Entries are listed here by heading only, never by excerpt. A prompt is one way in when a blank page is not.',
            /* No `action`: `EmptyState.action` is a callback, and a router push
               behind a button is a link that cannot be opened in a new tab. The
               prompts door is in band 5 with the rest. */
          }}
        >
          {data.journal.length === 0 ? null : (
            <Stack gap="3">
              {/*
                Headings and word counts only, never an excerpt. See the note at
                the top of `core/domain/mind/journal.ts`.
              */}
              {data.journal.slice(0, 5).map((entry) => (
                <Inline key={entry.id} justify="between" align="center" gap="3" wrap>
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
          )}
        </CardBody>
      </Card>

      {/*
        5 — Doors. Therapy is one of them rather than a caption stranded at the
        bottom of the page: it asks for more reading than anything above it and
        there is nothing on it to skim, so it is somewhere to go deliberately.
        One line, and no session count beside it, for the reason argued in
        `TherapyScreen`.
      */}
      <Card variant="flat">
        <CardHeader as="h2" title="Everything in Mind" />
        <CardBody>
          <Inline gap="3" wrap>
            {[
              { href: '/mind/mood', label: 'Mood and energy' },
              { href: '/mind/anxiety', label: 'Anxiety' },
              { href: '/mind/journal', label: 'Journal' },
              { href: '/mind/journal/prompts', label: 'Prompts' },
              { href: '/mind/practices', label: 'Practices' },
              { href: '/mind/therapy', label: 'Therapy' },
              { href: '/mind/meds', label: 'Medication' },
            ].map((door) => (
              <Button key={door.href} asChild variant="ghost" size="sm">
                <Link href={door.href}>{door.label}</Link>
              </Button>
            ))}
          </Inline>
        </CardBody>
      </Card>
    </Stack>
  );
}

/**
 * An anxiety episode's intensity, and the reason it is not amber.
 *
 * This badge chose its tone from `core`'s `toneFor`, rendering `caution` for an
 * intensity of 4 or 5 and `neutral` otherwise. That is the exact thing §8.2
 * prohibits — "**the rule: health data is never coloured by valence**" — in the
 * one module where the cost is highest. An operator with an anxiety disorder,
 * reviewing their own worst weeks, was shown those weeks in the colour the
 * design system reserves for "requires attention". Reading a record of a panic
 * attack should not itself feel like an alert.
 *
 * `toneFor` is not called here at all. It exists for chart marks where the
 * sequential palette carries magnitude without valence, and importing it into a
 * badge is how it becomes a verdict.
 *
 * The magnitude is still fully legible, and legible in a way colour never was:
 * `4 / 5` states the position on the scale and the scale it sits on, which is
 * §8.2's "position relative to a baseline" and satisfies §8.13's rule that no
 * information is carried by colour alone.
 */
function IntensityBadge({ intensity }: { readonly intensity: number }): ReactNode {
  return <Badge tone="neutral">{String(intensity)} / 5</Badge>;
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

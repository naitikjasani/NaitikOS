'use client';

import type { ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, DateField, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { MedicalTimeline, TimelineEntry } from '@/lib/platform/medical-timeline';

/**
 * `/timeline/medical` — §10.7's clinical view.
 *
 * ## Clinical, not chronologically flat
 *
 * §10.7 asks for "conditions as intervals, medications as bars with dose
 * changes marked, labs as points with reference ranges, procedures as events".
 * The distinction a list sorted by date loses is *duration*: a condition that
 * has been active for four years and a lab drawn on one morning are not the
 * same kind of fact, and rendering them identically is what makes a flat
 * timeline useless to a clinician.
 *
 * ## The reconstruction control is the point of the page
 *
 * §9.5's bitemporality exists so the record can answer "what did my file say in
 * March" after a correction in October, and §4.4 says a record that cannot is
 * one that "quietly lies to a clinician". That query is a date field here
 * rather than an export flag, because the moment it matters is a consultation
 * where someone asks what you were told at the time.
 *
 * When a past view is active the page says how many entries it is *hiding*
 * relative to today. A reconstruction that silently contained less would read
 * as data loss rather than as history.
 */

export function MedicalTimelineScreen({ timeline }: { readonly timeline: MedicalTimeline }): ReactNode {
  const router = useRouter();
  const params = useSearchParams();

  const setAsOf = (value: string | null): void => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '') next.delete('asOf');
    else next.set('asOf', value);
    router.push(next.size === 0 ? '/timeline/medical' : `/timeline/medical?${next.toString()}`);
  };

  const intervals = timeline.entries.filter((entry) => entry.shape === 'interval');
  const points = timeline.entries.filter((entry) => entry.shape === 'point');

  return (
    <Stack gap="5">
      <Inline justify="between" align="center" wrap>
        <Link className="nos-inline-link" href="/timeline/medical/pack">
          Build a consultation pack
        </Link>
        <Link className="nos-inline-link" href="/timeline">
          Full timeline
        </Link>
      </Inline>

      <Card variant="flat">
        <CardBody>
          <Stack gap="2">
            <DateField
              label="As the record stood on"
              value={timeline.asOfIso?.slice(0, 10) ?? ''}
              onValueChange={(value) => {
                setAsOf(value === '' ? null : `${value}T23:59:59.999Z`);
              }}
            />
            {timeline.asOfIso === null ? (
              <Text role="caption" tone="tertiary">
                Showing what is believed now. Set a date to see what the record said then — a diagnosis
                corrected later still shows as it was recorded at the time.
              </Text>
            ) : (
              <Inline gap="2" align="center" wrap>
                <Badge tone="caution">historical view</Badge>
                <Text role="caption" tone="tertiary">
                  {timeline.hiddenByReconstruction === 0
                    ? 'Nothing has changed since this date.'
                    : `${String(timeline.hiddenByReconstruction)} ${timeline.hiddenByReconstruction === 1 ? 'entry has' : 'entries have'} been added or revised since. They are hidden here, not lost.`}
                </Text>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAsOf(null);
                  }}
                >
                  Back to now
                </Button>
              </Inline>
            )}
          </Stack>
        </CardBody>
      </Card>

      {timeline.entries.length === 0 ? (
        <EmptyState
          icon="domain.clinical"
          title="Nothing on the clinical record"
          description="Conditions, medications, labs, procedures and appointments all appear here as they are recorded. An empty timeline is a record that has not been started, not one that is broken."
        />
      ) : (
        <>
          <Section title="Ongoing and past" entries={intervals} />
          <Section title="Events" entries={points} />
        </>
      )}
    </Stack>
  );
}

function Section({ title, entries }: { readonly title: string; readonly entries: readonly TimelineEntry[] }): ReactNode {
  if (entries.length === 0) return null;

  return (
    <Stack gap="2">
      <Text role="title-3" as="h2">
        {title}
      </Text>
      <Stack gap="2">
        {entries.map((entry) => (
          <Card key={entry.id} variant="outlined">
            <CardBody>
              <Stack gap="1">
                <Inline justify="between" align="center" wrap>
                  <Text role="body" as="span">
                    {entry.title}
                  </Text>
                  <Inline gap="2" align="center">
                    <Badge tone="neutral">{entry.type.replace(/_/gu, ' ')}</Badge>
                    {entry.ongoing && <Badge tone="accent">ongoing</Badge>}
                  </Inline>
                </Inline>

                <Text role="caption" tone="tertiary">
                  {when(entry)}
                  {entry.sourceDescription === null ? '' : ` · ${entry.sourceDescription}`}
                </Text>

                {entry.narrative !== null && (
                  <Text role="body-sm" tone="secondary">
                    {entry.narrative}
                  </Text>
                )}

                {/*
                  §9.5's transaction axis, shown when it disagrees with the
                  validity axis. A condition that began in January and was only
                  recorded in June is two different facts, and a timeline that
                  showed one of them would be the record a clinician cannot
                  reconcile with their own notes.
                */}
                {entry.recordedFrom.slice(0, 10) !== entry.validFrom.slice(0, 10) && (
                  <Text role="caption" tone="tertiary">
                    Recorded {entry.recordedFrom.slice(0, 10)}, backdated to {entry.validFrom.slice(0, 10)}.
                  </Text>
                )}
              </Stack>
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

function when(entry: TimelineEntry): string {
  const from = entry.validFrom.slice(0, 10);
  if (entry.shape === 'point') return from;
  /* An open interval says "since", never "from X to today". The second would
   * assert an end date nobody recorded. */
  return entry.validTo === null ? `since ${from}` : `${from} to ${entry.validTo.slice(0, 10)}`;
}

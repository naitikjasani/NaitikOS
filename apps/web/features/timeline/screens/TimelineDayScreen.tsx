import type { ReactNode } from 'react';
import Link from 'next/link';
import { hourInZone, minuteInZone } from '@naitikos/core';
import type { TimelineEntry, TimelineGroup } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TimelineDay } from '@/lib/platform/timeline-day';

/**
 * `/timeline/:date` — one day, fully expanded.
 *
 * ## Every entry, including the ones `/timeline` hides
 *
 * The collapsed timeline drops `detail`-significance entries because forty sets
 * bury a day. This is the page where those forty sets are the point, so they
 * are all here — grouped under the session they belong to rather than laid out
 * flat, which is the shape the day actually had.
 *
 * ## It reads forwards
 *
 * Every other timeline view is newest-first, because scrolling a record starts
 * from now. A day reads morning to evening. Reversing it would put the Daily
 * Close at the top and the workout that preceded it at the bottom.
 *
 * ## An empty day says so
 *
 * §8.9: missing data is shown as missing. A day with nothing recorded is a
 * legitimate and common thing — most people do not log every day, and C3 says
 * this system must survive three-week gaps in attention. The page states the
 * gap rather than rendering a blank column that reads as a loading failure.
 *
 * A Server Component. §9.1's log is append-only and the trigger enforces it, so
 * there is nothing on this page to interact with.
 */
export function TimelineDayScreen({ day }: { readonly day: TimelineDay }): ReactNode {
  return (
    <Stack gap="5">
      <Inline gap="3" justify="between" align="center">
        {day.previousDayKey === null ?
          <span />
        : <Link className="nos-inline-link" href={`/timeline/${day.previousDayKey}`}>
            <Text role="caption" as="span">
              ← {day.previousDayKey}
            </Text>
          </Link>
        }
        <Text role="caption" tone="tertiary">
          {day.entryCount === 0 ?
            'nothing recorded'
          : `${String(day.entryCount)} ${day.entryCount === 1 ? 'entry' : 'entries'}`}
        </Text>
        {day.nextDayKey === null ?
          <span />
        : <Link className="nos-inline-link" href={`/timeline/${day.nextDayKey}`}>
            <Text role="caption" as="span">
              {day.nextDayKey} →
            </Text>
          </Link>
        }
      </Inline>

      {day.groups.length === 0 ?
        <EmptyState
          title="Nothing recorded on this day"
          description="A day with no entries is a gap in the log, not a day nothing happened. Nothing is inferred to fill it."
        />
      : <Stack gap="6">
          {day.groups.map((group) => (
            <Group key={group.key} group={group} zone={day.zone} />
          ))}
        </Stack>
      }

      {day.truncated && (
        <Text role="caption" tone="tertiary">
          {/* Stated rather than letting the list quietly end. A day past the cap
              is almost certainly a projector fault, and a silently short page
              would hide it. */}
          More entries exist than this page shows. That is unusual for one day and worth looking at.
        </Text>
      )}
    </Stack>
  );
}

function Group({ group, zone }: { readonly group: TimelineGroup; readonly zone: string }): ReactNode {
  const [first] = group.entries;

  return (
    <Stack gap="3">
      <Inline gap="2" align="baseline">
        {first !== undefined && (
          <Text role="caption" tone="tertiary">
            {timeOf(first, zone)}
          </Text>
        )}
        {/*
          An `h2` per group, because a screen reader navigating by heading
          should move between the things that happened. §8.13 treats the
          document outline as a navigation surface rather than as styling.
        */}
        <Text role="title-3" as="h2">
          {group.label}
        </Text>
      </Inline>

      <Stack gap="2" as="ul">
        {group.entries.map((entry) => (
          <Card key={entry.eventId} variant="outlined" as="li">
            <CardBody>
              <Stack gap="1">
                <Inline gap="2" align="baseline">
                  <Text role="caption" tone="tertiary">
                    {timeOf(entry, zone)}
                  </Text>
                  <Text role="body">{entry.title}</Text>
                  {/* §8.2 forbids colour as the only carrier of meaning, and
                      clinical is the one distinction here that matters. */}
                  {entry.clinical && <Badge tone="accent">Clinical</Badge>}
                </Inline>
                {entry.detail !== null && (
                  <Text role="body-sm" tone="secondary">
                    {entry.detail}
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

/**
 * `HH:MM` in the zone the entry was captured in, not the profile's.
 *
 * §5.3: a workout at 7am during travel is a materially different fact from one
 * at 7am at home. Rendering a London morning in Asia/Kolkata would put it at
 * lunchtime on a page whose entire purpose is the order things happened in.
 */
function timeOf(entry: TimelineEntry, profileZone: string): string {
  const zone = entry.zone ?? profileZone;
  const hour = hourInZone(entry.occurredAt, zone);
  const minute = minuteInZone(entry.occurredAt, zone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

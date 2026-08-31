'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { minutesBetween } from '@naitikos/core';
import {
  AdherenceGrid,
  Badge,
  Card,
  CardBody,
  EmptyState,
  FileField,
  Inline,
  Stack,
  Text,
  ToggleField,
} from '@naitikos/design-system';

import type { CalendarBoard } from '@/lib/platform/learning';
import { importCalendar, setEventTravel, type CalendarImportOutcome } from '../services/learningClient';

/*
 * Re-declared rather than imported. The row shape lives in `@naitikos/db`, and
 * a client component that imported it would pull the database package into the
 * browser bundle.
 */
type CalendarEventRow = {
  readonly id: string;
  readonly title: string | null;
  readonly location: string | null;
  readonly calendarName: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly zone: string;
  readonly isAllDay: boolean;
  readonly isAccepted: boolean | null;
  readonly isTravel: boolean;
  readonly attendeeCount: number | null;
};

/**
 * `/work/calendar` — §4.8.
 *
 * §4.8 names this pillar's value precisely, and it is not scheduling:
 *
 *   "its value is context: the load, travel, and meeting density that explains
 *    a bad week in every other domain"
 *
 * So there is no agenda on this page, no next-meeting card and nothing to
 * accept or decline. There is a day-keyed strip of meeting minutes, drawn with
 * the same `AdherenceGrid` the routine and medication screens use, so laying it
 * beside a sleep series is a matter of looking at two pictures rather than
 * reconciling two conventions.
 *
 * ## The import is read-only and never writes back
 *
 * Nothing here creates, moves or declines an event. A system that could write
 * to a work calendar is a system that can embarrass its operator in front of
 * their colleagues, and §4.8 asks for none of that — it asks for the load.
 *
 * ## The travel flag belongs to the operator
 *
 * `looksLikeTravel` guesses once on import from words in the title. The
 * operator corrects it, and a re-import does not overwrite the correction —
 * P5: the system does not quietly undo a decision the operator made. The
 * distinction matters because a travel day contributes no meeting minutes, so
 * a flight misfiled as a meeting is six hours of invented load in the one
 * series that is supposed to explain a bad week.
 *
 * ## The file is read here, in the browser
 *
 * `await file.text()` and the body is posted. Handing the server a calendar URL
 * to fetch would be less typing and would turn this endpoint into a proxy for
 * arbitrary outbound requests — anything the server can reach, aimed by whoever
 * holds a session.
 */
export function CalendarScreen({
  board,
  zone,
}: {
  readonly board: CalendarBoard;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();

  const refresh = (): void => {
    router.refresh();
  };

  const heavyDays = board.days.filter((day) => day.meetingMinutes >= board.heavyThreshold).length;

  return (
    <Stack gap="6">
      <Import zone={zone} onImported={refresh} />

      <Inline gap="6" wrap>
        <Figure
          label="An average meeting day"
          /* Never `0`. A window with nothing imported has no average, and
           * printing zero would state that the operator had no meetings —
           * a claim about their month rather than about the data. */
          value={
            board.meanMeetingMinutes === null
              ? 'Not enough imported to say'
              : formatMinutes(Math.round(board.meanMeetingMinutes))
          }
        />
        <Figure label="Travel days" value={String(board.travelDays)} />
        <Figure
          label={`Days over ${formatMinutes(board.heavyThreshold)} of meetings`}
          value={String(heavyDays)}
        />
      </Inline>

      <AdherenceGrid
        title={`Meeting minutes — last ${String(board.days.length)} days`}
        description="Day-keyed so it can be laid next to sleep, mood or training. It says nothing about why."
        fromDayKey={board.days[0]?.dayKey ?? board.todayDayKey}
        toDayKey={board.todayDayKey}
        data={{
          series: [
            {
              id: 'meeting-minutes',
              label: 'Meeting minutes',
              slot: 1,
              unit: 'minutes',
              points: board.days.map((day) => ({
                at: day.dayKey,
                /*
                 * A day with no event rows is drawn as missing, not as zero. It
                 * is indistinguishable from a day the calendar was never
                 * imported for, and a run of confident zeroes across an unimported
                 * fortnight would read as a quiet fortnight — §8.9(3).
                 */
                value: day.meetingCount === 0 ? null : day.meetingMinutes,
              })),
            },
          ],
          yAxis: { zeroBaseline: true, unit: 'minutes' },
        }}
      />

      <Events events={board.events} onChanged={refresh} />
    </Stack>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
    </Stack>
  );
}

/* ======================================================================
 * The import
 * ====================================================================== */

function Import({
  zone,
  onImported,
}: {
  readonly zone: string;
  readonly onImported: () => void;
}): ReactNode {
  const [outcome, setOutcome] = useState<CalendarImportOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async (file: File) => {
      /*
       * Read in the browser. The alternative — posting a URL and letting the
       * server fetch it — costs the server its entire outbound surface, and the
       * operator already had the file in order to know the URL.
       */
      const content = await file.text();
      /*
       * The profile zone, not the browser's.
       *
       * The browser's is a better answer for a genuinely floating `.ics` —
       * local times with no zone mean "wherever I was", and only the browser
       * knows where that is. It is the wrong answer here anyway, because
       * `loadCalendar` buckets every day in the profile zone: an event stored
       * against a zone nothing reads it in leaves the `zone` column
       * contradicting the strip drawn from it, and a column that disagrees with
       * every read of it is worse than one that is occasionally off by an
       * offset. Importing while travelling files a floating event in the home
       * zone, which is the smaller error.
       */
      return importCalendar({ content, zone });
    },
    onSuccess: (result: CalendarImportOutcome) => {
      setOutcome(result);
      setProblem(null);
      onImported();
    },
    onError: (error: unknown) => {
      setOutcome(null);
      setProblem(error instanceof Error ? error.message : 'Could not read that calendar.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <FileField
            label="Import a calendar"
            accept=".ics,text/calendar"
            hint="An .ics export. The file is read here and its contents posted — nothing fetches a calendar URL on your behalf."
            onFilesSelected={(files) => {
              const file = files[0];
              /* Explicitly narrowed. `noUncheckedIndexedAccess` is on and an
               * empty selection is a real thing a file input produces. */
              if (file === undefined) return;
              run.mutate(file);
            }}
          />

          {run.isPending && (
            <Text role="body-sm" tone="secondary">
              Reading it.
            </Text>
          )}

          {outcome !== null && (
            <Stack gap="1">
              <Text role="body-sm">
                {String(outcome.imported.inserted)} new{' '}
                {outcome.imported.inserted === 1 ? 'event' : 'events'},{' '}
                {String(outcome.imported.updated)} updated.
              </Text>
              {outcome.skipped.length > 0 && (
                <Text role="body-sm" tone="secondary">
                  {String(outcome.skipped.length)}{' '}
                  {outcome.skipped.length === 1 ? 'block was' : 'blocks were'} skipped:{' '}
                  {summariseSkips(outcome.skipped)}.
                </Text>
              )}
              {/*
                Stated as a specific warning rather than folded into the counts.
                The parser does not expand recurrence, so a weekly stand-up
                arrives once — and the meeting-load series then understates the
                calendar in a way that reads as a quiet month rather than as a
                gap in the data.
              */}
              {outcome.unexpandedRecurrence > 0 && (
                <Text role="body-sm" tone="critical">
                  {String(outcome.unexpandedRecurrence)} recurring{' '}
                  {outcome.unexpandedRecurrence === 1 ? 'event was' : 'events were'} imported as a
                  single occurrence. Repeats after the first are not in the data, so the
                  meeting-load series below understates them.
                </Text>
              )}
            </Stack>
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Text role="caption" tone="tertiary">
            Read-only. Nothing here creates, moves or declines an event in your calendar.
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

function summariseSkips(
  skipped: readonly { readonly reason: string; readonly uid: string | null }[],
): string {
  const counts = new Map<string, number>();
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason.replace(/_/gu, ' ')} (${String(count)})`)
    .join(', ');
}

/* ======================================================================
 * The events
 * ====================================================================== */

function Events({
  events,
  onChanged,
}: {
  readonly events: readonly CalendarEventRow[];
  readonly onChanged: () => void;
}): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);

  const travel = useMutation({
    mutationFn: async (input: { readonly id: string; readonly isTravel: boolean }) => {
      await setEventTravel(input.id, input.isTravel);
    },
    onSuccess: () => {
      setProblem(null);
      onChanged();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not change that flag.');
    },
  });

  return (
    <Stack gap="2">
      <Text role="title-3" as="h2">
        Imported events
      </Text>
      {/* The one thing on this page that is asking for something. The importer
          guesses travel from words in a title, and a guess is worth correcting
          precisely because a travel day contributes no meeting minutes. */}
      <Text role="caption" tone="tertiary">
        Travel is guessed from the title on import and is yours to correct. Your correction survives a
        re-import.
      </Text>

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {events.length === 0 ? (
        <EmptyState
          title="Nothing imported yet"
          description="Export an .ics from your calendar and drop it above. Load, travel and meeting density are what this is for."
        />
      ) : (
        events.map((event) => (
          <Card key={event.id} variant="outlined">
            <CardBody>
              <Inline gap="3" align="center" justify="between">
                <Stack gap="1">
                  <Inline gap="2" align="center" wrap>
                    <Text role="body" as="span">
                      {/* An untitled event is a real row, not a broken one —
                          a private event exports with its summary stripped. */}
                      {event.title ?? 'Untitled'}
                    </Text>
                    {event.isAccepted === false && <Badge tone="neutral">Declined</Badge>}
                    {event.isAllDay && <Badge tone="neutral">All day</Badge>}
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {describeEvent(event)}
                  </Text>
                </Stack>
                <ToggleField
                  label="Travel"
                  checked={event.isTravel}
                  disabled={travel.isPending}
                  onCheckedChange={(next) => {
                    travel.mutate({ id: event.id, isTravel: next });
                  }}
                />
              </Inline>
            </CardBody>
          </Card>
        ))
      )}
    </Stack>
  );
}

function describeEvent(event: CalendarEventRow): string {
  const parts: string[] = [event.startsAt.slice(0, 16).replace('T', ' ')];

  if (!event.isAllDay) {
    const minutes = minutesBetween(event.startsAt, event.endsAt);
    /* Zero means the export stated no end time. Said as that rather than as
     * "0m", which would read as a meeting of no length. */
    parts.push(minutes === 0 ? 'no end time recorded' : formatMinutes(minutes));
  }

  if (event.attendeeCount !== null) {
    parts.push(`${String(event.attendeeCount)} ${event.attendeeCount === 1 ? 'attendee' : 'attendees'}`);
  }
  if (event.location !== null && event.location !== '') parts.push(event.location);
  if (event.calendarName !== null && event.calendarName !== '') parts.push(event.calendarName);

  return parts.join(' · ');
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${String(minutes)}m`;
  if (minutes === 0) return `${String(hours)}h`;
  return `${String(hours)}h ${String(minutes)}m`;
}

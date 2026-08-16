'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatDay } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TeethOverview } from '@/lib/platform/teeth';

/**
 * `/body/teeth/appointments` — §4.5's "appointment cadence".
 *
 * A filtered view of the appointments Health already holds, matched on
 * specialty, provider or title. Nothing is duplicated: the same row appears
 * here and on `/body/health/appointments`, which is §3.3(3)'s "one row, three
 * lenses" applied to a fourth.
 *
 * ## The cadence is stated, and no reminder is scheduled
 *
 * §4.5 says "appointment cadence with recall reminders". The cadence — how long
 * since the last visit — is computed here. The *reminder* is not, because §5.9
 * makes notifications opt-in and the notification surface does not exist yet;
 * a reminder wired to nothing would be the declared-but-never-executed pattern
 * this codebase keeps finding.
 *
 * ## What the filter cannot see is said out loud
 *
 * An appointment filed with no specialty and a neutral title does not appear
 * here. The count of those is shown, because a list that silently omits things
 * is worse than a list that says how much it is omitting.
 */
export function DentalAppointmentsScreen({
  overview,
  nowIso,
}: {
  readonly overview: TeethOverview;
  readonly nowIso: string;
}): ReactNode {
  const past = overview.appointments
    .filter((entry) => entry.scheduledFor !== null && entry.scheduledFor < nowIso)
    .sort((a, b) => ((a.scheduledFor ?? '') < (b.scheduledFor ?? '') ? 1 : -1));
  const upcoming = overview.appointments
    .filter((entry) => entry.scheduledFor !== null && entry.scheduledFor >= nowIso)
    .sort((a, b) => ((a.scheduledFor ?? '') < (b.scheduledFor ?? '') ? -1 : 1));

  const lastVisit = past[0]?.scheduledFor ?? null;
  const monthsSince = lastVisit === null ? null : monthsBetween(lastVisit, nowIso);

  return (
    <Stack gap="6">
      {overview.appointments.length === 0 ? (
        <EmptyState
          icon="domain.appointment"
          title="No dental appointments on file"
          description="Appointments recorded with a dental specialty appear here. They live in the same register as every other appointment."
        />
      ) : (
        <>
          <Card variant="raised">
            <CardBody>
              <Stack gap="1">
                <Text role="body" as="span">
                  {monthsSince === null
                    ? 'No past visit recorded.'
                    : monthsSince === 0
                      ? 'Last visit was this month.'
                      : `Last visit was ${String(monthsSince)} ${monthsSince === 1 ? 'month' : 'months'} ago.`}
                </Text>
                <Text role="caption" tone="tertiary">
                  {upcoming.length === 0
                    ? 'Nothing booked.'
                    : `Next: ${formatDay(upcoming[0]?.scheduledFor ?? '') ?? ''}.`}
                </Text>
              </Stack>
            </CardBody>
          </Card>

          {upcoming.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Coming up
              </Text>
              {upcoming.map((entry) => (
                <Card key={entry.id} variant="outlined">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Link className="nos-inline-link" href={`/body/health/appointments/${entry.id}`}>
                        {entry.title}
                      </Link>
                      <Badge tone="accent">{formatDay(entry.scheduledFor ?? '') ?? ''}</Badge>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}

          {past.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Past
              </Text>
              {past.map((entry) => (
                <Card key={entry.id} variant="flat">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Link className="nos-inline-link" href={`/body/health/appointments/${entry.id}`}>
                        {entry.title}
                      </Link>
                      <Text role="caption" tone="tertiary">
                        {formatDay(entry.scheduledFor ?? '') ?? ''}
                      </Text>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}

      {overview.unclassifiedAppointments > 0 && (
        <Text role="caption" tone="tertiary">
          {overview.unclassifiedAppointments}{' '}
          {overview.unclassifiedAppointments === 1 ? 'appointment has' : 'appointments have'} no specialty recorded, so
          this page cannot tell whether they were dental. They are all on{' '}
          <Link className="nos-inline-link" href="/body/health/appointments">
            Appointments
          </Link>
          .
        </Text>
      )}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/body/teeth">
          Back to Teeth
        </Link>
      </Text>
    </Stack>
  );
}

/** Whole months between two instants, floored. Good enough for a cadence. */
function monthsBetween(from: string, to: string): number {
  const fromYear = Number(from.slice(0, 4));
  const fromMonth = Number(from.slice(5, 7));
  const toYear = Number(to.slice(0, 4));
  const toMonth = Number(to.slice(5, 7));
  return Math.max(0, (toYear - fromYear) * 12 + (toMonth - fromMonth));
}

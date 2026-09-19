import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ARCHES, formatDay, toothLabel } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { TeethOverview } from '@/lib/platform/teeth';

/**
 * `/body/teeth` — §4.5.
 *
 * §4.5's case for the module in one sentence: "A person with multiple root
 * canals has a dental history that will matter for decades and that no dental
 * practice will reliably retain across relocations, insurers, or practitioner
 * changes." So this page is a record, not a dashboard.
 *
 * Laid out in the five bands settled in `HealthOverviewScreen`. Teeth has no
 * *attend* band: whether a filling needs replacing is a dentist's call, and a
 * page that raised it would be making one (P5).
 *
 * ## The chart marks teeth that have had work, and says nothing more
 *
 * No colour scale by procedure count, no per-tooth condition score, no "areas
 * of concern". A per-tooth health score computed from procedure counts would
 * tell a person with four root canals that their mouth is failing — a clinical
 * judgement made by arithmetic, which is exactly what P5 forbids. A tooth
 * either has history or it does not, and the history is one tap away.
 *
 * ## Marked teeth are labelled, not only coloured
 *
 * §8.13 forbids colour-alone status. Each marked tooth carries a dot *and* is
 * announced with its full name and procedure count, so the chart is legible to
 * a screen reader and in forced-colours mode.
 *
 * ## The sections stay put when they are empty
 *
 * Hygiene, sensitivity and cost used to vanish from the page when they had no
 * rows, which meant a record with two procedures in it rendered as a page with
 * one thing on it and no indication that the other three exist. §8.8 wants an
 * empty card to be "a designed state, not a blank rectangle", and the designed
 * state is also the only place the module gets to say what it would hold.
 *
 * ## A Server Component
 *
 * No interaction, no hooks, props from an `async` page. The `'use client'` it
 * carried shipped a hydration bundle to draw thirty-two list items.
 */
export function TeethOverviewScreen({ overview }: { readonly overview: TeethOverview }): ReactNode {
  const marked = new Set([...overview.byTooth.keys()].filter((key) => key !== ''));

  const nothingYet =
    overview.procedures.length === 0 &&
    overview.routines.length === 0 &&
    overview.appointments.length === 0;

  if (nothingYet) {
    return (
      <Stack gap="6">
        <EmptyState
          icon="domain.clinical"
          title="Nothing on file yet"
          description="Procedures, a hygiene routine and dental appointments appear here. This is the record no practice keeps for you across a move."
        />
        <Inline gap="3" justify="center" wrap>
          <Button asChild variant="primary">
            <Link href="/body/teeth/procedures">Add a procedure</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/body/teeth/appointments">Record an appointment</Link>
          </Button>
        </Inline>
        {/* Band 5 renders here too. A module with nothing in it and no way
            further in is a module a person decides is not finished. */}
        <TeethDoors />
      </Stack>
    );
  }

  return (
    <Stack gap="6">
      {/* 1 — Act. The record is built one procedure at a time, usually on the
          evening of the appointment, and that is the write this page exists to
          make easy. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/body/teeth/procedures">Add a procedure</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/body/teeth/appointments">Record an appointment</Link>
        </Button>
      </Inline>

      {/* 3 — State. Thirty-two teeth, two of which are the whole reason for the
          module, readable in about a second. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="What has had work"
          description="FDI notation. A marked tooth has recorded history; nothing here scores a tooth or judges its condition."
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/teeth/procedures">Procedures</Link>
            </Button>
          }
        />
        <CardBody>
          <Stack gap="3">
            <Arch label="Upper" teeth={ARCHES.upper} marked={marked} counts={overview.byTooth} />
            <Arch label="Lower" teeth={ARCHES.lower} marked={marked} counts={overview.byTooth} />
          </Stack>
        </CardBody>
      </Card>

      {/* 4 — Record. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Hygiene"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/teeth/hygiene">Detail</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'No routine on file',
            description:
              'A routine is what adherence gets measured against. Without one there is nothing to be behind on — which is a fine state, and the reason this says so rather than showing a zero.',
          }}
        >
          {overview.routines.length === 0 ? null : (
            <Stack gap="3">
              {overview.routines.map((entry) => (
                <Stack key={entry.routine.id} gap="1">
                  <Text role="body" as="span">
                    {entry.routine.name}
                  </Text>
                  {/* The sentence is assembled in `core` so every surface says
                      it identically and the unrecorded count can never be
                      dropped in the rendering (§4.7). */}
                  <Text role="caption" tone="tertiary">
                    {entry.adherence.sentence}
                  </Text>
                </Stack>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      {/*
        Appointments were loaded by `loadTeeth` and rendered nowhere — the list
        existed only to decide whether the page was empty. §4.5's own question
        is "am I protecting the work?", and `/body`'s door to this module
        promises "how long since the last appointment", so the answer belonged
        on the page rather than one navigation past it. No new read: this is the
        array the loader already returns.
      */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Appointments"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/teeth/appointments">All of them</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'None recorded',
            description:
              'Every visit, with what was said and what was decided. A practice keeps this until you move; this keeps it afterwards.',
          }}
        >
          {overview.appointments.length === 0 ? null : (
            <Stack gap="3">
              {overview.appointments.slice(0, 5).map((appointment) => (
                <Inline key={appointment.id} justify="between" align="center" gap="3" wrap>
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {appointment.title}
                    </Text>
                    {appointment.provider !== null && (
                      <Text role="caption" tone="tertiary">
                        {appointment.provider}
                      </Text>
                    )}
                  </Stack>
                  {/*
                    A date, and which kind of date it is. `attendedAt` and
                    `scheduledFor` are different facts and §8.9(3) will not let
                    a missing one be drawn as the other — "not recorded" is the
                    honest third case rather than today's date standing in.
                  */}
                  <Text role="caption" tone="tertiary">
                    {appointment.attendedAt !== null
                      ? `attended ${formatDay(appointment.attendedAt) ?? ''}`
                      : appointment.scheduledFor !== null
                        ? `scheduled ${formatDay(appointment.scheduledFor) ?? ''}`
                        : 'no date recorded'}
                  </Text>
                </Inline>
              ))}
              {overview.unclassifiedAppointments > 0 && (
                /* The list above is filtered to dental by specialty, title and
                   provider, so an appointment with no specialty recorded cannot
                   be placed. Saying how many were skipped is the difference
                   between a filtered list and a list that is quietly wrong. */
                <Text role="caption" tone="tertiary">
                  {String(overview.unclassifiedAppointments)}{' '}
                  {overview.unclassifiedAppointments === 1 ? 'appointment has' : 'appointments have'}{' '}
                  no specialty recorded and could not be placed here or anywhere else.
                </Text>
              )}
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Sensitivity and pain"
          description="Read from the symptom log, filtered to the mouth."
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/health/symptoms">Symptoms</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing logged',
            description:
              'A symptom recorded on the day it happens is the detail that is gone by the next appointment. Logged under Health; shown here because it is about a tooth.',
          }}
        >
          {overview.symptoms.length === 0 ? null : (
            <Stack gap="3">
              {overview.symptoms.slice(0, 5).map((symptom) => (
                <Inline key={symptom.id} justify="between" align="center" gap="3" wrap>
                  <Text role="body-sm" as="span">
                    {symptom.name}
                    {symptom.bodySite === null ? '' : ` · ${symptom.bodySite}`}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {symptom.startedAt === null ? 'Start not recorded' : formatDay(symptom.startedAt)}
                  </Text>
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="What it has cost"
          /* There is no exchange rate in this system. Two currencies are two
             numbers, and converting them would be wrong by a different amount
             every year. */
          description="Totalled per currency, never across them."
        />
        <CardBody
          empty={{
            title: 'No cost recorded',
            description:
              'A cost is recorded against the procedure it paid for. This total is the answer to a question that gets asked at insurance renewal and is otherwise impossible to reconstruct.',
          }}
        >
          {overview.costs.length === 0 ? null : (
            <Inline gap="3" wrap>
              {overview.costs.map((cost) => (
                <Badge key={cost.currency} tone="neutral">
                  {cost.currency} {(cost.minor / 100).toFixed(2)}
                </Badge>
              ))}
            </Inline>
          )}
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <TeethDoors />
    </Stack>
  );
}

/**
 * §3.2's children of `/body/teeth`.
 *
 * `size="sm"` buttons rather than inline links: §8.13 wants ≥44×44px, which a
 * 13px underlined word is not, and the small button's hit area reaches full
 * size behind a small box. The gap is `3` because two of them any closer would
 * claim the same pixels.
 */
function TeethDoors(): ReactNode {
  return (
    <Card variant="flat">
      <CardHeader as="h2" title="Everything in Teeth" />
      <CardBody>
        <Inline gap="3" wrap>
          {[
            { href: '/body/teeth/procedures', label: 'Procedures' },
            { href: '/body/teeth/hygiene', label: 'Hygiene' },
            { href: '/body/teeth/appointments', label: 'Appointments' },
          ].map((door) => (
            <Button key={door.href} asChild variant="ghost" size="sm">
              <Link href={door.href}>{door.label}</Link>
            </Button>
          ))}
        </Inline>
      </CardBody>
    </Card>
  );
}

function Arch({
  label,
  teeth,
  marked,
  counts,
}: {
  readonly label: string;
  readonly teeth: readonly string[];
  readonly marked: ReadonlySet<string>;
  readonly counts: TeethOverview['byTooth'];
}): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <ul className="nos-arch" aria-label={`${label} teeth`}>
        {teeth.map((notation) => {
          const has = marked.has(notation);
          const count = counts.get(notation)?.length ?? 0;
          return (
            <li key={notation} className={has ? 'nos-arch__tooth nos-arch__tooth--marked' : 'nos-arch__tooth'}>
              {/* The accessible name carries the meaning; the dot is decoration
                  on top of it, never instead of it (§8.13). */}
              <span aria-hidden="true">{notation}</span>
              <span className="nos-visually-hidden">
                {toothLabel(notation)}
                {has
                  ? `, ${String(count)} ${count === 1 ? 'procedure' : 'procedures'} recorded`
                  : ', no recorded history'}
              </span>
            </li>
          );
        })}
      </ul>
    </Stack>
  );
}

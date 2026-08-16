'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ARCHES, formatDay, parseTooth, toothLabel } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TeethOverview } from '@/lib/platform/teeth';

/**
 * `/body/teeth` — §4.5.
 *
 * §4.5's case for the module in one sentence: "A person with multiple root
 * canals has a dental history that will matter for decades and that no dental
 * practice will reliably retain across relocations, insurers, or practitioner
 * changes." So this page is a record, not a dashboard.
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
 */
export function TeethOverviewScreen({ overview }: { readonly overview: TeethOverview }): ReactNode {
  const marked = new Set([...overview.byTooth.keys()].filter((key) => key !== ''));

  const nothingYet =
    overview.procedures.length === 0 && overview.routines.length === 0 && overview.appointments.length === 0;

  if (nothingYet) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.clinical"
          title="Nothing on file yet"
          description="Procedures, a hygiene routine and dental appointments appear here. This is the record no practice keeps for you across a move."
        />
        <Text role="body-sm" tone="secondary" align="center">
          <Link className="nos-inline-link" href="/body/teeth/procedures">
            Add a procedure
          </Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="6">
      <Stack gap="3">
        <Text role="title-3" as="h2">
          What has had work
        </Text>
        <Arch label="Upper" teeth={ARCHES.upper} marked={marked} counts={overview.byTooth} />
        <Arch label="Lower" teeth={ARCHES.lower} marked={marked} counts={overview.byTooth} />
        <Text role="caption" tone="tertiary">
          FDI notation. A marked tooth has recorded history; nothing here scores a tooth or judges its condition.
        </Text>
      </Stack>

      {overview.routines.length > 0 && (
        <Stack gap="2">
          <Inline justify="between" align="center">
            <Text role="title-3" as="h2">
              Hygiene
            </Text>
            <Link className="nos-inline-link" href="/body/teeth/hygiene">
              Detail
            </Link>
          </Inline>
          {overview.routines.map((entry) => (
            <Card key={entry.routine.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
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
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {overview.symptoms.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Sensitivity and pain
          </Text>
          {overview.symptoms.slice(0, 5).map((symptom) => (
            <Card key={symptom.id} variant="flat">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Text role="body-sm" as="span">
                    {symptom.name}
                    {symptom.bodySite === null ? '' : ` · ${symptom.bodySite}`}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {symptom.startedAt === null ? '' : formatDay(symptom.startedAt)}
                  </Text>
                </Inline>
              </CardBody>
            </Card>
          ))}
          <Text role="caption" tone="tertiary">
            Read from the symptom log, filtered to the mouth. Log one on{' '}
            <Link className="nos-inline-link" href="/body/health/symptoms">
              Symptoms
            </Link>
            .
          </Text>
        </Stack>
      )}

      {overview.costs.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            What it has cost
          </Text>
          <Inline gap="3" wrap>
            {overview.costs.map((cost) => (
              <Badge key={cost.currency} tone="neutral">
                {cost.currency} {(cost.minor / 100).toFixed(2)}
              </Badge>
            ))}
          </Inline>
          {/* There is no exchange rate in this system. Two currencies are two
              numbers, and converting them would be wrong by a different amount
              every year. */}
          <Text role="caption" tone="tertiary">
            Totalled per currency, never across them.
          </Text>
        </Stack>
      )}

      <Inline gap="3" wrap>
        <Link className="nos-inline-link" href="/body/teeth/procedures">
          Procedures
        </Link>
        <Link className="nos-inline-link" href="/body/teeth/hygiene">
          Hygiene
        </Link>
        <Link className="nos-inline-link" href="/body/teeth/appointments">
          Appointments
        </Link>
      </Inline>
    </Stack>
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

/** Re-exported so the detail screen and the chart agree on what a tooth is. */
export { parseTooth };

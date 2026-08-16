'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AdherenceGrid, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TeethOverview } from '@/lib/platform/teeth';

/**
 * `/body/teeth/hygiene` — §4.5's "hygiene routine and adherence".
 *
 * There is no dental adherence code in this file, in `core`, or in `db`. §9.2
 * predicted that: "a generic routine engine reused by skincare, **dental
 * hygiene**, and supplements. One implementation, three consumers — the
 * alternative is three near-identical adherence systems."
 *
 * This screen is the third consumer arriving, and the engine needed no changes
 * to accept it. Defining the routine happens on the shared authoring surface;
 * tapping a step happens through the shared client. What is here is a heading.
 *
 * ## The sentence comes from `core`, not from this file
 *
 * `routineWindowAdherence` assembles it so every surface says it identically
 * and the unrecorded-days count can never be dropped in the rendering. §4.7's
 * "no negative framing" applies: it reports counts, never "you missed".
 */
export function HygieneScreen({ overview }: { readonly overview: TeethOverview }): ReactNode {
  if (overview.routines.length === 0) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.routine"
          title="No dental routine defined"
          description="A routine here is a name, a time of day, and an ordered list of steps — brush, floss, mouthwash. Adherence is then counted the same way skincare's is."
        />
        {/* The authoring surface is shared. A second "define a dental routine"
            form would be the second of the three systems §9.2 warns about. */}
        <Text role="body-sm" tone="secondary" align="center">
          <Link className="nos-inline-link" href="/body/skin/routine">
            Define one on the routine surface
          </Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="6">
      {overview.routines.map((entry) => (
        <Stack gap="3" key={entry.routine.id}>
          <Inline justify="between" align="center" wrap>
            <Text role="title-3" as="h2">
              {entry.routine.name}
            </Text>
            <Text role="caption" tone="tertiary">
              {entry.steps.length} {entry.steps.length === 1 ? 'step' : 'steps'}
            </Text>
          </Inline>

          <Card variant="flat">
            <CardBody>
              <Text role="body-sm" tone="secondary">
                {entry.adherence.sentence}
              </Text>
            </CardBody>
          </Card>

          <AdherenceGrid
            /* The window is read off the data rather than imported as a
               constant: `lib/platform/teeth.ts` is `server-only`, and a client
               component pulling a value out of it breaks the build. Counting
               the days actually rendered is also the more honest label. */
            title={`${entry.routine.name} — last ${String(entry.adherence.days.length)} days`}
            fromDayKey={entry.adherence.days[0]?.dayKey ?? overview.todayDayKey}
            toDayKey={overview.todayDayKey}
            data={{
              series: [
                {
                  id: entry.routine.id,
                  label: 'Steps completed',
                  slot: 1,
                  unit: 'steps',
                  points: entry.adherence.days.map((day) => ({
                    at: day.dayKey,
                    /*
                     * A day with no log has no value at all — not a zero.
                     * `levelFor` renders the two differently, which is exactly
                     * the distinction that matters here: a night the operator
                     * skipped flossing is not the same as a night they never
                     * opened the app.
                     */
                    value: day.recorded ? day.completed : null,
                  })),
                },
              ],
              yAxis: { zeroBaseline: true, unit: 'steps' },
            }}
          />

          <Stack gap="1">
            {entry.steps.map((step) => (
              <Text role="caption" tone="tertiary" key={step.id}>
                {step.orderIndex + 1}. {step.label}
                {step.isOptional ? ' (optional — excluded from both sides of the ratio)' : ''}
              </Text>
            ))}
          </Stack>
        </Stack>
      ))}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/body/teeth">
          Back to Teeth
        </Link>
      </Text>
    </Stack>
  );
}

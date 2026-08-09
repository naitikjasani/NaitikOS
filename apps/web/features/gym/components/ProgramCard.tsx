'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Program, ProgramAdherence, ProgramBlock } from '@naitikos/core';
import { Badge, Card, CardBody, Inline, Progress, Stack, Text } from '@naitikos/design-system';

/**
 * Program adherence — §4.1's "program definition and adherence", the half of it
 * that is built.
 *
 * ## No red crosses
 *
 * The card never says a session was *missed*. §4.0's reasoning about the Daily
 * Close applies to training too: "a system that only accepts complete records
 * trains the user to log nothing on a bad day, and bad days are the clinically
 * interesting ones." A gym app that shows a red cross for every skipped Tuesday
 * is one the operator stops opening in a bad month — which is precisely the
 * month whose data would have been worth having.
 *
 * So adherence is **sessions performed over sessions intended**, reported
 * alongside both of its inputs so it can never be read as a verdict, and
 * uncapped upwards so training *more* than planned is visible rather than
 * flattened to "100%".
 */

type ProgramResponse = {
  readonly program: Program | null;
  readonly adherence: ProgramAdherence | null;
  readonly nextBlock: ProgramBlock | null;
};

export function ProgramCard(): ReactNode {
  const program = useQuery({
    queryKey: ['gym', 'program'],
    queryFn: async (): Promise<ProgramResponse> => {
      const response = await fetch('/api/gym/program', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Could not load the program (${String(response.status)}).`);
      return (await response.json()) as ProgramResponse;
    },
  });

  const data = program.data;
  /*
   * Nothing rendered when there is no program, rather than an empty card
   * inviting the operator to make one. §3.3 R6's reasoning at card scale: a
   * visible-but-empty thing teaches that the system is a graveyard, and program
   * authoring is not built yet — so there is nothing to invite them to.
   */
  if (data === undefined || data.program === null || data.adherence === null) return null;

  const { program: plan, adherence } = data;
  const ratio = adherence.ratio;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline justify="between" align="center">
            <Stack gap="1">
              <Text role="title-3" as="h2">
                {plan.name}
              </Text>
              <Text role="caption" tone="tertiary">
                Last {String(adherence.windowDays)} days
              </Text>
            </Stack>
            {data.nextBlock !== null && <Badge tone="accent">Next: {data.nextBlock.name}</Badge>}
          </Inline>

          {ratio === null ? (
            <Text role="body-sm" tone="secondary">
              {String(adherence.sessionsPerformed)} training days. No frequency target set, so there is
              nothing to compare it to.
            </Text>
          ) : (
            <Stack gap="2">
              {/*
                Both inputs, always, next to the ratio. A bare "83%" is a verdict;
                "5 of 6 intended" is a description, and the operator can see
                immediately whether the shortfall is one session or five.
              */}
              <Inline justify="between" align="center">
                <Text role="body-sm" as="span">
                  {String(adherence.sessionsPerformed)} of {adherence.sessionsIntended?.toFixed(0) ?? '—'}{' '}
                  intended training days
                </Text>
                <Text role="metric-m" as="span">
                  {Math.round(ratio * 100)}%
                </Text>
              </Inline>

              {/*
                The bar is clamped at 100 while the number above it is not.
                A bar cannot render past its track, and stretching one to 167%
                would be a graphical lie; the honest place for "above the plan"
                is the number and the note below it.
              */}
              <Progress
                value={Math.min(1, ratio) * 100}
                label={`${String(adherence.sessionsPerformed)} of ${adherence.sessionsIntended?.toFixed(0) ?? '—'} training days`}
              />

              {/*
                Training more than planned gets a note rather than a green tick.
                It is not a success state — it is the usual prelude to the injury
                a deload exists to prevent, and the operator should see it.
              */}
              {ratio > 1 && (
                <Text role="caption" tone="tertiary">
                  Above the plan. Worth knowing rather than celebrating.
                </Text>
              )}
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

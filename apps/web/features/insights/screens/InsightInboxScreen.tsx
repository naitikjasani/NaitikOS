'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  EmptyState,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { InsightRow } from '@/lib/platform/insights';
import { setDisposition } from '../services/insightClient';

/**
 * `/insights` — §3.2's V2 inbox.
 *
 * ## An inbox, not a feed
 *
 * §10.6's central claim is that "an untrustworthy insight surface in a health
 * application is worse than none", and the fastest route to untrustworthy is
 * volume. Everything here has already survived five controls: a minimum-N gate,
 * Benjamini–Hochberg across the whole nightly battery, a pre-registered
 * hypothesis, confirmation in a second independent window, and sixty days of
 * baseline. Most nights it will be empty, and that is the system working.
 *
 * Descriptive counts are deliberately absent. They are recomputed correctly on
 * every read and would put a new, nearly-identical row here every morning —
 * which is the feed §3.3 rules out.
 *
 * ## Every card shows what it does not prove
 *
 * §10.6 makes `doesNotProve` a required field in the output schema, so it is
 * rendered unconditionally rather than behind a disclosure. "An insight the user
 * cannot audit is an insight they should not act on", and a limitation behind a
 * chevron is a limitation nobody reads.
 *
 * ## Dismissal is a first-class outcome
 *
 * §4.13: "dismissals train the ranking." An insight the operator does not find
 * useful is information about the system, not about them — so the dismiss
 * control is as prominent as the acted-on one, and neither is styled as the
 * correct answer.
 *
 * ## The shape, and where it departs from a pillar
 *
 * `HealthOverviewScreen` settles the five bands every overview follows. This
 * screen has three of them: *state* (the findings, or the designed absence of
 * any), *record* (the bar they had to clear), and *doors*. There is no act
 * band, because there is nothing here to log — the whole surface is the system
 * reporting on itself. There is no attend band either, since the findings *are*
 * the attention, and a second one above them would be a heading over a heading.
 *
 * The bar sits below the findings rather than above, and that ordering is the
 * point of the section: it is the answer to the question the findings provoke —
 * *should I believe any of this?* — and an answer read before its question is a
 * disclaimer.
 */

export type InsightInboxScreenProps = {
  readonly insights: readonly InsightRow[];
  readonly baselineMessage: string;
  readonly comparisons: number;
};

export function InsightInboxScreen({
  insights,
  baselineMessage,
  comparisons,
}: InsightInboxScreenProps): ReactNode {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = (id: string, disposition: 'acted_on' | 'dismissed'): void => {
    setBusyId(id);
    void setDisposition({ id, disposition, reason: null })
      .then(() => {
        router.refresh();
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  return (
    <Stack gap="6">
      {/* 3 — State: what the system noticed, or the designed absence of it. */}
      {insights.length === 0 ? (
        /*
          `data.chart` rather than `domain.streak`, which is what sat here.
          §1.5 removes the concept of a streak from this product entirely — "a
          missed day costs one day, never everything before it" — and an icon
          named for one on the surface that most needs to look statistically
          sober was a small contradiction in a place that cannot afford any.
        */
        <EmptyState
          icon="data.chart"
          title="Nothing here"
          description="An empty inbox is the expected state, most nights. A finding only appears after it has survived a minimum sample size, a correction across the whole night's tests, a hypothesis registered in advance, and confirmation in a second independent window."
        />
      ) : (
        <Stack gap="3">
          {insights.map((insight) => (
            <Card key={insight.id} variant="outlined">
              <CardBody>
                <Stack gap="3">
                  <Inline justify="between" align="center" wrap>
                    {/* §4.13: an insight the operator cannot audit is one they
                        should not trust, so the card is a door to the evidence
                        rather than the whole of it. */}
                    <Link className="nos-inline-link" href={`/insights/${insight.id}`}>
                      {insight.title}
                    </Link>
                    <Inline gap="2" align="center">
                      <Badge tone="neutral">{insight.method}</Badge>
                      {insight.disposition === 'seen' && <Badge tone="neutral">seen</Badge>}
                    </Inline>
                  </Inline>

                  {insight.narrative !== null && (
                    <Text role="body-sm" tone="secondary">
                      {insight.narrative}
                    </Text>
                  )}

                  <Inline gap="3" wrap>
                    {insight.effectSize !== null && (
                      <Text role="caption" tone="tertiary">
                        effect {insight.effectSize}
                      </Text>
                    )}
                    {insight.pValue !== null && (
                      <Text role="caption" tone="tertiary">
                        p {Number(insight.pValue).toPrecision(2)}
                      </Text>
                    )}
                  </Inline>

                  <Divider />

                  {/* §10.6: required, so rendered unconditionally. A limitation
                      behind a chevron is a limitation nobody reads. */}
                  <Text role="caption" tone="tertiary">
                    {insight.limitations ?? 'No limitation recorded, which is itself a defect — every finding must carry one.'}
                  </Text>

                  {/*
                    `gap="3"`, not `2`. A small button's 44px hit area is drawn
                    by a pseudo-element that reaches 6px past its box, so two of
                    them closer than `--space-3` claim the same pixels — §8.13's
                    "≥8px separation" enforced at the only place it can be.
                  */}
                  <Inline gap="3" justify="end" wrap>
                    {/* Neither is styled as the correct answer. §4.13 makes a
                        dismissal information about the system, not about the
                        operator. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      isLoading={busyId === insight.id}
                      onClick={() => {
                        act(insight.id, 'dismissed');
                      }}
                    >
                      Not useful
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      isLoading={busyId === insight.id}
                      onClick={() => {
                        act(insight.id, 'acted_on');
                      }}
                    >
                      Acted on this
                    </Button>
                  </Inline>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {/* 4 — Record: what the bar was, whether or not anything cleared it. */}
      <Card variant="outlined">
        <CardHeader as="h2" title="The bar a finding has to clear" />
        <CardBody>
          <Stack gap="2">
            <Text role="body-sm" tone="secondary">
              {baselineMessage}
            </Text>
            {/*
              The comparison count, printed. §10.6 control 2 corrects across the
              whole battery, and showing the size of that correction is what lets
              the operator judge how hard the bar was — an insight surface that hid
              its own denominator would be asking for trust it had not shown.
            */}
            <Text role="body-sm" tone="secondary">
              {comparisons === 0
                ? 'No statistical tests were run last night.'
                : `${String(comparisons)} statistical ${comparisons === 1 ? 'test was' : 'tests were'} run last night, corrected together.`}
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <Card variant="flat">
        <CardHeader as="h2" title="Where else to look" />
        <CardBody>
          <Inline gap="3" wrap>
            {/* §4.13 pairs the two surfaces: the inbox is what the system
                noticed, Ask is for what it did not. */}
            <Button asChild variant="ghost" size="sm">
              <Link href="/ask">Ask something the inbox did not raise</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/insights/archive">Everything ever surfaced</Link>
            </Button>
            {/*
              §10.9's calibration surface. It had no inbound link from anywhere in
              the application until the inbox moved up beside it — an orphaned
              route, reachable only by typing the URL.

              It belongs here rather than anywhere else, because calibration is
              the answer to the question this page provokes: *should I believe
              any of this?* A system that surfaces findings and hides its own
              track record is asking for trust it has not shown the working for.
            */}
            <Button asChild variant="ghost" size="sm">
              <Link href="/insights/calibration">How well its predictions have held up</Link>
            </Button>
          </Inline>
        </CardBody>
      </Card>
    </Stack>
  );
}

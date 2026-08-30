'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, Divider, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { InsightRow } from '@/lib/platform/insights';
import { setDisposition } from '../services/insightClient';

/**
 * `/life/insights` — §3.2's V2 inbox.
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
    <Stack gap="5">
      {insights.length === 0 ? (
        <EmptyState
          icon="domain.streak"
          title="Nothing here"
          description="An empty inbox is the expected state. A finding only appears after it has survived a minimum sample size, a correction across the whole night's tests, a hypothesis registered in advance, and confirmation in a second independent window."
        />
      ) : (
        <Stack gap="3">
          {insights.map((insight) => (
            <Card key={insight.id} variant="outlined">
              <CardBody>
                <Stack gap="3">
                  <Inline justify="between" align="center" wrap>
                    <Text role="body" as="span">
                      {insight.title}
                    </Text>
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

                  <Inline gap="2" justify="end" wrap>
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

      <Stack gap="1">
        <Text role="caption" tone="tertiary">
          {baselineMessage}
        </Text>
        {/*
          The comparison count, printed. §10.6 control 2 corrects across the
          whole battery, and showing the size of that correction is what lets
          the operator judge how hard the bar was — an insight surface that hid
          its own denominator would be asking for trust it had not shown.
        */}
        <Text role="caption" tone="tertiary">
          {comparisons === 0
            ? 'No statistical tests were run last night.'
            : `${String(comparisons)} statistical ${comparisons === 1 ? 'test was' : 'tests were'} run last night, corrected together.`}
        </Text>
      </Stack>
    </Stack>
  );
}

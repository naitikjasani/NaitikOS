'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, Divider, Inline, Stack, Text } from '@naitikos/design-system';

import type { InsightEvidenceRow, InsightRow } from '@/lib/platform/insights';

/**
 * `/insights/:id` — §3.2's "evidence, method, confidence".
 *
 * §4.13: "An insight the user cannot audit is an insight they should not
 * trust." This page is what audit means in practice — the method that produced
 * it, the sample it was drawn from, the p-value it cleared, and the rows behind
 * it, none of which fit on an inbox card and all of which are the difference
 * between a claim and a finding.
 *
 * The limitation is above the numbers rather than below them. A reader who
 * stops after the effect size should have read the caveat already; putting it
 * last optimises the layout for someone who reads to the end, which is not who
 * this is for.
 */

export type InsightDetailScreenProps = {
  readonly insight: InsightRow;
  readonly evidence: readonly InsightEvidenceRow[];
};

export function InsightDetailScreen({ insight, evidence }: InsightDetailScreenProps): ReactNode {
  return (
    <Stack gap="5">
      <Stack gap="2">
        <Inline justify="between" align="center" wrap>
          <Text role="title-3" as="h1">
            {insight.title}
          </Text>
          <Inline gap="2" align="center">
            <Badge tone="neutral">{insight.method}</Badge>
            <Badge tone={insight.disposition === 'dismissed' ? 'neutral' : 'accent'}>
              {insight.disposition.replace(/_/gu, ' ')}
            </Badge>
          </Inline>
        </Inline>

        {insight.narrative !== null && (
          <Text role="body" tone="secondary">
            {insight.narrative}
          </Text>
        )}
      </Stack>

      {/* Before the numbers, on purpose. */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              What this does not prove
            </Text>
            <Text role="body-sm" as="p">
              {insight.limitations ??
                'No limitation was recorded. That is itself a defect — §10.6 makes the field required, and a finding without one should not have been surfaced.'}
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="flat">
        <CardBody>
          <Stack gap="2">
            <Row label="Method" value={insight.method} />
            {insight.effectSize !== null && <Row label="Effect size" value={insight.effectSize} />}
            {insight.pValue !== null && (
              <Row label="p-value" value={Number(insight.pValue).toPrecision(3)} />
            )}
            {insight.confidence !== null && (
              <Row label="Confidence" value={Number(insight.confidence).toFixed(3)} />
            )}
            {insight.surfacedAt !== null && (
              <Row label="Surfaced" value={insight.surfacedAt.slice(0, 10)} />
            )}
            {insight.actedOnAt !== null && <Row label="Acted on" value={insight.actedOnAt.slice(0, 10)} />}
            {insight.dismissedAt !== null && (
              <Row label="Dismissed" value={insight.dismissedAt.slice(0, 10)} />
            )}
            {insight.dismissReason !== null && <Row label="Reason given" value={insight.dismissReason} />}
          </Stack>
        </CardBody>
      </Card>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Evidence
        </Text>
        {evidence.length === 0 ? (
          /* Stated, not hidden. §9.2 makes the evidence table what turns an
             assertion into a finding, so its absence is worth naming. */
          <Text role="body-sm" tone="tertiary">
            No evidence rows were recorded for this insight, which means it cannot be traced back to the
            data that produced it.
          </Text>
        ) : (
          <Stack gap="1">
            {evidence.map((row) => (
              <Inline key={row.id} justify="between" align="center">
                <Text role="body-sm" as="span">
                  {row.note ?? row.entityId ?? row.observationId ?? '—'}
                </Text>
                <Text role="caption" tone="tertiary">
                  {row.role ?? row.entityType ?? ''}
                </Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Stack>

      <Divider />

      <Inline gap="3" wrap>
        <Link className="nos-inline-link" href="/insights">
          Back to the inbox
        </Link>
        <Link className="nos-inline-link" href="/insights/archive">
          Everything ever surfaced
        </Link>
      </Inline>
    </Stack>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Inline justify="between" align="center">
      <Text role="body-sm" tone="secondary">
        {label}
      </Text>
      <Text role="body-sm" as="span">
        {value}
      </Text>
    </Inline>
  );
}

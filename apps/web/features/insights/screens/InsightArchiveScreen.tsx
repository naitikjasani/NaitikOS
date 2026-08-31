'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Inline, Stack, Text } from '@naitikos/design-system';

import type { InsightRow } from '@/lib/platform/insights';

/**
 * `/life/insights/archive` — everything ever surfaced.
 *
 * ## Why the dismissed ones are kept
 *
 * §4.13 makes dismissals train the ranking, and a signal with no history is a
 * signal nothing can learn from. §9.4's soft-delete argument applies to a
 * derived row as much as a recorded one: the fact that the system raised
 * something in March and the operator found it useless is a fact about the
 * system.
 *
 * It is also the only page that answers "what has this actually told me" — and
 * a surface that hid its own misses would be reporting a hit rate of 100%.
 */

export function InsightArchiveScreen({ insights }: { readonly insights: readonly InsightRow[] }): ReactNode {
  const acted = insights.filter((entry) => entry.actedOnAt !== null).length;
  const dismissed = insights.filter((entry) => entry.dismissedAt !== null).length;

  return (
    <Stack gap="4">
      <Text role="caption" tone="tertiary">
        {insights.length === 0
          ? 'Nothing has been surfaced yet.'
          : `${String(insights.length)} surfaced · ${String(acted)} acted on · ${String(dismissed)} dismissed.`}
      </Text>

      <Stack gap="2">
        {insights.map((insight) => (
          <Inline key={insight.id} justify="between" align="center" wrap>
            <Stack gap="1">
              <Link className="nos-inline-link" href={`/life/insights/${insight.id}`}>
                {insight.title}
              </Link>
              <Text role="caption" tone="tertiary">
                {insight.method}
                {insight.surfacedAt === null ? '' : ` · ${insight.surfacedAt.slice(0, 10)}`}
                {insight.dismissReason === null ? '' : ` · “${insight.dismissReason}”`}
              </Text>
            </Stack>
            <Badge tone={insight.actedOnAt !== null ? 'accent' : 'neutral'}>
              {insight.disposition.replace(/_/gu, ' ')}
            </Badge>
          </Inline>
        ))}
      </Stack>
    </Stack>
  );
}

'use client';

/**
 * The timeline, read-only (§12 week 2).
 *
 * Read-only is not a stage of completion — it is the design. §3.3(R5) makes the
 * timeline "everything touching one entity", a *view over* the record rather
 * than a place the record is edited. An editable timeline would be a second
 * write path into an append-only log, which §9.1 does not permit and which the
 * database trigger would refuse anyway.
 *
 * ## What renders here comes from events, not from queries per domain
 *
 * The entries are projections of domain events (ADR 0005). That is why a Daily
 * Close appears on this screen without one line of Close-specific code in this
 * file: the Close emits, the projector writes an entry, and this renders
 * whatever entries exist.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardBody, EmptyState, ErrorState, Inline, LoadingState, Stack, Text } from '@naitikos/design-system';

import { queryKeys } from '@/lib/query/QueryProvider';

type TimelineEntryView = {
  readonly eventId: string;
  readonly eventType: string;
  readonly category: string;
  readonly occurredAt: string;
  readonly occurredOn: string;
  readonly title: string;
  readonly detail: string | null;
  readonly significance: string;
  readonly clinical: boolean;
};

type TimelineGroupView = {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly TimelineEntryView[];
};

type TimelinePageView = {
  readonly groups: readonly TimelineGroupView[];
  readonly hasMore: boolean;
};

async function fetchTimeline(params: Record<string, string>): Promise<TimelinePageView> {
  const query = new URLSearchParams(params);
  const response = await fetch(`/api/timeline?${query.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Timeline unavailable (${String(response.status)}).`);
  return (await response.json()) as TimelinePageView;
}

export type TimelineListProps = {
  readonly grouping?: 'day' | 'week' | 'month';
  readonly limit?: number;
};

export function TimelineList({ grouping = 'day', limit = 50 }: TimelineListProps): ReactNode {
  const params = { grouping, limit: String(limit) };
  const query = useQuery({
    queryKey: queryKeys.timeline(params),
    queryFn: () => fetchTimeline(params),
  });

  if (query.isLoading) return <LoadingState rows={5} label="Loading the timeline" />;

  if (query.error !== null) {
    return (
      <ErrorState
        title="The timeline could not be loaded"
        description="The record is fine — this view could not reach it."
      />
    );
  }

  const groups = query.data?.groups ?? [];

  if (groups.length === 0) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        description="Close a day, or capture something with c then m. Entries appear here automatically."
      />
    );
  }

  return (
    <Stack gap="6">
      {groups.map((group) => (
        <Stack gap="3" key={group.key}>
          {/*
            The day heading is an `h2` because the timeline is a list of days,
            and a screen reader navigating by heading should be able to move
            between them. §8.13 treats the document outline as a navigation
            surface rather than as styling.
          */}
          {/*
            The heading links to the expanded day when the grouping is by day —
            `group.key` is the day key in that case. §3.2's `/timeline/:date`
            shows the detail entries this view collapses, and the heading is
            where somebody looking at a day would reach for it.
          */}
          <Text role="title-3" as="h2">
            {grouping === 'day' ?
              <Link className="nos-inline-link" href={`/timeline/${group.key}`}>
                {group.label}
              </Link>
            : group.label}
          </Text>

          <Stack gap="2" as="ul">
            {group.entries.map((entry) => (
              <Card key={entry.eventId} variant="outlined" as="li">
                <CardBody>
                  <Stack gap="1">
                    <Inline gap="2">
                      <Text role="body">{entry.title}</Text>
                      {/*
                        §8.2 forbids colour as the only carrier of meaning, and
                        the clinical flag is the one distinction here that
                        actually matters — so it is a labelled badge rather than
                        a tint.
                      */}
                      {entry.clinical && <Badge tone="accent">Clinical</Badge>}
                    </Inline>

                    {entry.detail !== null && (
                      <Text role="body-sm" tone="secondary">
                        {entry.detail}
                      </Text>
                    )}
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Stack>
        </Stack>
      ))}

      {query.data?.hasMore === true && (
        <Text role="caption" tone="tertiary" as="p">
          Older entries are not shown. Paging arrives with the first domain that needs it.
        </Text>
      )}
    </Stack>
  );
}

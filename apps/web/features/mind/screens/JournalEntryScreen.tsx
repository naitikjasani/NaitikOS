'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { scaleLabel } from '@naitikos/core';
import { Card, CardBody, ErrorState, Inline, LoadingState, Stack, Text } from '@naitikos/design-system';

import { fetchJournalEntry } from '../services/mindClient';

/**
 * `/mind/journal/:id` — one entry, with its words.
 *
 * The only screen in the application that renders journal prose, and it renders
 * it read-only. Editing exists as an API capability — the repository upserts,
 * because adding a paragraph to yesterday's entry is a normal thing to do — but
 * the edit surface is not built, and shipping a read-only view is the honest
 * half to ship first.
 *
 * `staleTime: 0` and `gcTime: 0`: the entry leaves the query cache the moment
 * the screen unmounts. Combined with the route's `Cache-Control: no-store` and
 * the service worker's path exclusion, that is three layers keeping the most
 * sensitive data in the system out of every store that is not Postgres.
 */
export function JournalEntryScreen({ entryId }: { readonly entryId: string }): ReactNode {
  const entry = useQuery({
    queryKey: ['mind', 'journal', 'entry', entryId],
    queryFn: () => fetchJournalEntry(entryId),
    staleTime: 0,
    gcTime: 0,
  });

  if (entry.isLoading) return <LoadingState label="Loading" />;
  if (entry.error !== null) {
    return <ErrorState title="Could not open this entry" description="The record is intact; this view is not." />;
  }

  const data = entry.data;
  if (data === undefined) return null;

  const mood = data.moodAtWriting === null ? null : scaleLabel('mood', data.moodAtWriting);

  return (
    <Stack gap="4">
      <Stack gap="1">
        <Text role="title-2" as="h2">
          {data.title ?? 'Entry'}
        </Text>
        <Inline gap="2" align="center">
          <Text role="caption" tone="tertiary" as="span">
            {data.writtenAt.slice(0, 10)}
          </Text>
          {mood !== null && (
            <Text role="caption" tone="tertiary" as="span">
              · mood at writing: {mood.toLowerCase()}
            </Text>
          )}
        </Inline>
      </Stack>

      <Card variant="flat">
        <CardBody>
          {/* Their line breaks, kept. `nos-prewrap` is the whole of the styling. */}
          <Text role="body" className="nos-prewrap">
            {data.content}
          </Text>
        </CardBody>
      </Card>
    </Stack>
  );
}

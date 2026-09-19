'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MIND_SCALES } from '@naitikos/core';
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
 *
 * ## The prose is set in the serif, and that is the point of the screen
 *
 * §8.3 is explicit that the long-form family is not decoration: "a visual
 * mode-switch between *recording data* and *writing reflectively* is a genuine
 * cognitive cue, and journaling is a core Mind interaction." The composer has
 * had the serif since it shipped; this screen did not, which meant an entry was
 * written in one voice and read back in the interface font — the same face the
 * medication register and the adherence percentages are set in. Reading your own
 * reflection rendered as application chrome is a small thing that makes the
 * journal feel like a database row, and §13.3's severe risk is exactly that this
 * surface stops feeling like somewhere to write.
 *
 * ## The mood is a number, not a word
 *
 * `core` offers `scaleLabel`, and its vocabulary is defensible — "Low" describes
 * rather than judges. It is still the wrong call *here*. §8.2's rule that health
 * data is never coloured by valence has a copy half: a line reading "mood at
 * writing: low" above somebody's own words is the system's adjective sitting on
 * top of their paragraph. "2 of 5" is the reading they gave, said back to them
 * with nothing added, and the denominator is what makes it legible without one.
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

  const mood = data.moodAtWriting;

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
              · mood at writing {String(mood)} of {String(MIND_SCALES.mood.max)}
            </Text>
          )}
        </Inline>
      </Stack>

      <Card variant="flat">
        <CardBody>
          {/* Their line breaks, kept, in the family they were written in.
              `nos-prewrap` and the serif are the whole of the styling. */}
          <Text role="body" serif className="nos-prewrap">
            {data.content}
          </Text>
        </CardBody>
      </Card>

      {/*
        The missing half, said rather than left to be discovered.

        §3.3 R6 objects to screens that pretend to be finished, not to
        half-finished screens. Somebody who opens an entry to add a sentence and
        finds no cursor should learn why from the page, not from tapping at the
        paragraph — and the repository upserts, so this is a surface that has not
        been built rather than a capability that does not exist.
      */}
      <Text role="caption" tone="tertiary">
        Read-only for now. Entries can be added to, but that surface is not built yet.
      </Text>
    </Stack>
  );
}

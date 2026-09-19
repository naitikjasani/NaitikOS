'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, EmptyState, LoadingState, Stack, Text } from '@naitikos/design-system';

import { fetchMindOverview } from '../services/mindClient';

/**
 * `/mind/journal/prompts` — the guided prompts, all of them.
 *
 * ## The overview shows one; this shows the list
 *
 * `/mind` surfaces a single prompt, chosen by the service, because §4.7's
 * journal is meant to be opened and written in rather than browsed. A wall of
 * questions is a decision to make before writing, and the point of a prompt is
 * to remove exactly that decision on an evening when making one is hard.
 *
 * So this page exists for the other use: reading what the system might ask, in
 * a settled moment, and knowing the shape of it. That is a different act from
 * journalling, and it belongs on a different page.
 *
 * ## Nothing here is generated
 *
 * The prompts are seeded rows. §10.0 keeps the model out of asserting, and a
 * model-written prompt on a bad evening would be the system deciding what the
 * operator should be examining about themselves — which is a therapist's job,
 * on a good day, with consent.
 *
 * ## Nothing here is scored, ranked or marked as used
 *
 * There is no "you have not answered this one" and no completion state. §4.7's
 * no-negative-framing rule reaches here: an unanswered prompt is not a debt,
 * and a list that tracked which had been used would turn a set of questions
 * into a checklist with a guilt gradient.
 *
 * ## The prompts are set in the long-form serif
 *
 * §8.3's mode-switch cue, applied to the questions as well as the answers. A
 * prompt is the first line of a piece of writing rather than a label on a
 * control, and setting it in the interface font puts it in the same voice as
 * the medication register. The reader should be able to tell, before reading a
 * word, which part of the application they are in.
 */
export function PromptsScreen({
  zone,
  fromDayKey,
  toDayKey,
}: {
  readonly zone: string;
  readonly fromDayKey: string;
  readonly toDayKey: string;
}): ReactNode {
  /*
   * Read through the overview rather than a prompts endpoint of its own.
   * `/api/mind/overview` already returns them, and a second endpoint returning
   * the same seeded rows would be a second thing to keep in step for a list
   * that changes when the seed does.
   */
  const overview = useQuery({
    queryKey: ['mind', 'overview', fromDayKey, toDayKey, zone],
    queryFn: () => fetchMindOverview(fromDayKey, toDayKey, zone),
  });

  if (overview.isPending) return <LoadingState label="Reading the prompts" />;
  if (overview.data === undefined) {
    return <EmptyState title="Could not read the prompts" description="Nothing was changed." />;
  }

  const { prompt, promptLibrary } = overview.data;
  const rest = promptLibrary.filter((entry) => entry.id !== prompt?.id);

  return (
    <Stack gap="4">
      {promptLibrary.length === 0 ?
        <EmptyState
          title="No prompts on file"
          description="Prompts are seeded rows rather than generated ones. If this is empty, the seed has not run."
        />
      : <Stack gap="4">
          {prompt !== null && (
            <Card variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Text role="caption" tone="tertiary">
                    Tonight&rsquo;s prompt
                  </Text>
                  <Text role="body" serif>
                    {prompt.prompt}
                  </Text>
                  {prompt.category !== null && (
                    <Text role="caption" tone="tertiary">
                      {prompt.category}
                    </Text>
                  )}
                </Stack>
              </CardBody>
            </Card>
          )}

          <Card variant="outlined">
            <CardBody>
              <Stack gap="3">
                <Text role="title-3" as="h2">
                  The rest
                </Text>
                {rest.map((entry) => (
                  <Stack key={entry.id} gap="1">
                    <Text role="body" serif>
                      {entry.prompt}
                    </Text>
                    {entry.category !== null && (
                      <Text role="caption" tone="tertiary">
                        {entry.category}
                      </Text>
                    )}
                  </Stack>
                ))}
              </Stack>
            </CardBody>
          </Card>
        </Stack>
      }

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="body-sm" tone="secondary">
              A prompt is a way in, not a form. Nothing tracks which you have answered, and an unanswered one is
              not owed.
            </Text>
            {/*
              A button, not a caption link. This is the only action on the page
              and the whole reason for reading it, and a 12px link is under
              §8.13's 44px minimum — which matters most on the evenings the page
              gets opened. `asChild` keeps the anchor semantics, so
              open-in-new-tab and middle-click still behave.
            */}
            <div>
              <Button variant="secondary" asChild>
                <Link href="/mind/journal">Write an entry</Link>
              </Button>
            </div>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

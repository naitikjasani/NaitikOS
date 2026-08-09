'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { promptForDay, systemClock, wordCount } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { fetchJournalIndex, logJournalEntry } from '../services/mindClient';

/**
 * `/mind/journal` — write, and a list of what has been written.
 *
 * ## The list shows headings, never prose
 *
 * The list is titles and word counts. §4.7 calls journal content the most
 * sensitive data in the system, and the obvious design — date, first hundred
 * and twenty characters, chevron — puts the darkest thing the operator has ever
 * written on screen the moment they open the tab, on a train, at work.
 *
 * The enforcement is three layers down, not here: `journalList` in the
 * repository does not select `content`, so this component *could not* render an
 * excerpt if someone added one. That is deliberate — a rule enforced in a
 * component is a rule that survives until the next component.
 *
 * ## The prompt is an offer, not a form
 *
 * Today's prompt sits above the box as a sentence. Tapping it puts nothing in
 * the box. A prompt that pre-filled the textarea would make the operator delete
 * something before writing, and the blank page is easier to face than someone
 * else's opening line.
 */

export function JournalScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const index = useQuery({ queryKey: ['mind', 'journal'], queryFn: fetchJournalIndex });

  const prompt = promptForDay(index.data?.prompts ?? [], dayKey);

  const write = useMutation({
    mutationFn: async () => {
      await logJournalEntry({
        id: uuidV7(systemClock.nowMillis()),
        writtenAt: nowIso,
        zone,
        title: title.trim() === '' ? null : title.trim(),
        content,
        promptId: prompt?.id ?? null,
      });
    },
    onSuccess: async () => {
      setTitle('');
      setContent('');
      await queryClient.invalidateQueries({ queryKey: ['mind', 'journal'] });
    },
  });

  const words = wordCount(content);

  return (
    <Stack gap="5">
      <Card variant="raised">
        <CardBody>
          <Stack gap="3">
            {prompt !== null && (
              <Text role="body-sm" tone="secondary">
                {prompt.prompt}
              </Text>
            )}

            <TextField
              label="Title (optional)"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />

            <TextAreaField
              label="Entry"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
              }}
              rows={10}
              /* §8.3's long-form serif. This is the one field in the system
                 that is read as prose rather than scanned as data. */
              serif
              {...(words === 0
                ? {}
                : { hint: `${String(words)} ${words === 1 ? 'word' : 'words'}` })}
            />

            <Inline justify="between" align="center">
              <Text role="caption" tone="tertiary">
                Stays on this device until it syncs. Never sent to any model.
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  write.mutate();
                }}
                disabled={content.trim() === '' || write.isPending}
              >
                Save
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {index.isLoading ? (
        <LoadingState label="Loading entries" />
      ) : (index.data?.entries.length ?? 0) === 0 ? (
        <EmptyState
          icon="domain.journal"
          title="No entries yet"
          description="Entries appear here as headings and word counts. Opening one is a deliberate act."
        />
      ) : (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Entries
          </Text>
          {(index.data?.entries ?? []).map((entry) => (
            <Card key={entry.id} variant="outlined">
              <CardBody>
                <Link className="nos-card__link" href={`/mind/journal/${entry.id}`}>
                  <Inline justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {entry.heading}
                    </Text>
                    <Text role="caption" tone="tertiary" as="span">
                      {entry.dayKey}
                    </Text>
                  </Inline>
                </Link>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

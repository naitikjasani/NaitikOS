'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import { Button, Card, CardBody, EmptyState, Inline, Stack, TextField, Text } from '@naitikos/design-system';

import type { EnquiryBoard } from '@/lib/platform/enquiry';
import { saveThread } from '../services/askClient';

/**
 * The saved lines of enquiry, listed above the Ask box.
 *
 * ## A thread is created before it is asked, not after
 *
 * There is no "save this answer to a thread" button, and the absence is the
 * design. Saving after the fact makes every answer a candidate for keeping,
 * which turns the surface into a chat log with a filter on it. Naming the
 * enquiry *first* forces the question §4.13 says this surface is for — what am
 * I actually trying to find out — and that question is worth more than any one
 * answer to it.
 *
 * It also means a thread can sit here unasked, which is a legitimate way to use
 * this: a line of enquiry you have not got to yet is still a line of enquiry.
 *
 * ## The list is ordered by when it was last pursued
 *
 * Not by creation, and not alphabetically. An unasked thread sorts last, because
 * a placeholder from six months ago is not more urgent than something answered
 * this morning.
 */
export function ThreadListScreen({ board }: { readonly board: EnquiryBoard }): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      await saveThread({
        id: uuidV7(systemClock.nowMillis()),
        title: title.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setTitle('');
      setNote('');
      setAdding(false);
      setProblem(null);
      router.refresh();
    },
    onError: () => {
      setProblem('Could not save that thread.');
    },
  });

  return (
    <Stack gap="3">
      <Inline gap="2" align="center" justify="between">
        <Text role="title-3" as="h2">
          Lines of enquiry
        </Text>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setAdding((open) => !open);
          }}
        >
          {adding ? 'Cancel' : 'New'}
        </Button>
      </Inline>

      {adding && (
        <Stack gap="2">
          <TextField
            label="What are you trying to find out?"
            hint="Named first, on purpose — the enquiry outlives any one phrasing of it."
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <TextField
            label="Why it matters"
            hint="Optional, and usually the part worth reading a year later."
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <Inline gap="2">
            <Button
              size="sm"
              disabled={title.trim() === '' || create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              Save
            </Button>
          </Inline>
        </Stack>
      )}

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {board.threads.length === 0 ?
        !adding && (
          <EmptyState
            title="No saved enquiries"
            description="Ask below and the answer is forgotten, which is usually right. A thread is for the question you will come back to in three months."
          />
        )
      : <Stack gap="2">
          {board.threads.map((thread) => (
            <Card key={thread.id} variant="interactive">
              <CardBody>
                <Link href={`/ask/${thread.id}`} className="nos-card__link">
                  <Inline justify="between" align="baseline">
                    <Stack gap="0">
                      <Text role="body">{thread.title}</Text>
                      {thread.note !== null && (
                        <Text role="caption" tone="tertiary">
                          {thread.note}
                        </Text>
                      )}
                    </Stack>
                    <Text role="caption" tone="tertiary">
                      {thread.turnCount === 0 ?
                        'not yet asked'
                      : `${String(thread.turnCount)} ${thread.turnCount === 1 ? 'question' : 'questions'} · ${thread.lastAskedAt?.slice(0, 10) ?? ''}`
                      }
                    </Text>
                  </Inline>
                </Link>
              </CardBody>
            </Card>
          ))}
        </Stack>
      }
    </Stack>
  );
}

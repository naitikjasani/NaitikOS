'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { LEARNING_KIND_LABELS, LEARNING_STATUS_LABELS, systemClock } from '@naitikos/core';
import { Badge, Button, Card, CardBody, EmptyState, Inline, Stack, Text, TextAreaField } from '@naitikos/design-system';

import type { LearningBoard } from '@/lib/platform/learning';
import { addLearningNote } from '../services/learningClient';

/*
 * Re-declared rather than imported. The row shape lives in `@naitikos/db`, and
 * a client component that imported it would pull the database package into the
 * browser bundle.
 */
type LearningNote = {
  readonly id: string;
  readonly learningItemId: string;
  readonly content: string;
  readonly createdAt: string;
};

/**
 * `/work/learning/notes` — §4.8's "notes, synthesis".
 *
 * ## These are rows in the shared `note` table
 *
 * A reading note is stored polymorphically, under `entity_type =
 * 'learning_item'`, in the same table that carries notes on everything else.
 * §P3 — new lenses, not new systems. A second notes implementation would be a
 * second search index to keep in step, a second export path, a second set of
 * soft-delete semantics, and the first time one of the three drifted nobody
 * would find out from a test.
 *
 * ## `ai_consent` is `none`
 *
 * The column default, and the repository states it explicitly rather than
 * inheriting it. §10.10 makes sharing a deliberate act: a note is the
 * operator's own thinking about something they read, and nothing that reaches
 * a model should arrive there because a default was left alone.
 *
 * ## Grouped by what was read, ordered by when it was written
 *
 * Newest first within an item, and the items themselves ordered by their most
 * recent note. Notes on one book belong together — the reason to open this page
 * is usually "what did I think about that", not "what did I write on Tuesday".
 */
export function LearningNotesScreen({ board }: { readonly board: LearningBoard }): ReactNode {
  const router = useRouter();

  /*
   * Sorted here rather than trusted from the loader. The order is part of what
   * this screen claims, so it states it rather than inheriting one that a query
   * change elsewhere could quietly reverse. ISO-8601 instants sort as strings.
   */
  const newestFirst = [...board.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const groups = new Map<string, LearningNote[]>();
  for (const entry of newestFirst) {
    const bucket = groups.get(entry.learningItemId);
    if (bucket === undefined) {
      groups.set(entry.learningItemId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return (
    <Stack gap="6">
      <Compose
        board={board}
        onSaved={() => {
          router.refresh();
        }}
      />

      {groups.size === 0 ? (
        <EmptyState
          title="No notes yet"
          description="A sentence written while reading outlives the reading. This is where those go."
        />
      ) : (
        [...groups.entries()].map(([itemId, notes]) => {
          const item = board.items.find((entry) => entry.id === itemId);
          return (
            <Stack key={itemId} gap="2">
              <Inline gap="3" align="center" justify="between">
                <Text role="title-3" as="h2">
                  {/* An item can be soft-deleted while its notes remain. Named
                      as unknown rather than dropped — a note nobody can find is
                      worse than one filed under a missing title. */}
                  {item?.title ?? 'An item no longer in the queue'}
                </Text>
                {item !== undefined && (
                  <Badge tone="neutral">{LEARNING_STATUS_LABELS[item.status]}</Badge>
                )}
              </Inline>
              {item !== undefined && (
                <Text role="caption" tone="tertiary">
                  {LEARNING_KIND_LABELS[item.kind]}
                  {item.author === null ? '' : ` · ${item.author}`}
                </Text>
              )}
              {notes.map((entry) => (
                <Card key={entry.id} variant="outlined">
                  <CardBody>
                    <Stack gap="1">
                      <Text role="body" tone="secondary">
                        {entry.content}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {entry.createdAt.slice(0, 10)}
                      </Text>
                    </Stack>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          );
        })
      )}
    </Stack>
  );
}

function Compose({
  board,
  onSaved,
}: {
  readonly board: LearningBoard;
  readonly onSaved: () => void;
}): ReactNode {
  const [itemId, setItemId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (input: { readonly itemId: string; readonly content: string }) => {
      await addLearningNote({
        id: uuidV7(systemClock.nowMillis()),
        learningItemId: input.itemId,
        content: input.content,
      });
    },
    onSuccess: () => {
      setContent('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that note.');
    },
  });

  if (board.items.length === 0) {
    return (
      <EmptyState
        title="Nothing to take notes on"
        description="A note hangs off something in the queue. Add a book, a paper or a course first."
      />
    );
  }

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              On what
            </Text>
            <Inline gap="2" wrap>
              {board.items.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={item.id === itemId ? 'primary' : 'secondary'}
                  aria-pressed={item.id === itemId}
                  onClick={() => {
                    setItemId(item.id === itemId ? null : item.id);
                  }}
                >
                  {item.title}
                </Button>
              ))}
            </Inline>
          </Stack>

          <TextAreaField
            label="Note"
            rows={5}
            hint="Yours. Nothing here is shared with a model unless you say so — §10.10."
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
            }}
          />

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={itemId === null || content.trim() === '' || save.isPending}
              onClick={() => {
                /* Narrowed rather than asserted; the button is disabled without
                 * a selection, and a non-null assertion would encode that
                 * coupling in a place a later edit would not check. */
                if (itemId === null) return;
                save.mutate({ itemId, content: content.trim() });
              }}
            >
              Save the note
            </Button>
            <Text role="caption" tone="tertiary">
              Needs a connection — notes are not queued offline.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, Divider, EmptyState, Inline, Spinner, Stack, Text, TextAreaField } from '@naitikos/design-system';

import type { ThreadDetail, ThreadTurn } from '@/lib/platform/enquiry';
import { askQuestion, deleteTurn } from '../services/askClient';
import { AnsweredParagraph, UnresolvedNote } from '../components/AnsweredParagraph';

/**
 * `/ask/:threadId` — §3.2's "a saved line of enquiry".
 *
 * ## It looks like a thread and is not a conversation
 *
 * The turns are stacked newest-first and each one is answered independently.
 * **No prior turn is ever sent back to the model.** Feeding a model its own
 * output makes it reason over its own assertions rather than over the record,
 * which is precisely what §10.0 forbids — and it is the single most tempting
 * thing to add to a page shaped like this one.
 *
 * The consequence the interface has to be honest about: asking a follow-up here
 * is asking a *new question*, and it will not know what the last one said. The
 * caption under the box says so, because a user who assumes otherwise will
 * write "and what about the week before?" and get a confused answer with no
 * indication why.
 *
 * ## Old answers are re-rendered, not replayed
 *
 * A stored turn holds templates and reference ids. The figures are resolved
 * against the log every time this page opens, so §9.1's supersession works in
 * the operator's favour: an answer from March renders March's figure until that
 * observation is corrected, and then says it has been. This is the surface
 * where that behaviour earns its keep, because it is the only one that shows
 * answers old enough for the record to have moved underneath them.
 *
 * ## A turn with no answer is kept and shown
 *
 * "I asked this in April and the layer was off" is part of a line of enquiry.
 * Hiding it would make the thread look unpursued, which is the opposite of what
 * the page is for.
 */
export function ThreadScreen({ detail }: { readonly detail: ThreadDetail }): ReactNode {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const ask = (): void => {
    const trimmed = question.trim();
    if (trimmed.length < 3 || busy) return;

    setBusy(true);
    setProblem(null);
    void askQuestion(trimmed, detail.thread.id)
      .then(() => {
        setQuestion('');
        router.refresh();
      })
      .catch(() => {
        setProblem('Could not reach the answer. Every figure in the app is computed without a model and is unaffected.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await deleteTurn(id, null);
    },
    onSuccess: () => {
      router.refresh();
    },
    onError: () => {
      setProblem('Could not remove that turn.');
    },
  });

  return (
    <Stack gap="5">
      {detail.thread.note !== null && (
        <Text role="body-sm" tone="secondary">
          {detail.thread.note}
        </Text>
      )}

      <Stack gap="2">
        <TextAreaField
          label="Ask"
          labelHidden
          rows={3}
          placeholder="Ask another question in this line of enquiry"
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
        />
        <Inline gap="2" align="center">
          <Button size="sm" disabled={question.trim().length < 3 || busy} onClick={ask}>
            {busy ? 'Asking' : 'Ask'}
          </Button>
          {busy && <Spinner size="sm" label="Assembling context" />}
        </Inline>
        <Text role="caption" tone="tertiary">
          {/*
            The honest statement of what a thread is. A user who assumes
            otherwise writes "and what about the week before?" and gets a
            confused answer with no indication why.
          */}
          Each question is answered from your record alone. Nothing said above is sent back to the model, so
          a follow-up has to stand on its own.
        </Text>
        {problem !== null && (
          <Text role="body-sm" tone="critical">
            {problem}
          </Text>
        )}
      </Stack>

      {detail.turns.length === 0 ?
        <EmptyState
          title="Nothing asked yet"
          description="A thread can sit here as a question you have not got to. Ask when you want to; the answers stack up underneath."
        />
      : <Stack gap="4">
          {detail.turns.map((turn) => (
            <Turn
              key={turn.id}
              turn={turn}
              onRemove={() => {
                remove.mutate(turn.id);
              }}
            />
          ))}
        </Stack>
      }
    </Stack>
  );
}

function Turn({ turn, onRemove }: { readonly turn: ThreadTurn; readonly onRemove: () => void }): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" justify="between" align="baseline">
            <Text role="title-3" as="h2">
              {turn.question}
            </Text>
            <Inline gap="2" align="center">
              <Badge tone="neutral">{turn.askedAt.slice(0, 10)}</Badge>
              <Button size="sm" variant="ghost" onClick={onRemove}>
                Remove
              </Button>
            </Inline>
          </Inline>

          {turn.unreadable ?
            /*
             * The stored answer no longer parses. A row from years back may
             * predate whatever `answerSchema` looks like now, and the question
             * is the operator's while the answer was the model's — so the
             * question stays legible and the answer says what happened to it.
             */
            <Text role="body-sm" tone="tertiary">
              The stored answer cannot be read against the current format. The question is kept; the answer is
              not recoverable.
            </Text>
          : turn.problem !== null ?
            <Text role="body-sm" tone="tertiary">
              {turn.problem}
            </Text>
          : turn.answerable ?
            <Stack gap="3">
              {turn.paragraphs.map((paragraph, index) => (
                <AnsweredParagraph key={index} paragraph={paragraph} />
              ))}
            </Stack>
          : <Text role="body" as="p">
              There was not enough in the record to answer that.
            </Text>
          }

          {(turn.omitted !== null || turn.unresolvedReferences > 0) && (
            <>
              <Divider />
              <Stack gap="1">
                {turn.omitted !== null && (
                  /* §10.4: never silently truncate. Stored with the answer it
                     qualifies, so an old turn still says what it did not read. */
                  <Text role="caption" tone="tertiary">
                    {turn.omitted}
                  </Text>
                )}
                <UnresolvedNote count={turn.unresolvedReferences} />
                <Text role="caption" tone="tertiary">
                  Read over the {String(turn.windowDays)} days before it was asked.
                </Text>
              </Stack>
            </>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

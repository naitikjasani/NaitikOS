'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { MAX_QUESTIONS, describeWhen, formatDay, mergeQuestions } from '@naitikos/core';
import type { AppointmentQuestion } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
} from '@naitikos/design-system';

import type { AppointmentPreparation } from '@/lib/platform/health';
import { recordVisitNotes, saveQuestions } from '../services/healthClient';

/**
 * The pre-visit question list — P5's deliverable, and the thing this whole
 * module exists to produce.
 *
 *   "The deliverable of a medical insight is *a better question for your next
 *    appointment*, printed and ready."
 *
 * ## Every line is a question, and none is advice
 *
 * The derivation states an observation and then asks. Nothing on this screen
 * proposes a dose, a supplement, or a course of action, because P5 draws that
 * line and because this system has no standing to cross it. What it has is the
 * record, and fifteen minutes is not long enough to remember it unaided.
 *
 * ## The list is capped, and says what it left off
 *
 * At {@link MAX_QUESTIONS}. A list of thirty questions is a list that gets
 * folded into a pocket and not read; what was cut is stated rather than hidden,
 * so the operator can go and look if they want to.
 *
 * ## Saved questions are not reordered by a re-derivation
 *
 * `mergeQuestions` appends new findings after whatever is already on the list.
 * The operator has read the top of it; reordering under them is how a prepared
 * list stops being trusted the week it matters.
 */
export function AppointmentPrepScreen({
  preparation,
  nowIso,
}: {
  readonly preparation: AppointmentPreparation;
  readonly nowIso: string;
}): ReactNode {
  const router = useRouter();
  const { appointment, saved, derived } = preparation;

  const [list, setList] = useState<readonly AppointmentQuestion[]>(saved);
  const [own, setOwn] = useState('');
  const [notes, setNotes] = useState(appointment.postVisitNotes ?? '');
  const [savedAt, setSavedAt] = useState(false);

  const persist = useMutation({
    mutationFn: async (questions: readonly AppointmentQuestion[]) => {
      await saveQuestions(appointment.id, questions);
    },
    onSuccess: () => {
      setSavedAt(true);
      router.refresh();
    },
  });

  const persistNotes = useMutation({
    mutationFn: async () => {
      await recordVisitNotes({
        id: appointment.id,
        attendedAt: appointment.attendedAt,
        postVisitNotes: notes.trim() === '' ? null : notes.trim(),
        outcome: null,
      });
    },
    onSuccess: () => {
      router.refresh();
    },
  });

  const onList = new Set(list.map((question) => question.id));
  const available = derived.questions.filter((question) => !onList.has(question.id));
  const isPast = appointment.scheduledFor !== null && appointment.scheduledFor < nowIso;

  return (
    <Stack gap="6">
      <Card variant="raised">
        <CardBody>
          <Stack gap="1">
            <Text role="title-3" as="h2">
              {appointment.title}
            </Text>
            <Text role="caption" tone="tertiary">
              {appointment.scheduledFor === null
                ? 'Not scheduled'
                : `${formatDay(appointment.scheduledFor) ?? ''} · ${describeWhen(appointment, nowIso) ?? ''}`}
              {appointment.provider === null ? '' : ` · ${appointment.provider}`}
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Stack gap="3">
        <Inline justify="between" align="center">
          <Text role="title-3" as="h2">
            Questions to ask
          </Text>
          <Text role="caption" tone="tertiary" aria-live="polite">
            {savedAt ? 'Saved.' : ''}
          </Text>
        </Inline>

        {list.length === 0 ? (
          <Text role="body-sm" tone="secondary">
            Nothing on the list yet. Add from the suggestions below, or write your own.
          </Text>
        ) : (
          <Stack gap="2">
            {list.map((question, index) => (
              <Card key={question.id} variant="outlined">
                <CardBody>
                  <Stack gap="2">
                    <Inline gap="2" align="start">
                      <Text role="body" as="span" tone="secondary">
                        {index + 1}.
                      </Text>
                      <Text role="body" as="span">
                        {question.question}
                      </Text>
                    </Inline>
                    {question.evidence !== '' && (
                      <Text role="caption" tone="tertiary">
                        {question.evidence}
                      </Text>
                    )}
                    <Inline justify="end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = list.filter((entry) => entry.id !== question.id);
                          setList(next);
                          setSavedAt(false);
                          persist.mutate(next);
                        }}
                      >
                        Remove
                      </Button>
                    </Inline>
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Stack>
        )}

        <Card variant="flat">
          <CardBody>
            <Stack gap="2">
              <TextAreaField
                label="Your own question"
                value={own}
                rows={2}
                onChange={(event) => {
                  setOwn(event.target.value);
                }}
                hint="Anything the record does not know about."
              />
              <Inline justify="end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={own.trim() === ''}
                  onClick={() => {
                    const next = [
                      ...list,
                      {
                        /* Prefixed so it can never collide with a derived id,
                         * which is what keeps `mergeQuestions` from treating a
                         * hand-written question as a re-derivation. */
                        id: `manual:${String(list.length + 1)}:${own.trim().slice(0, 24)}`,
                        question: own.trim(),
                        evidence: '',
                        source: 'manual' as const,
                        sourceId: null,
                      },
                    ];
                    setList(next);
                    setOwn('');
                    setSavedAt(false);
                    persist.mutate(next);
                  }}
                >
                  Add
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      </Stack>

      <Stack gap="3">
        <Text role="title-3" as="h2">
          From your record
        </Text>

        {available.length === 0 ? (
          <EmptyState
            icon="domain.clinical"
            size="sm"
            title="Nothing to suggest"
            description="Out-of-range results, unmentioned side effects, adherence counts and recurring symptoms appear here when there are any."
          />
        ) : (
          <Stack gap="2">
            {available.map((question) => (
              <Card key={question.id} variant="flat">
                <CardBody>
                  <Stack gap="2">
                    <Text role="body" as="span">
                      {question.question}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {question.evidence}
                    </Text>
                    <Inline justify="end">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          const next = mergeQuestions(list, [question]);
                          setList(next);
                          setSavedAt(false);
                          persist.mutate(next);
                        }}
                      >
                        Add to list
                      </Button>
                    </Inline>
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Stack>
        )}

        {derived.omitted > 0 && (
          <Text role="caption" tone="tertiary">
            {derived.omitted === 1
              ? 'One more was found and left off — the list is capped at eight, because a longer one does not get read in the room.'
              : `${String(derived.omitted)} more were found and left off — the list is capped at ${String(MAX_QUESTIONS)}, because a longer one does not get read in the room.`}
          </Text>
        )}
      </Stack>

      {isPast && (
        <Stack gap="3">
          <Text role="title-3" as="h2">
            What was said
          </Text>
          <TextAreaField
            label="Notes from the visit"
            labelHidden
            value={notes}
            rows={6}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
            hint="In your words. Nothing here is ever sent to a model."
          />
          <Inline justify="end">
            <Button
              variant="primary"
              disabled={persistNotes.isPending}
              onClick={() => {
                persistNotes.mutate();
              }}
            >
              Save notes
            </Button>
          </Inline>
        </Stack>
      )}
    </Stack>
  );
}

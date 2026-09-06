'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  INTERACTION_KINDS,
  INTERACTION_LABELS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  isoFromMillis,
  systemClock,
} from '@naitikos/core';
import type { ContactState, InteractionKind, PersonWithStatus, RelationshipKind } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  NumberField,
  SegmentedControl,
  Stack,
  TextAreaField,
  TextField,
  Text,
} from '@naitikos/design-system';

import type { PeopleBoard } from '@/lib/platform/social';
import { recordInteraction, savePerson } from '../services/socialClient';

/**
 * `/life/people` — §3.2's "People & relationships".
 *
 * ## One question, asked plainly
 *
 * **Who have I not spoken to.** The list is ordered by that and nothing else.
 * There is no grid of cards, no relationship graph and no activity feed; the
 * page is a list of names with a number of days beside each, because that is
 * the entire content and dressing it up would only make the number harder to
 * read.
 *
 * ## "Overdue" is about a number, not about a friendship
 *
 * The word is doing a lot of work and the copy has to be careful with it. What
 * the system knows is that more days have passed than the operator said they
 * wanted. It does not know about the message sent from a phone, the afternoon
 * nobody logged, or the fact that this is simply how the two of them are. So
 * the badge says how long it has been and the caption says what it is measured
 * against — never "you are neglecting this person".
 *
 * ## Nothing is stored about the person that they could not read over a shoulder
 *
 * No contact details, no rating, no year of birth. The schema file records the
 * reasoning: unlike every other row in this database, the subject here is not
 * the operator, and that person will never see this row or be able to correct
 * it. The form has no fields for those things, which is a stronger guarantee
 * than a form that declines to save them.
 */
export function PeopleScreen({ board, zone }: { readonly board: PeopleBoard; readonly zone: string }): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [logging, setLogging] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const onError = (error: unknown): void => {
    setProblem(error instanceof Error ? error.message : 'That did not save.');
  };

  const log = useMutation({
    mutationFn: async (input: { personId: string; kind: InteractionKind; note: string }) => {
      await recordInteraction({
        id: uuidV7(systemClock.nowMillis()),
        personId: input.personId,
        kind: input.kind,
        occurredAt: isoFromMillis(systemClock.nowMillis()),
        zone,
        note: input.note.trim() === '' ? null : input.note.trim(),
      });
    },
    onSuccess: () => {
      setLogging(null);
      setProblem(null);
      refresh();
    },
    onError,
  });

  return (
    <Stack gap="5">
      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {board.birthdays.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Birthdays
              </Text>
              {board.birthdays.map((entry) => (
                <Inline key={entry.person.id} gap="3" justify="between" align="baseline">
                  <Text role="body">{entry.person.name}</Text>
                  <Text role="body-sm" tone="secondary">
                    {entry.inDays === 0 ? 'Today' : `in ${String(entry.inDays)} days`}
                  </Text>
                </Inline>
              ))}
              <Text role="caption" tone="tertiary">
                The next {String(board.birthdayHorizonDays)} days. Only the day and month are stored.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                People
              </Text>
              <Button size="sm" variant="secondary" onClick={() => { setAdding((open) => !open); }}>
                {adding ? 'Cancel' : 'Add someone'}
              </Button>
            </Inline>

            {adding && (
              <PersonForm
                onDone={() => {
                  setAdding(false);
                  refresh();
                }}
                onError={onError}
              />
            )}

            {board.people.length === 0 ?
              <EmptyState
                title="Nobody here yet"
                description="Add someone and, if it matters, how often you want to be in touch. Without a cadence this page has nothing to measure against and will say so rather than guess."
              />
            : <Stack gap="2">
                {board.people.map((entry) => (
                  <PersonRow
                    key={entry.person.id}
                    entry={entry}
                    isLogging={logging === entry.person.id}
                    onToggleLog={() => {
                      setLogging((open) => (open === entry.person.id ? null : entry.person.id));
                    }}
                    onLog={(kind, note) => {
                      log.mutate({ personId: entry.person.id, kind, note });
                    }}
                  />
                ))}
              </Stack>
            }

            <Text role="caption" tone="tertiary">
              {String(board.tracked)} of {String(board.people.length)} have a cadence set. The rest are listed
              without a status, because nothing has been said about how often is often enough.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

/** Words for a state, and a tone. Deliberately flat — see the screen header. */
const STATE_COPY: Readonly<Record<ContactState, { label: string; tone: 'neutral' | 'caution' | 'positive' }>> =
  Object.freeze({
    overdue: { label: 'Overdue', tone: 'caution' },
    due: { label: 'Due', tone: 'caution' },
    never: { label: 'Not yet logged', tone: 'neutral' },
    current: { label: 'In touch', tone: 'positive' },
    untracked: { label: 'No cadence', tone: 'neutral' },
  });

function PersonRow({
  entry,
  isLogging,
  onToggleLog,
  onLog,
}: {
  readonly entry: PersonWithStatus;
  readonly isLogging: boolean;
  readonly onToggleLog: () => void;
  readonly onLog: (kind: InteractionKind, note: string) => void;
}): ReactNode {
  const [kind, setKind] = useState<InteractionKind>('message');
  const [note, setNote] = useState('');
  const copy = STATE_COPY[entry.status.state];

  return (
    <Stack gap="2">
      <Inline gap="3" justify="between" align="baseline">
        <Stack gap="0">
          <Text role="body">{entry.person.name}</Text>
          <Text role="caption" tone="tertiary">
            {RELATIONSHIP_LABELS[entry.person.relationship]}
            {entry.person.context === null ? '' : ` · ${entry.person.context}`}
          </Text>
        </Stack>
        <Inline gap="2" align="center">
          <Stack gap="0" align="end">
            <Badge tone={copy.tone}>{copy.label}</Badge>
            <Text role="caption" tone="tertiary">
              {describeGap(entry)}
            </Text>
          </Stack>
          <Button size="sm" variant="ghost" onClick={onToggleLog}>
            {isLogging ? 'Close' : 'Log contact'}
          </Button>
        </Inline>
      </Inline>

      {isLogging && (
        <Stack gap="2">
          <SegmentedControl<InteractionKind>
            label="How"
            value={kind}
            onValueChange={setKind}
            size="sm"
            options={INTERACTION_KINDS.map((value) => ({ value, label: INTERACTION_LABELS[value] }))}
          />
          <TextAreaField
            label="Note"
            hint="Optional, and about you rather than them — what you want to remember, not what was said."
            rows={2}
            value={note}
            onChange={(event) => { setNote(event.target.value); }}
          />
          <Inline gap="2">
            <Button
              size="sm"
              onClick={() => {
                onLog(kind, note);
                setNote('');
              }}
            >
              Record it
            </Button>
          </Inline>
          <Text role="caption" tone="tertiary">
            Recorded as now, in your current time zone. The day it is filed under is worked out from those two.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * The line under the badge.
 *
 * States the gap and what it is measured against, in that order, so the number
 * is never presented as a verdict on its own.
 */
function describeGap(entry: PersonWithStatus): string {
  const { state, daysSince } = entry.status;
  if (state === 'never') return 'no contact recorded';
  if (daysSince === null) return '';

  const gap = daysSince === 0 ? 'today' : daysSince === 1 ? '1 day ago' : `${String(daysSince)} days ago`;
  const cadence = entry.person.cadenceDays;
  return cadence === null ? gap : `${gap} · aiming for every ${String(cadence)}`;
}

function PersonForm({
  onDone,
  onError,
}: {
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState<RelationshipKind>('friend');
  const [context, setContext] = useState('');
  const [birthday, setBirthday] = useState('');
  const [cadenceDays, setCadenceDays] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await savePerson({
        id: uuidV7(systemClock.nowMillis()),
        name,
        relationship,
        context: context.trim() === '' ? null : context.trim(),
        birthday: birthday.trim() === '' ? null : birthday.trim(),
        cadenceDays,
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <TextField
        label="Name"
        hint="Whatever you call them."
        value={name}
        onChange={(event) => { setName(event.target.value); }}
      />
      <SegmentedControl<RelationshipKind>
        label="Relationship"
        value={relationship}
        onValueChange={setRelationship}
        size="sm"
        options={RELATIONSHIP_KINDS.map((value) => ({ value, label: RELATIONSHIP_LABELS[value] }))}
      />
      <TextField
        label="How you know them"
        hint="Optional. About the connection, not about them."
        value={context}
        onChange={(event) => { setContext(event.target.value); }}
      />
      <TextField
        label="Birthday"
        hint="Optional, as --MM-DD. Only the day and month; the year is not stored."
        placeholder="--03-14"
        value={birthday}
        onChange={(event) => { setBirthday(event.target.value); }}
      />
      <NumberField
        label="Be in touch every"
        unit="days"
        min={1}
        max={730}
        value={cadenceDays}
        onValueChange={setCadenceDays}
        hint="Optional. Leave it empty and this page will report nothing rather than assume a rhythm."
      />
      <Inline gap="2">
        <Button
          size="sm"
          disabled={name.trim() === '' || save.isPending}
          onClick={() => { save.mutate(); }}
        >
          Save
        </Button>
      </Inline>
    </Stack>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  DEFAULT_UNIT_LABEL,
  LEARNING_KINDS,
  LEARNING_KIND_LABELS,
  LEARNING_STATUSES,
  LEARNING_STATUS_LABELS,
  describeProgress,
  systemClock,
} from '@naitikos/core';
import type { LearningItem, LearningKind, LearningStatus } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import type { LearningBoard } from '@/lib/platform/learning';
import { createLearningItem, setLearningProgress } from '../services/learningClient';

/**
 * `/work/learning` and `/work/learning/queue` — §4.8.
 *
 * §4.8 gives this surface four words: "queue, progress, notes, synthesis. Links
 * to Career for skill development."
 *
 * ## Putting something down is a button, not a failure
 *
 * `abandoned` sits alongside `finished` in the same row of buttons, at the same
 * size, and it is labelled "Put down". A queue that can only be finished
 * accumulates guilt, and an operator who feels judged by their reading list
 * stops adding to it — at which point it stops recording what they were
 * actually reading, which was the only thing it was for. A book closed after
 * forty pages with a sentence about why is worth more than one parked at "in
 * progress" for three years.
 *
 * ## Nothing renders as 0%
 *
 * `describeProgress` returns "Not started" or "No progress recorded" when no
 * total was declared, and this screen prints whatever it returns. §10.9 asks
 * for "insufficient data" over a guess, and a bar sitting at zero for a book
 * that is half read is a specific, wrong claim rather than an absent one.
 *
 * ## The queue is not resorted here
 *
 * `board.items` arrives in `queueOrder` and is rendered in that order. Sorting
 * by recency would reward the most recent enthusiasm and bury the thing that
 * was genuinely worth reading four months ago, which is precisely the item a
 * queue exists to keep in view.
 */
export function LearningScreen({ board }: { readonly board: LearningBoard }): ReactNode {
  const router = useRouter();

  const refresh = (): void => {
    router.refresh();
  };

  return (
    <Stack gap="6">
      <AddItem onSaved={refresh} />

      <Stack gap="2">
        <Text role="title-3" as="h2">
          The queue
        </Text>
        {board.items.length === 0 ? (
          <EmptyState
            title="Nothing queued"
            description="A book, a paper, a course. What it was for matters more than how many there are."
          />
        ) : (
          board.items.map((item) => <QueueRow key={item.id} item={item} onSaved={refresh} />)
        )}
      </Stack>

      <Crossover board={board} />
    </Stack>
  );
}

/* ======================================================================
 * The queue
 * ====================================================================== */

function QueueRow({
  item,
  onSaved,
}: {
  readonly item: LearningItem;
  readonly onSaved: () => void;
}): ReactNode {
  /* Which transition is waiting on a field. `null` means the buttons act
   * immediately — only the three statuses that have something worth asking for
   * open a form. */
  const [pending, setPending] = useState<LearningStatus | null>(null);
  const [reason, setReason] = useState('');
  const [synthesis, setSynthesis] = useState(item.synthesis ?? '');
  const [units, setUnits] = useState(item.completedUnits === null ? '' : String(item.completedUnits));
  const [problem, setProblem] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: async (input: { readonly status: LearningStatus; readonly asked: boolean }) => {
      await setLearningProgress({
        id: item.id,
        status: input.status,
        /*
         * The recorded values are sent back deliberately. `setProgress` writes
         * the progress columns as given rather than merging, so a status change
         * that omitted them would erase how far in the operator was on the way
         * past.
         */
        completedUnits: input.asked ? parseCount(units) : item.completedUnits,
        synthesis:
          input.status === 'finished' && input.asked
            ? blankToNull(synthesis)
            : item.synthesis,
        /* A reason belongs to the status that has one; `core` drops it on any
         * other transition anyway. */
        abandonedReason: input.status === 'abandoned' ? blankToNull(reason) : null,
      });
    },
    onSuccess: () => {
      setPending(null);
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not change that.');
    },
  });

  const unit = item.unitLabel ?? DEFAULT_UNIT_LABEL[item.kind];

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline gap="3" align="center" justify="between">
            <Stack gap="1">
              <Text role="body" as="span">
                {item.title}
              </Text>
              <Text role="caption" tone="tertiary">
                {LEARNING_KIND_LABELS[item.kind]}
                {item.author === null ? '' : ` · ${item.author}`} · {describeProgress(item)}
              </Text>
            </Stack>
            <Badge tone={badgeTone(item.status)}>{LEARNING_STATUS_LABELS[item.status]}</Badge>
          </Inline>

          {item.skills.length > 0 && (
            <Inline gap="2" wrap>
              {item.skills.map((skill) => (
                <Badge key={skill} tone="neutral">
                  {skill}
                </Badge>
              ))}
            </Inline>
          )}

          {item.abandonedReason !== null && (
            <Text role="body-sm" tone="secondary">
              Put down: {item.abandonedReason}
            </Text>
          )}
          {item.synthesis !== null && (
            <Text role="body-sm" tone="secondary">
              {item.synthesis}
            </Text>
          )}

          {item.url !== null && (
            <a href={item.url} rel="noreferrer noopener" target="_blank">
              <Text role="caption" tone="accent" as="span">
                The source →
              </Text>
            </a>
          )}

          <Inline gap="2" wrap>
            {LEARNING_STATUSES.filter((status) => status !== item.status).map((status) => (
              <Button
                key={status}
                size="sm"
                variant="secondary"
                disabled={move.isPending}
                onClick={() => {
                  /* Three transitions have something worth asking for and open a
                   * field; the rest apply on the click. Asking on every one of
                   * them would make the common move cost two clicks. */
                  if (status === 'abandoned' || status === 'finished' || status === 'in_progress') {
                    setPending(pending === status ? null : status);
                    return;
                  }
                  move.mutate({ status, asked: false });
                }}
              >
                {LEARNING_STATUS_LABELS[status]}
              </Button>
            ))}
          </Inline>

          {pending !== null && (
            <Stack gap="2">
              {pending === 'in_progress' && (
                <TextField
                  label={`How far in, in ${unit}`}
                  hint="Optional. Left blank, no percentage is shown at all — better than a zero that would be wrong."
                  inputMode="numeric"
                  value={units}
                  onChange={(event) => {
                    setUnits(event.target.value);
                  }}
                />
              )}

              {pending === 'abandoned' && (
                <TextField
                  label="Why put it down?"
                  /* Asked, never required. An honest blank beats an invented
                   * reason, and a required field would produce the second. */
                  hint="Optional. A sentence here is what makes a put-down book more useful than one parked forever."
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}

              {pending === 'finished' && (
                <TextAreaField
                  label="Synthesis"
                  hint="Optional. What it was for, in your own words — the part that outlives the book."
                  rows={4}
                  value={synthesis}
                  onChange={(event) => {
                    setSynthesis(event.target.value);
                  }}
                />
              )}

              <Inline gap="2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={move.isPending}
                  onClick={() => {
                    move.mutate({ status: pending, asked: true });
                  }}
                >
                  {LEARNING_STATUS_LABELS[pending]}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPending(null);
                  }}
                >
                  Cancel
                </Button>
              </Inline>
            </Stack>
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* Finished is positive; put down is neutral. Not `caution` — the tone would
 * make an ordinary outcome read as a warning, which is the judgement this
 * screen exists not to make. */
function badgeTone(status: LearningStatus): 'neutral' | 'accent' | 'positive' {
  if (status === 'finished') return 'positive';
  if (status === 'in_progress') return 'accent';
  return 'neutral';
}

/* ======================================================================
 * Skills, both ways round
 * ====================================================================== */

function Crossover({ board }: { readonly board: LearningBoard }): ReactNode {
  const { studiedNotApplied, appliedNotStudied } = board.crossover;
  if (studiedNotApplied.length === 0 && appliedNotStudied.length === 0) return null;

  return (
    <Stack gap="3">
      <Text role="title-3" as="h2">
        Skills, against the career log
      </Text>

      <Inline gap="6" wrap align="start">
        <SkillList title="Studied, not yet applied" skills={studiedNotApplied} />
        <SkillList title="Applied, never studied" skills={appliedNotStudied} />
      </Inline>

      {/* The whole point of printing both columns. §4.8 asks for the linkage,
          not for a verdict on it. */}
      <Text role="caption" tone="tertiary">
        Both lists are reported and neither is judged. For any given skill, either could be entirely
        fine — a book read for its own sake, or something learned by doing it.
      </Text>
    </Stack>
  );
}

function SkillList({ title, skills }: { readonly title: string; readonly skills: readonly string[] }): ReactNode {
  return (
    <Stack gap="2">
      <Text role="caption" tone="tertiary">
        {title}
      </Text>
      {skills.length === 0 ? (
        <Text role="body-sm" tone="secondary">
          Nothing in this column.
        </Text>
      ) : (
        <Inline gap="2" wrap>
          {skills.map((skill) => (
            <Badge key={skill} tone="neutral">
              {skill}
            </Badge>
          ))}
        </Inline>
      )}
    </Stack>
  );
}

/* ======================================================================
 * Adding
 * ====================================================================== */

function AddItem({ onSaved }: { readonly onSaved: () => void }): ReactNode {
  const [kind, setKind] = useState<LearningKind>('book');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [url, setUrl] = useState('');
  const [totalUnits, setTotalUnits] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [skills, setSkills] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await createLearningItem({
        id: uuidV7(systemClock.nowMillis()),
        kind,
        title: title.trim(),
        author: blankToNull(author),
        url: blankToNull(url),
        /* Blank stays blank. A total invented from the kind would produce a
         * percentage nobody declared. */
        totalUnits: parsePositive(totalUnits),
        unitLabel: blankToNull(unitLabel),
        skills: skills
          .split(',')
          .map((skill) => skill.trim())
          .filter((skill) => skill !== ''),
      });
    },
    onSuccess: () => {
      setTitle('');
      setAuthor('');
      setUrl('');
      setTotalUnits('');
      setUnitLabel('');
      setSkills('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not add that.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Inline gap="2" wrap>
            {LEARNING_KINDS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === kind ? 'primary' : 'secondary'}
                aria-pressed={option === kind}
                onClick={() => {
                  setKind(option);
                }}
              >
                {LEARNING_KIND_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <TextField
            label="Title"
            value={title}
            placeholder="Designing Data-Intensive Applications"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />

          <TextField
            label="Author"
            value={author}
            onChange={(event) => {
              setAuthor(event.target.value);
            }}
          />

          <TextField
            label="Link"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />

          <Inline gap="3" wrap>
            <TextField
              label="Total"
              hint="Optional. Left blank, progress is never shown as a percentage."
              inputMode="numeric"
              value={totalUnits}
              onChange={(event) => {
                setTotalUnits(event.target.value);
              }}
            />
            <TextField
              label="Counted in"
              hint={`Defaults to ${DEFAULT_UNIT_LABEL[kind]} for a ${LEARNING_KIND_LABELS[kind].toLowerCase()}.`}
              value={unitLabel}
              onChange={(event) => {
                setUnitLabel(event.target.value);
              }}
            />
          </Inline>

          <TextField
            label="Skills"
            hint="Comma separated. Matched against the career log, both directions."
            value={skills}
            onChange={(event) => {
              setSkills(event.target.value);
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
              disabled={title.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Add to the queue
            </Button>
            {/* Said plainly rather than discovered when a queued write never
                appears. The observation path queues; this one does not. */}
            <Text role="caption" tone="tertiary">
              Needs a connection — queue state is not held offline.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

function blankToNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** A whole number of units, or `null` — never `NaN` and never a guessed zero. */
function parseCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parsePositive(raw: string): number | null {
  const value = parseCount(raw);
  return value === null || value <= 0 ? null : value;
}

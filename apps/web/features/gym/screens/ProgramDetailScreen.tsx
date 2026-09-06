'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { isoFromMillis, systemClock } from '@naitikos/core';
import type { Exercise, PrescribedExercise, ProgramBlock } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  NumberField,
  Stack,
  TextField,
  Text,
} from '@naitikos/design-system';

import type { ProgramDetail } from '@/lib/platform/programs';
import { deleteBlock, retireProgram, saveBlock } from '../services/programsClient';

/**
 * `/body/gym/programs/:id` — a program's blocks and what comes next.
 *
 * ## "Next" is computed, not counted
 *
 * The cycle wraps, and a block deleted mid-program restarts it rather than
 * stalling. `nextBlock` in `core` owns both rules; a page rendering "block 3 of
 * 5" would get the second one wrong the first time a block was removed, and
 * would keep pointing at a gap.
 *
 * ## A prescription is guidance and is rendered as such
 *
 * Sets, a rep range, an RPE target. All free text below the set count, because
 * notation is personal — `8-12`, `5x5`, `AMRAP`, `@8` — and a system that
 * insisted on parsing it would be a system the operator fights every mesocycle.
 * Nothing here is compared against what was logged; §10.0 keeps the model out
 * of judgement, and this keeps the application out of it too.
 *
 * ## Retiring is offered; deleting is not
 *
 * A program that ran for four months is history, and §9.4's soft delete is
 * about removing a mistake rather than a past. Retiring it stands it down and
 * dates its end, which is what "I stopped running this" actually means. The
 * delete path exists in the API for the program created by a typo.
 */
export function ProgramDetailScreen({ detail }: { readonly detail: ProgramDetail }): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const onError = (error: unknown): void => {
    setProblem(error instanceof Error ? error.message : 'That did not save.');
  };

  const retire = useMutation({
    mutationFn: async () => {
      await retireProgram(detail.program.id, isoFromMillis(systemClock.nowMillis()));
    },
    onSuccess: refresh,
    onError,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await deleteBlock(id, null);
    },
    onSuccess: refresh,
    onError,
  });

  const byId = new Map(detail.exercises.map((exercise) => [exercise.id, exercise]));

  return (
    <Stack gap="5">
      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="3" justify="between" align="baseline">
              <Stack gap="0">
                <Inline gap="2" align="center">
                  <Text role="title-3" as="h2">
                    {detail.program.isActive ? 'Running now' : 'Not active'}
                  </Text>
                  {detail.program.endedAt !== null && <Badge tone="neutral">ended</Badge>}
                </Inline>
                {detail.program.description !== null && (
                  <Text role="caption" tone="tertiary">
                    {detail.program.description}
                  </Text>
                )}
              </Stack>
              {detail.program.endedAt === null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    retire.mutate();
                  }}
                >
                  Retire
                </Button>
              )}
            </Inline>

            {detail.adherence === null ?
              <Text role="caption" tone="tertiary">
                No weekly target set, so nothing is being measured against one.
              </Text>
            : <Text role="body-sm" tone="secondary">
                {String(detail.adherence.sessionsPerformed)} sessions in the last {String(detail.windowDays)}{' '}
                days, against{' '}
                {detail.adherence.sessionsIntended === null ?
                  '—'
                : String(Math.round(detail.adherence.sessionsIntended))}{' '}
                intended.
              </Text>
            }

            {detail.upcoming !== null && (
              <Text role="body-sm">
                Next up: <strong>{detail.upcoming.name}</strong>
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Blocks
              </Text>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAdding((open) => !open);
                }}
              >
                {adding ? 'Cancel' : 'Add block'}
              </Button>
            </Inline>

            {adding && (
              <BlockForm
                programId={detail.program.id}
                nextIndex={detail.blocks.length}
                exercises={detail.exercises}
                onDone={() => {
                  setAdding(false);
                  refresh();
                }}
                onError={onError}
              />
            )}

            {detail.blocks.length === 0 ?
              <EmptyState
                title="No blocks yet"
                description="A block is one day of the plan — Push A, Legs, Deload. They cycle in order, and the session logger offers whichever comes next."
              />
            : <Stack gap="3">
                {detail.blocks.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    isNext={detail.upcoming?.id === block.id}
                    exerciseName={(id) => byId.get(id)?.name ?? 'Unknown exercise'}
                    onRemove={() => {
                      remove.mutate(block.id);
                    }}
                  />
                ))}
              </Stack>
            }
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

function BlockRow({
  block,
  isNext,
  exerciseName,
  onRemove,
}: {
  readonly block: ProgramBlock;
  readonly isNext: boolean;
  readonly exerciseName: (id: string) => string;
  readonly onRemove: () => void;
}): ReactNode {
  return (
    <Stack gap="1">
      <Inline gap="3" justify="between" align="baseline">
        <Inline gap="2" align="center">
          <Text role="body">{block.name}</Text>
          {isNext && <Badge tone="positive">next</Badge>}
        </Inline>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </Inline>

      {block.prescription.length === 0 ?
        <Text role="caption" tone="tertiary">
          Nothing prescribed. The block still cycles; the logger just offers no prefill for it.
        </Text>
      : <Stack gap="0">
          {block.prescription.map((entry, index) => (
            <Text key={index} role="caption" tone="tertiary">
              {describePrescription(entry, exerciseName(entry.exerciseId))}
            </Text>
          ))}
        </Stack>
      }

      {block.notes !== null && (
        <Text role="caption" tone="tertiary">
          {block.notes}
        </Text>
      )}
    </Stack>
  );
}

/** `Bench press — 4 × 8-12 @ RPE 8`. Every part optional, because notation is. */
function describePrescription(entry: PrescribedExercise, name: string): string {
  const parts: string[] = [name];
  const scheme = [entry.sets === null ? null : String(entry.sets), entry.repRange]
    .filter((part): part is string => part !== null && part !== '')
    .join(' × ');
  if (scheme !== '') parts.push(scheme);
  if (entry.targetRpe !== null && entry.targetRpe !== '') parts.push(`RPE ${entry.targetRpe}`);
  if (entry.notes !== null && entry.notes !== '') parts.push(entry.notes);
  return parts.join(' — ');
}

function BlockForm({
  programId,
  nextIndex,
  exercises,
  onDone,
  onError,
}: {
  readonly programId: string;
  readonly nextIndex: number;
  readonly exercises: readonly Exercise[];
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [prescription, setPrescription] = useState<readonly PrescribedExercise[]>([]);
  const [exerciseId, setExerciseId] = useState(exercises[0]?.id ?? '');
  const [sets, setSets] = useState<number | null>(3);
  const [repRange, setRepRange] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await saveBlock({
        id: uuidV7(systemClock.nowMillis()),
        programId,
        name,
        /* Appended at the end. `program_block_order_unique` means two blocks
         * cannot share a position, and the list length is the only index
         * guaranteed free. */
        orderIndex: nextIndex,
        prescription,
        notes: notes.trim() === '' ? null : notes.trim(),
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <TextField
        label="Block name"
        hint="Push A, Legs, Deload."
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />

      {prescription.length > 0 && (
        <Stack gap="0">
          {prescription.map((entry, index) => (
            <Text key={index} role="caption" tone="tertiary">
              {describePrescription(entry, exercises.find((e) => e.id === entry.exerciseId)?.name ?? 'Exercise')}
            </Text>
          ))}
        </Stack>
      )}

      {exercises.length > 0 && (
        <Inline gap="2" align="end">
          <TextField
            label="Exercise"
            list="program-exercise-options"
            value={exercises.find((e) => e.id === exerciseId)?.name ?? ''}
            onChange={(event) => {
              const match = exercises.find((e) => e.name === event.target.value);
              if (match !== undefined) setExerciseId(match.id);
            }}
          />
          <datalist id="program-exercise-options">
            {exercises.map((exercise) => (
              <option key={exercise.id} value={exercise.name} />
            ))}
          </datalist>
          <NumberField label="Sets" min={1} max={50} value={sets} onValueChange={setSets} />
          <TextField
            label="Reps"
            placeholder="8-12"
            value={repRange}
            onChange={(event) => {
              setRepRange(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={exerciseId === ''}
            onClick={() => {
              setPrescription((current) => [
                ...current,
                {
                  exerciseId,
                  sets,
                  repRange: repRange.trim() === '' ? null : repRange.trim(),
                  targetRpe: null,
                  notes: null,
                },
              ]);
              setRepRange('');
            }}
          >
            Add
          </Button>
        </Inline>
      )}

      <TextField
        label="Notes"
        hint="Optional."
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
      />

      <Inline gap="2">
        <Button
          size="sm"
          disabled={name.trim() === '' || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          Save block
        </Button>
      </Inline>
    </Stack>
  );
}

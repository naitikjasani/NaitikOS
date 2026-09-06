'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { MAX_TARGET_FREQUENCY, isoFromMillis, systemClock } from '@naitikos/core';
import type { ProgramAdherence } from '@naitikos/core';
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

import type { ProgramsBoard, ProgramSummary } from '@/lib/platform/programs';
import { activateProgram, saveProgram } from '../services/programsClient';

/**
 * `/body/gym/programs` — §4.1's "program definition and adherence", the
 * definition half.
 *
 * ## Nothing on this page names a session that did not happen
 *
 * A program is a plan the record is measured against, not a schedule that
 * generates obligations. §4.0's reasoning about the Daily Close transfers
 * exactly: *"a system that only accepts complete records trains the user to log
 * nothing on a bad day, and bad days are the clinically interesting ones."* A
 * red cross for every skipped Tuesday makes this the app the operator stops
 * opening in a bad month, which is the month whose data was worth having.
 *
 * So adherence is reported as **performed against intended**, both numbers
 * visible, and never as a streak, a grade, or a list of missed days.
 *
 * ## The ratio is shown above one hundred per cent when it is
 *
 * Five sessions against a target of three reads 167%, not "complete". Clamping
 * would hide the case worth noticing — training more than planned, which is the
 * usual prelude to the injury a deload was supposed to prevent.
 *
 * ## One program is active, and activating is a button rather than a checkbox
 *
 * `program_one_active` is a partial unique index: making one active stands the
 * others down, across two rows in a transaction. A checkbox per row would imply
 * they were independent.
 */
export function ProgramsScreen({ board }: { readonly board: ProgramsBoard }): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const activate = useMutation({
    mutationFn: async (id: string) => {
      await activateProgram(id);
    },
    onSuccess: () => {
      setProblem(null);
      refresh();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not activate that program.');
    },
  });

  return (
    <Stack gap="5">
      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Programs
              </Text>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAdding((open) => !open);
                }}
              >
                {adding ? 'Cancel' : 'New program'}
              </Button>
            </Inline>

            {adding && (
              <ProgramForm
                onDone={() => {
                  setAdding(false);
                  refresh();
                }}
                onError={(error) => {
                  setProblem(error instanceof Error ? error.message : 'That did not save.');
                }}
              />
            )}

            {board.programs.length === 0 ?
              <EmptyState
                title="No programs"
                description="A program is a plan your training is measured against. Without one, sessions are still logged and still counted — a program adds a target to compare them to, and nothing else."
              />
            : <Stack gap="3">
                {board.programs.map((summary) => (
                  <ProgramRow
                    key={summary.program.id}
                    summary={summary}
                    windowDays={board.windowDays}
                    onActivate={() => {
                      activate.mutate(summary.program.id);
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

function ProgramRow({
  summary,
  windowDays,
  onActivate,
}: {
  readonly summary: ProgramSummary;
  readonly windowDays: number;
  readonly onActivate: () => void;
}): ReactNode {
  const { program, adherence, blockCount } = summary;

  return (
    <Inline gap="3" justify="between" align="baseline">
      <Stack gap="0">
        <Inline gap="2" align="center">
          <Link href={`/body/gym/programs/${program.id}`} className="nos-inline-link">
            {program.name}
          </Link>
          {program.isActive && <Badge tone="positive">active</Badge>}
          {program.endedAt !== null && <Badge tone="neutral">ended</Badge>}
        </Inline>
        <Text role="caption" tone="tertiary">
          {blockCount === 0 ?
            'no blocks yet'
          : `${String(blockCount)} ${blockCount === 1 ? 'block' : 'blocks'}`}
          {program.targetFrequency === null ? '' : ` · aiming for ${String(program.targetFrequency)} a week`}
        </Text>
      </Stack>

      <Inline gap="3" align="center">
        <AdherenceReading adherence={adherence} windowDays={windowDays} />
        {!program.isActive && program.endedAt === null && (
          <Button size="sm" variant="ghost" onClick={onActivate}>
            Make active
          </Button>
        )}
      </Inline>
    </Inline>
  );
}

/**
 * Performed against intended, with the window stated.
 *
 * Both numbers, always. A bare percentage is a grade; a percentage next to
 * "4 of 6 over 14 days" is a measurement, and the difference is whether the
 * operator can tell what would change it.
 */
function AdherenceReading({
  adherence,
  windowDays,
}: {
  readonly adherence: ProgramAdherence | null;
  readonly windowDays: number;
}): ReactNode {
  if (adherence === null) {
    /* §8.9. No target is not a score of zero — it is a program run without one,
     * which is an ordinary way to train. */
    return (
      <Text role="caption" tone="tertiary">
        no target set
      </Text>
    );
  }

  const intended = adherence.sessionsIntended;

  return (
    <Stack gap="0" align="end">
      <Text role="body-sm">
        {adherence.ratio === null ? '—' : `${String(Math.round(adherence.ratio * 100))}%`}
      </Text>
      <Text role="caption" tone="tertiary">
        {String(adherence.sessionsPerformed)} of {intended === null ? '—' : String(Math.round(intended))} over{' '}
        {String(windowDays)} days
      </Text>
    </Stack>
  );
}

function ProgramForm({
  onDone,
  onError,
}: {
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetFrequency, setTargetFrequency] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await saveProgram({
        id: uuidV7(systemClock.nowMillis()),
        name,
        description: description.trim() === '' ? null : description.trim(),
        startedAt: isoFromMillis(systemClock.nowMillis()),
        endedAt: null,
        targetFrequency,
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <TextField
        label="Name"
        hint="What you call it — PPL, 5/3/1, Winter block."
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label="What it is for"
        hint="Optional. The thing you will have forgotten by the next mesocycle."
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <NumberField
        label="Sessions a week"
        unit="a week"
        min={1}
        max={MAX_TARGET_FREQUENCY}
        value={targetFrequency}
        onValueChange={setTargetFrequency}
        hint="Optional. Leave it empty and adherence reports nothing rather than assuming a target."
      />
      <Text role="caption" tone="tertiary">
        {/* Stated on the form, so the button below is not a surprise. */}
        Saved inactive. Making a program active stands the current one down, which is why it is a separate
        step.
      </Text>
      <Inline gap="2">
        <Button
          size="sm"
          disabled={name.trim() === '' || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          Save
        </Button>
      </Inline>
    </Stack>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { ROUTINE_PERIOD_LABELS, ROUTINE_PERIODS, systemClock } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  Inline,
  Stack,
  Text,
  TextField,
  ToggleField,
} from '@naitikos/design-system';

import { defineRoutine, type RoutineStepDraft } from '../services/registerClient';

/**
 * Defining a routine — the half of §4.2's routine engine that was missing.
 *
 * ## Deliberately the smallest thing that closes the gap
 *
 * A name, a period, an optional expected time, and an ordered list of labels.
 * No product picker, no reminders, no drag-to-reorder, no icons. The test this
 * had to pass was "does its absence stop the thirty days of §2.1 from
 * happening", and everything beyond that failed it.
 *
 * ## Steps keep their ids across an edit
 *
 * A step's id is what `routine_log` references, so re-minting them on every save
 * would orphan every completion ever recorded against that step. New steps get a
 * new id; existing ones keep theirs, and a step the operator deletes is
 * tombstoned server-side rather than removed — which leaves past adherence
 * intact and stops the step counting towards future ratios.
 *
 * That is the only correct reading of "I dropped the toner": it does not mean
 * the toner was never applied in March.
 */
export function RoutineEditor({
  existing,
  onDone,
}: {
  readonly existing?: {
    readonly id: string;
    readonly name: string;
    readonly period: 'am' | 'pm' | 'midday' | 'as_needed';
    readonly expectedAt: string | null;
    readonly steps: readonly { readonly id: string; readonly label: string; readonly isOptional: boolean }[];
  };
  readonly onDone: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [name, setName] = useState(existing?.name ?? '');
  const [period, setPeriod] = useState<'am' | 'pm' | 'midday' | 'as_needed'>(existing?.period ?? 'pm');
  const [expectedAt, setExpectedAt] = useState(existing?.expectedAt ?? '');
  const [steps, setSteps] = useState<readonly RoutineStepDraft[]>(
    existing?.steps.map((step, index) => ({
      id: step.id,
      label: step.label,
      orderIndex: index,
      isOptional: step.isOptional,
    })) ?? [{ id: uuidV7(systemClock.nowMillis()), label: '', orderIndex: 0, isOptional: false }],
  );

  const save = useMutation({
    mutationFn: async () => {
      await defineRoutine({
        id: existing?.id ?? uuidV7(systemClock.nowMillis()),
        kind: 'skincare',
        period,
        name: name.trim(),
        expectedAt: expectedAt.trim() === '' ? null : expectedAt.trim(),
        // Blank rows dropped, and re-indexed so the order is contiguous —
        // `routine_step_order_unique` is on `(routineId, orderIndex)`.
        steps: steps
          .filter((step) => step.label.trim() !== '')
          .map((step, index) => ({ ...step, label: step.label.trim(), orderIndex: index })),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['routines'] });
      onDone();
    },
  });

  const usable = name.trim() !== '' && steps.some((step) => step.label.trim() !== '');

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="4">
          <Text role="title-3" as="h2">
            {existing === undefined ? 'Define a routine' : 'Edit routine'}
          </Text>

          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Evening routine"
          />

          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              When
            </Text>
            <Inline gap="2" wrap>
              {ROUTINE_PERIODS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === period ? 'primary' : 'secondary'}
                  aria-pressed={option === period}
                  onClick={() => {
                    setPeriod(option);
                  }}
                >
                  {ROUTINE_PERIOD_LABELS[option]}
                </Button>
              ))}
            </Inline>
          </Stack>

          <TextField
            label="Expected at (optional)"
            value={expectedAt}
            onChange={(event) => {
              setExpectedAt(event.target.value);
            }}
            placeholder="22:00"
            hint="Local wall-clock time, so it survives a change of timezone."
          />

          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Steps, in order
            </Text>
            {steps.map((step, index) => (
              <Stack gap="1" key={step.id}>
                <TextField
                  label={`Step ${String(index + 1)}`}
                  labelHidden
                  value={step.label}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSteps((current) =>
                      current.map((candidate) =>
                        candidate.id === step.id ? { ...candidate, label: value } : candidate,
                      ),
                    );
                  }}
                  placeholder={`Step ${String(index + 1)}`}
                />
                <ToggleField
                  label="Optional"
                  description="Excluded from both sides of the adherence ratio."
                  checked={step.isOptional}
                  onCheckedChange={(checked) => {
                    setSteps((current) =>
                      current.map((candidate) =>
                        candidate.id === step.id ? { ...candidate, isOptional: checked } : candidate,
                      ),
                    );
                  }}
                />
              </Stack>
            ))}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSteps((current) => [
                  ...current,
                  {
                    id: uuidV7(systemClock.nowMillis()),
                    label: '',
                    orderIndex: current.length,
                    isOptional: false,
                  },
                ]);
              }}
            >
              Add a step
            </Button>
          </Stack>

          <Inline gap="2" justify="between" align="center">
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!usable || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
          </Inline>

          {save.error !== null && (
            <Text role="body-sm" tone="secondary">
              {save.error instanceof Error ? save.error.message : 'Could not save.'}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

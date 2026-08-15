'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  CONDITION_STATUSES,
  CONDITION_STATUS_LABELS,
  CONDITION_STATUS_NOTES,
  describeOnset,
  systemClock,
} from '@naitikos/core';
import type { Condition, ConditionStatus } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextField,
} from '@naitikos/design-system';

import { addCondition, reviseCondition } from '../services/healthClient';

/**
 * `/body/health/conditions` — the register, and §9.5's two clocks made visible.
 *
 * ## "Began March 2026. Recorded October 2026."
 *
 * That sentence is the whole screen. §4.4:
 *
 *   "Learning in October that a condition began in March must not rewrite
 *    history — the March onset is recorded, and the fact that you did not know
 *    until October is also recorded. Any other design produces a record that
 *    quietly lies to a clinician."
 *
 * So the onset field asks when it *began*, in those words, and the form never
 * defaults it to today. A default of today is how every backfilled diagnosis
 * ends up claiming it started the afternoon somebody typed it in.
 *
 * ## Changing a status writes a new row
 *
 * There is no edit. Selecting a new status closes the old record's belief
 * interval and inserts a successor, which is what makes "what did my file say
 * in March" answerable after the diagnosis was corrected in October.
 *
 * ## Refuted is on the list, with an explanation
 *
 * §9.4 keeps a wrong diagnosis rather than deleting it, because it explains why
 * a medication is in the register. Without a sentence saying so, a person
 * scanning their own record wonders why something they were told was wrong is
 * still on the page.
 */
export function ConditionsScreen({
  conditions,
  zone,
}: {
  readonly conditions: readonly Condition[];
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [onsetDay, setOnsetDay] = useState('');
  const [status, setStatus] = useState<ConditionStatus>('active');
  const [diagnosedBy, setDiagnosedBy] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      await addCondition({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        status,
        severity: null,
        diagnosedBy: diagnosedBy.trim() === '' ? null : diagnosedBy.trim(),
        /*
         * Noon, not midnight. A start date is a day rather than a moment, and
         * midnight sits on a boundary a DST shift can push into the previous
         * day — which would file an onset under the wrong month on a chart that
         * will still be read in 2046.
         */
        onsetAt: `${onsetDay}T12:00:00.000Z`,
        zone,
        note: null,
      });
    },
    onSuccess: () => {
      setAdding(false);
      setName('');
      setOnsetDay('');
      setDiagnosedBy('');
      router.refresh();
    },
  });

  const revise = useMutation({
    mutationFn: async (input: { readonly id: string; readonly status: ConditionStatus }) => {
      await reviseCondition({
        id: input.id,
        successorId: uuidV7(systemClock.nowMillis()),
        status: input.status,
        note: null,
      });
    },
    onSuccess: () => {
      router.refresh();
    },
  });

  const usable = name.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/u.test(onsetDay);

  return (
    <Stack gap="5">
      {adding ? (
        <Card variant="raised">
          <CardBody>
            <Stack gap="4">
              <Text role="title-3" as="h2">
                Add a condition
              </Text>
              <TextField
                label="Name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Vitamin D deficiency"
              />
              <DateField
                label="When it began"
                value={onsetDay}
                onValueChange={setOnsetDay}
                hint="Not when you are entering it. If a diagnosis in October was about something that started in March, this is March."
              />
              <Stack gap="2">
                <Text role="caption" tone="tertiary">
                  Status
                </Text>
                <Inline gap="2" wrap>
                  {CONDITION_STATUSES.map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={option === status ? 'primary' : 'secondary'}
                      aria-pressed={option === status}
                      onClick={() => {
                        setStatus(option);
                      }}
                    >
                      {CONDITION_STATUS_LABELS[option]}
                    </Button>
                  ))}
                </Inline>
                <Text role="caption" tone="tertiary">
                  {CONDITION_STATUS_NOTES[status]}
                </Text>
              </Stack>
              <TextField
                label="Diagnosed by (optional)"
                value={diagnosedBy}
                onChange={(event) => {
                  setDiagnosedBy(event.target.value);
                }}
                hint="Leave blank if you identified it yourself."
              />
              <Inline gap="2" justify="between" align="center">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!usable || create.isPending}
                  onClick={() => {
                    create.mutate();
                  }}
                >
                  Add
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            Add a condition
          </Button>
        </Inline>
      )}

      {conditions.length === 0 ? (
        <EmptyState
          icon="domain.clinical"
          title="Nothing on the register"
          description="Diagnoses, suspected and confirmed, with when they began and when you learned about them."
        />
      ) : (
        <Stack gap="2">
          {conditions.map((condition) => (
            <Card key={condition.id} variant="outlined">
              <CardBody>
                <Stack gap="3">
                  <Inline justify="between" align="center" wrap>
                    <Stack gap="1">
                      <Text role="body" as="span">
                        {condition.name}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {describeOnset(condition)}
                        {condition.diagnosedBy === null ? '' : ` Diagnosed by ${condition.diagnosedBy}.`}
                      </Text>
                    </Stack>
                    <Badge tone="neutral">{CONDITION_STATUS_LABELS[condition.status]}</Badge>
                  </Inline>

                  <Text role="caption" tone="tertiary">
                    {CONDITION_STATUS_NOTES[condition.status]}
                  </Text>

                  <Inline gap="2" wrap>
                    {CONDITION_STATUSES.filter((option) => option !== condition.status).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant="ghost"
                        disabled={revise.isPending}
                        onClick={() => {
                          revise.mutate({ id: condition.id, status: option });
                        }}
                      >
                        Mark {CONDITION_STATUS_LABELS[option].toLowerCase()}
                      </Button>
                    ))}
                  </Inline>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

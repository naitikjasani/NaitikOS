'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  DateField,
  Inline,
  Stack,
  Text,
  TextField,
  ToggleField,
} from '@naitikos/design-system';

import { registerMedication } from '../services/registerClient';

/**
 * Registering a medication — the half of §4.7's lens that was missing.
 *
 * ## The schedule is not optional, and that is an adherence decision
 *
 * A medication with no schedule has no denominator: `expectedDosesPerDay`
 * returns `null` and it never appears in an adherence figure at all. Registering
 * one without a schedule would produce a row that *looks* tracked and is not —
 * which is worse than not registering it, because the operator would then
 * believe adherence was being measured.
 *
 * ## The start date is a real date, not "today"
 *
 * The operator registering Venlafaxine in September records a medication they
 * began in February. §9.5's validity axis is what that date sets; the record's
 * own `recorded_from` is today. Collapsing them would put the "started
 * Venlafaxine" marker on every chart in the wrong month.
 */

const FREQUENCIES = [
  { id: 'daily', label: 'Once daily' },
  { id: 'twice_daily', label: 'Twice daily' },
  { id: 'three_times_daily', label: 'Three times daily' },
  { id: 'as_needed', label: 'As needed' },
] as const;

export function MedicationRegisterForm({
  zone,
  onDone,
}: {
  readonly zone: string;
  readonly onDone: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [substance, setSubstance] = useState('');
  const [brandName, setBrandName] = useState('');
  const [strength, setStrength] = useState('');
  const [strengthUnit, setStrengthUnit] = useState('mg');
  const [startedOn, setStartedOn] = useState('');
  const [frequency, setFrequency] = useState<string>('daily');
  const [isPsychiatric, setIsPsychiatric] = useState(true);

  const save = useMutation({
    mutationFn: async () => {
      await registerMedication({
        id: uuidV7(systemClock.nowMillis()),
        substance: substance.trim(),
        brandName: brandName.trim() === '' ? null : brandName.trim(),
        form: 'tablet',
        strength: strength.trim() === '' ? null : strength.trim(),
        strengthUnit: strength.trim() === '' ? null : strengthUnit.trim(),
        /*
         * Noon in the operator's zone, not midnight.
         *
         * A start date is a day, not a moment, and midnight sits on a boundary
         * that a DST shift or an off-by-one hour can push into the previous
         * day — putting the chart annotation on the wrong date. Noon is an
         * hour no timezone rule has ever moved across a date line.
         */
        startedAt: `${startedOn}T12:00:00.000Z`,
        isPsychiatric,
        zone,
        schedule: {
          id: uuidV7(systemClock.nowMillis()),
          dose: strength.trim() === '' ? '1' : strength.trim(),
          doseUnit: strength.trim() === '' ? 'tablet' : strengthUnit.trim(),
          frequency,
          times: [],
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medications'] });
      onDone();
    },
  });

  const usable = substance.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/u.test(startedOn);

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="4">
          <Text role="title-3" as="h2">
            Add a medication
          </Text>

          <TextField
            label="Substance"
            value={substance}
            onChange={(event) => {
              setSubstance(event.target.value);
            }}
            placeholder="Venlafaxine"
            hint="The generic name. The brand goes below."
          />

          <TextField
            label="Brand (optional)"
            value={brandName}
            onChange={(event) => {
              setBrandName(event.target.value);
            }}
            placeholder="Venlafaxine XR"
          />

          <Inline gap="2">
            <TextField
              label="Strength"
              value={strength}
              onChange={(event) => {
                setStrength(event.target.value);
              }}
              placeholder="150"
              inputMode="decimal"
            />
            <TextField
              label="Unit"
              value={strengthUnit}
              onChange={(event) => {
                setStrengthUnit(event.target.value);
              }}
              placeholder="mg"
            />
          </Inline>

          <DateField
            label="Started on"
            value={startedOn}
            onValueChange={setStartedOn}
            hint="When you actually began it, not when you are entering it."
          />

          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Schedule
            </Text>
            <Inline gap="2" wrap>
              {FREQUENCIES.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={option.id === frequency ? 'primary' : 'secondary'}
                  aria-pressed={option.id === frequency}
                  onClick={() => {
                    setFrequency(option.id);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </Inline>
            {frequency === 'as_needed' && (
              <Text role="caption" tone="tertiary">
                An as-needed medication has no daily denominator, so no adherence figure is reported
                for it. That is deliberate — there is nothing to adhere to.
              </Text>
            )}
          </Stack>

          <ToggleField
            label="Psychiatric"
            description="Shown in the Mind lens. The register itself is Health's."
            checked={isPsychiatric}
            onCheckedChange={setIsPsychiatric}
          />

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
              Register
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

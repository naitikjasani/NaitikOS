'use client';

/**
 * One Close field, rendered as the control its metric implies.
 *
 * The mapping is not decided here — `core/close/form.ts` derives `control` from
 * the registry, so a bounded 1–5 integer is a tap scale wherever it appears and
 * not only on the screen someone remembered to special-case. This component
 * only knows how to draw each kind.
 */

import { useState, type ReactNode } from 'react';
import type { CloseField } from '@naitikos/core';
import {
  Button,
  NumberField,
  ScaleField,
  Stack,
  TextAreaField,
  ToggleField,
} from '@naitikos/design-system';

import { readPrior } from '@/lib/capture/priors';

export type CloseFieldControlProps = {
  readonly field: CloseField;
  readonly value: number | string | boolean | undefined;
  readonly onChange: (value: number | string | boolean) => void;
  readonly disabled?: boolean;
};

type MetricField = Extract<CloseField, { readonly kind: 'metric' }>;

/**
 * Anchor labels for the 1–5 scales.
 *
 * Keyed by metric because the poles are not interchangeable: 5 is the *best*
 * mood and the *worst* anxiety, and a scale labelled "Low / High" for both
 * would make a 5 mean opposite things in two adjacent rows of the same form.
 * Anything unlisted falls back to the neutral pair.
 */
const SCALE_ANCHORS: Readonly<Record<string, readonly [string, string]>> = {
  'mind.mood': ['Worst', 'Best'],
  'mind.energy': ['Depleted', 'High'],
  'mind.anxiety': ['None', 'Severe'],
  'body.sleep.quality': ['Unrested', 'Rested'],
  'body.skin.state': ['Worst', 'Clear'],
};

/**
 * A number, with the previous answer offered as one tap.
 *
 * §8.10 asks for the last value *pre-filled*, and this offers it instead. The
 * difference matters only here: §4.0 makes every Close field optional, so a
 * sleep duration silently pre-filled with last night's and then submitted
 * untouched would put a number the operator never looked at into a medical
 * record, indistinguishable from one they measured. `useDailyClose` keeps the
 * answer map sparse for exactly that reason and a default would defeat it.
 *
 * What the offer buys is the arithmetic §8.10 is really about. The stepper
 * starts from the metric's floor — zero for a duration — so a normal night is
 * fifteen presses of `+`. The chip is one press, and a half-hour correction is
 * two. Quick capture makes the opposite choice with the same data and says why.
 *
 * It disappears the moment the field holds anything, so it is never competing
 * with an answer that already exists.
 */
function CloseNumberField({
  field,
  value,
  onChange,
  disabled,
}: {
  readonly field: MetricField;
  readonly value: number | string | boolean | undefined;
  readonly onChange: (value: number | string | boolean) => void;
  readonly disabled: boolean;
}): ReactNode {
  /*
   * Read once, on mount, rather than on every render. The prior is a snapshot
   * of what the device knew when the field appeared; re-reading it would let a
   * capture made in another tab move the chip out from under a thumb already
   * travelling towards it.
   */
  const [prior] = useState(() => readPrior(field.metricKey));

  const current =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : null;

  /*
   * Half-hour steps for sleep, because that is the resolution the estimate
   * actually has — the metric's own description says "treat a 30-minute
   * difference as noise", and a 0.1-hour stepper would invite a precision the
   * number does not carry.
   */
  const step = field.unit === 'hours' ? 0.5 : 1;
  const unitSuffix = field.unit === '' ? '' : ` ${field.unit}`;

  return (
    <Stack gap="2">
      <NumberField
        label={field.label}
        value={current === null || Number.isNaN(current) ? null : current}
        onValueChange={(next) => {
          // `null` means the operator cleared it. Passing an empty string keeps
          // the field sparse-able: the hook drops blanks rather than submitting
          // them, so clearing a field is not the same as answering it zero.
          onChange(next === null ? '' : next);
        }}
        step={step}
        {...(field.min === null ? {} : { min: field.min })}
        {...(field.max === null ? {} : { max: field.max })}
        {...(field.unit === '' ? {} : { unit: field.unit })}
        disabled={disabled}
      />

      {prior !== null && current === null && (
        <Button
          variant="secondary"
          disabled={disabled}
          // The visible text is short enough to scan at 1am; the accessible name
          // carries the field it belongs to, because "Same as last time" read
          // out of context names nothing (§8.13).
          aria-label={`Answer ${field.label} with the last recorded value, ${String(prior)}${unitSuffix}`}
          onClick={() => {
            onChange(prior);
          }}
        >
          Same as last time · {String(prior)}
          {unitSuffix}
        </Button>
      )}
    </Stack>
  );
}

export function CloseFieldControl({
  field,
  value,
  onChange,
  disabled = false,
}: CloseFieldControlProps): ReactNode {
  if (field.kind === 'note') {
    return (
      <TextAreaField
        label={field.label}
        hint={field.description}
        rows={2}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={2000}
      />
    );
  }

  if (field.kind === 'medication') {
    return (
      <ToggleField
        label={field.label}
        description={field.description}
        checked={value === true}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (field.control === 'scale') {
    const anchors = SCALE_ANCHORS[field.metricKey] ?? ['Low', 'High'];
    return (
      <ScaleField
        label={field.label}
        value={typeof value === 'number' ? value : null}
        onValueChange={onChange}
        min={field.min ?? 1}
        max={field.max ?? 5}
        minLabel={anchors[0]}
        maxLabel={anchors[1]}
      />
    );
  }

  if (field.control === 'toggle') {
    return (
      <ToggleField
        label={field.label}
        description={field.description}
        checked={value === true}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (field.control === 'text') {
    return (
      <TextAreaField
        label={field.label}
        hint={field.description}
        rows={2}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    );
  }

  return <CloseNumberField field={field} value={value} onChange={onChange} disabled={disabled} />;
}

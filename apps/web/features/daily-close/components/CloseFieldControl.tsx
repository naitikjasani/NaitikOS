'use client';

/**
 * One Close field, rendered as the control its metric implies.
 *
 * The mapping is not decided here — `core/close/form.ts` derives `control` from
 * the registry, so a bounded 1–5 integer is a tap scale wherever it appears and
 * not only on the screen someone remembered to special-case. This component
 * only knows how to draw each kind.
 */

import type { ReactNode } from 'react';
import type { CloseField } from '@naitikos/core';
import { NumberField, ScaleField, TextAreaField, ToggleField } from '@naitikos/design-system';

export type CloseFieldControlProps = {
  readonly field: CloseField;
  readonly value: number | string | boolean | undefined;
  readonly onChange: (value: number | string | boolean) => void;
  readonly disabled?: boolean;
};

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

  /*
   * A number. Half-hour steps for sleep, because that is the resolution the
   * estimate actually has — the metric's own description says "treat a
   * 30-minute difference as noise", and a 0.1-hour stepper would invite a
   * precision the number does not carry.
   */
  const step = field.unit === 'hours' ? 0.5 : 1;

  return (
    <NumberField
      label={field.label}
      value={typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null}
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
  );
}

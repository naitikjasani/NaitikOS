import { describe, expect, it } from 'vitest';
import type { CloseField } from '@naitikos/core';

import { answeredCount, buildCloseSteps } from './steps';

/**
 * The invariant under test is §4.0's, not a layout preference: no step may be
 * taller than a phone screen, because "single screen, no scrolling on a phone"
 * is the constraint the whole Close is designed around and a registry change is
 * the thing most likely to break it silently.
 */

function scale(key: string): CloseField {
  return {
    kind: 'metric',
    id: key,
    metricKey: key,
    label: key,
    description: '',
    control: 'scale',
    unit: '',
    min: 1,
    max: 5,
  };
}

const NOTE: CloseField = {
  kind: 'note',
  id: 'note',
  label: 'Anything worth remembering',
  description: '',
  control: 'text',
};

function medication(id: string): CloseField {
  return {
    kind: 'medication',
    id: `medication:${id}`,
    medicationId: id,
    label: id,
    description: '',
    control: 'toggle',
  };
}

describe('buildCloseSteps', () => {
  it('groups the MVP form into three steps titled by domain', () => {
    const steps = buildCloseSteps([
      scale('mind.mood'),
      scale('mind.energy'),
      scale('mind.anxiety'),
      {
        kind: 'metric',
        id: 'body.sleep.duration',
        metricKey: 'body.sleep.duration',
        label: 'Sleep duration',
        description: '',
        control: 'number',
        unit: 'hours',
        min: 0,
        max: 24,
      },
      scale('body.sleep.quality'),
      scale('body.skin.state'),
      medication('venlafaxine'),
      NOTE,
    ]);

    expect(steps.map((step) => step.title)).toEqual(['Mind', 'Body', 'Medication · Note']);
    expect(steps.map((step) => step.fields.length)).toEqual([3, 3, 2]);
  });

  it('never puts more than three tap scales on one step, however many the registry grows to', () => {
    const steps = buildCloseSteps(
      Array.from({ length: 11 }, (_unused, index) => scale(`mind.metric_${String(index)}`)),
    );

    expect(steps.length).toBe(4);
    for (const step of steps) expect(step.fields.length).toBeLessThanOrEqual(3);
  });

  it('preserves registry order across the cut', () => {
    const fields = [scale('mind.a'), scale('mind.b'), scale('mind.c'), scale('mind.d')];
    const flattened = buildCloseSteps(fields).flatMap((step) => step.fields.map((f) => f.id));

    expect(flattened).toEqual(['mind.a', 'mind.b', 'mind.c', 'mind.d']);
  });

  it('returns no steps for an empty form, so the caller can show its empty state', () => {
    expect(buildCloseSteps([])).toEqual([]);
  });
});

describe('answeredCount', () => {
  it('counts a false toggle as answered and a blank note as not', () => {
    const step = { id: 's', title: 'Mixed', fields: [medication('m'), NOTE] };

    expect(answeredCount(step, { 'medication:m': false, note: '   ' })).toBe(1);
    expect(answeredCount(step, { 'medication:m': false, note: 'slept badly' })).toBe(2);
    expect(answeredCount(step, {})).toBe(0);
  });
});

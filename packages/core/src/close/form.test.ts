import { describe, expect, it } from 'vitest';

import { createMetricRegistry } from '../observations/metric';
import { MVP_METRICS } from '../observations/mvp-metrics';
import { DAILY_CLOSE_ELEMENT_BUDGET, type CloseMedication, buildCloseForm, medicationHeadroom } from './form';

const registry = createMetricRegistry(MVP_METRICS);

const MEDICATIONS: readonly CloseMedication[] = [
  { id: 'med-1', label: 'Venlafaxine XR 150 mg', schedule: 'Once daily, morning' },
  { id: 'med-2', label: 'Escitalopram 10 mg', schedule: 'Once daily, evening' },
];

describe('buildCloseForm', () => {
  it('generates the Close from the registry, in registration order, with the note last', () => {
    const form = buildCloseForm(registry, [], '2026-08-03', 'Asia/Kolkata');

    expect(form.fields.map((f) => f.id)).toEqual([
      'mind.mood',
      'mind.energy',
      'mind.anxiety',
      'body.sleep.duration',
      'body.sleep.quality',
      'body.skin.state',
      'note',
    ]);
    expect(form.fields.at(-1)?.kind).toBe('note');
  });

  /**
   * §4.0's cap, checked as arithmetic over data rather than trusted as a
   * comment. A hand-written screen would make this unenforceable, which is the
   * reason the form is generated at all.
   */
  it('stays inside the eleven-element budget with the operator’s two medications', () => {
    const form = buildCloseForm(registry, MEDICATIONS, '2026-08-03', 'Asia/Kolkata');
    expect(form.elementCount).toBe(9);
    expect(form.budget).toBe(DAILY_CLOSE_ELEMENT_BUDGET);
    expect(form.withinBudget).toBe(true);
    expect(form.overflow).toEqual([]);
  });

  /**
   * §4.0: "Adding a field requires removing a field." This test is what makes
   * that mechanical — a seventh Close metric fails here rather than silently
   * lengthening the ritual.
   */
  it('has exactly six Close metrics, leaving room for the note and four medications', () => {
    expect(registry.dailyClose()).toHaveLength(6);
    expect(medicationHeadroom(registry)).toBe(4);
  });

  it('emits a toggle per active medication, labelled from the register', () => {
    const form = buildCloseForm(registry, MEDICATIONS, '2026-08-03', 'Asia/Kolkata');
    const toggles = form.fields.filter((f) => f.kind === 'medication');

    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toMatchObject({
      id: 'medication:med-1',
      medicationId: 'med-1',
      label: 'Venlafaxine XR 150 mg',
      control: 'toggle',
    });
  });

  /**
   * The overflow is surfaced, never silent. §4.0's "if it does not fit,
   * something must be cut" is an instruction to a person; the code's job is to
   * make the person aware, not to decide for them.
   */
  it('reports overflow rather than hiding it, and keeps the note either way', () => {
    const many: CloseMedication[] = Array.from({ length: 8 }, (_, i) => ({
      id: `med-${String(i)}`,
      label: `Medication ${String(i)}`,
      schedule: '',
    }));

    const form = buildCloseForm(registry, many, '2026-08-03', 'Asia/Kolkata');
    expect(form.withinBudget).toBe(false);
    expect(form.elementCount).toBe(15);
    expect(form.fields).toHaveLength(DAILY_CLOSE_ELEMENT_BUDGET);
    expect(form.overflow.length).toBeGreaterThan(0);
    // The note is the one field that survives, because on an overflowing day it
    // is the most clinically interesting thing in the Close.
    expect(form.fields.at(-1)?.kind).toBe('note');
  });

  it('picks a tap scale for bounded 1–5 integers and a number field for the rest', () => {
    const form = buildCloseForm(registry, [], '2026-08-03', 'Asia/Kolkata');
    const control = (id: string): string | undefined => form.fields.find((f) => f.id === id)?.control;

    expect(control('mind.mood')).toBe('scale');
    expect(control('body.skin.state')).toBe('scale');
    expect(control('body.sleep.duration')).toBe('number');
  });

  it('carries the metric description through, because it is the field’s help text', () => {
    const form = buildCloseForm(registry, [], '2026-08-03', 'Asia/Kolkata');
    const mood = form.fields.find((f) => f.id === 'mind.mood');
    expect(mood?.description).toMatch(/1 \(worst\) to 5 \(best\)/);
  });

  it('reports zero headroom rather than a negative number', () => {
    const crowded = createMetricRegistry(
      Array.from({ length: 20 }, (_, i) => ({
        ...MVP_METRICS[0],
        key: `test.metric.${String(i)}`,
        inDailyClose: true,
      })).map((m) => ({ ...m, key: m.key })) as never,
    );
    expect(medicationHeadroom(crowded)).toBe(0);
  });
});

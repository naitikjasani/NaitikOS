import { describe, expect, it } from 'vitest';
import { CONDITION_STATUSES, DOCUMENT_KINDS, LAB_FLAGS } from '@naitikos/core';

import { conditionStatusSchema, healthWriteSchema, labFlagSchema, labResultRequestSchema } from './health';
import { documentKindSchema } from './documents';

/**
 * The enum-parity tests.
 *
 * A contract enum drifting from the domain's is the failure this codebase keeps
 * finding: the client sends a value the server silently rejects, and the metric
 * that should have caught it reads zero because nothing ever emitted it. These
 * three assertions cost nothing and turn that into a build failure.
 */
describe('contract enums match the domain', () => {
  it('condition statuses', () => {
    expect([...conditionStatusSchema.options].sort()).toEqual([...CONDITION_STATUSES].sort());
  });

  it('lab flags', () => {
    expect([...labFlagSchema.options].sort()).toEqual([...LAB_FLAGS].sort());
  });

  it('document kinds', () => {
    expect([...documentKindSchema.options].sort()).toEqual([...DOCUMENT_KINDS].sort());
  });
});

describe('lab results', () => {
  const base = {
    id: '018f4b2c-9e1a-7c3d-8f42-6a1b2c3d4e5f',
    analyteSlug: 'vitamin_d_25oh',
    printedName: 'Vitamin D (25-OH)',
    value: '14.2',
    unit: 'ng/mL',
    referenceLow: '30',
    referenceHigh: '100',
    confidence: 0.9,
  };

  it('accepts a decimal string and refuses a number', () => {
    expect(labResultRequestSchema.safeParse(base).success).toBe(true);
    /* §5.3 bans floats on the path a lab value travels. A JSON number here
     * would be a double before Zod ever saw it. */
    expect(labResultRequestSchema.safeParse({ ...base, value: 14.2 }).success).toBe(false);
  });

  it('allows a result with no numeric value at all', () => {
    expect(
      labResultRequestSchema.safeParse({ ...base, value: null, valueText: 'Not detected' }).success,
    ).toBe(true);
  });

  it('rejects a confidence outside 0–1', () => {
    expect(labResultRequestSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
  });
});

describe('the write union', () => {
  it('routes on kind and rejects an unknown one', () => {
    const parsed = healthWriteSchema.safeParse({
      kind: 'condition',
      condition: {
        id: '018f4b2c-9e1a-7c3d-8f42-6a1b2c3d4e5f',
        name: 'Vitamin D deficiency',
        status: 'active',
        onsetAt: '2026-03-14T12:00:00.000Z',
        zone: 'Asia/Kolkata',
      },
    });
    expect(parsed.success).toBe(true);
    expect(healthWriteSchema.safeParse({ kind: 'diagnosis', condition: {} }).success).toBe(false);
  });

  /**
   * The onset is required and there is no default. §4.4's whole bitemporal
   * argument collapses if the form can quietly claim a diagnosis began the
   * afternoon somebody typed it in.
   */
  it('requires an onset on a condition', () => {
    const parsed = healthWriteSchema.safeParse({
      kind: 'condition',
      condition: {
        id: '018f4b2c-9e1a-7c3d-8f42-6a1b2c3d4e5f',
        name: 'Vitamin D deficiency',
        status: 'active',
        zone: 'Asia/Kolkata',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('requires at least one result on a panel', () => {
    const parsed = healthWriteSchema.safeParse({
      kind: 'lab_panel',
      panel: {
        id: '018f4b2c-9e1a-7c3d-8f42-6a1b2c3d4e5f',
        panelName: 'Full body panel',
        collectedAt: '2026-09-12T12:00:00.000Z',
        zone: 'Asia/Kolkata',
        results: [],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

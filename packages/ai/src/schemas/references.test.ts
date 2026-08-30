/**
 * §10.10's central control, tested as a control rather than as a validator.
 *
 * The question each test asks is "could a model get a number in front of the
 * operator this way?" — not "does zod work".
 */

import { describe, expect, it } from 'vitest';

import { narrationSchema, referenceSchema, slotsIn } from './references';

const OBS = { kind: 'observation', observationId: '018f0000-0000-7000-8000-000000000001' } as const;

describe('narration', () => {
  it('refuses a digit in prose, which is the whole point', () => {
    const result = narrationSchema.safeParse({
      template: 'Your Vitamin D was 14.2 ng/mL in September.',
      references: [],
    });

    /* This is the failure §10.0 names: "a person changing their medication
     * behaviour because a language model produced a fluent, plausible,
     * invented correlation". 14.2 might be right. It might not be. The schema
     * makes it impossible to find out the hard way. */
    expect(result.success).toBe(false);
  });

  it('accepts the same sentence written with references', () => {
    const result = narrationSchema.safeParse({
      template: 'Your Vitamin D was {0} in {1}.',
      references: [OBS, { kind: 'observation', observationId: '018f0000-0000-7000-8000-000000000002' }],
    });

    expect(result.success).toBe(true);
  });

  it('refuses a slot with no reference behind it', () => {
    /* Otherwise the operator reads a literal "{1}" on the page, which is a bug
     * that looks like a bug — but the schema catches it before it is one. */
    const result = narrationSchema.safeParse({ template: 'Between {0} and {1}.', references: [OBS] });
    expect(result.success).toBe(false);
  });

  it('permits a number written as a word, which is the escape hatch', () => {
    const result = narrationSchema.safeParse({
      template: 'This has been true on most days for the last three weeks.',
      references: [],
    });
    expect(result.success).toBe(true);
  });

  it('refuses a year, a date, and a percentage — every one of them a digit', () => {
    for (const template of ['Since March 2026.', 'On 12/09.', 'Up 40% since then.']) {
      expect(narrationSchema.safeParse({ template, references: [] }).success).toBe(false);
    }
  });
});

describe('references', () => {
  it('has no variant that carries a value', () => {
    /* A structural assertion, deliberately. If someone adds
     * `{ kind: 'literal', value: number }` in a hurry, this fails and the
     * review conversation happens. */
    const rejected = referenceSchema.safeParse({ kind: 'literal', value: 14.2 });
    expect(rejected.success).toBe(false);
  });

  it('accepts a statistic reference by field name, never by figure', () => {
    const result = referenceSchema.safeParse({
      kind: 'statistic',
      findingId: '018f0000-0000-7000-8000-000000000003',
      field: 'r',
    });
    expect(result.success).toBe(true);
  });
});

describe('slotsIn', () => {
  it('reads the indices in order', () => {
    expect(slotsIn('{0} then {2} then {1}')).toEqual([0, 2, 1]);
  });

  it('finds nothing in prose with no slots', () => {
    expect(slotsIn('nothing here')).toEqual([]);
  });
});

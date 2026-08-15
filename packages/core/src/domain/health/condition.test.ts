import { describe, expect, it } from 'vitest';

import type { Condition } from './condition';
import { activeOn, believedAt, currentConditions, describeOnset, validateCondition } from './condition';

function condition(overrides: Partial<Condition> & Pick<Condition, 'id' | 'validFrom' | 'recordedFrom'>): Condition {
  return {
    medicalEventId: `event-${overrides.id}`,
    name: 'Vitamin D deficiency',
    code: null,
    codeSystem: null,
    status: 'active',
    severity: null,
    diagnosedBy: null,
    resolutionNote: null,
    validTo: null,
    recordedTo: null,
    ...overrides,
  };
}

/**
 * §4.4's central example, as a test: a condition that began in March and was
 * learned about in October. The two clocks disagree by seven months and both
 * readings have to stay available.
 */
const LEARNED_LATE = condition({
  id: 'a',
  validFrom: '2026-03-14T00:00:00.000Z',
  recordedFrom: '2026-10-02T00:00:00.000Z',
});

describe('the two clocks', () => {
  it('was true in June, and was not yet on the record', () => {
    const june = '2026-06-01T00:00:00.000Z';
    expect(activeOn([LEARNED_LATE], june)).toHaveLength(1);
    expect(believedAt([LEARNED_LATE], june)).toHaveLength(0);
  });

  it('is both true and believed in November', () => {
    const november = '2026-11-01T00:00:00.000Z';
    expect(activeOn([LEARNED_LATE], november)).toHaveLength(1);
    expect(believedAt([LEARNED_LATE], november)).toHaveLength(1);
  });

  it('excludes a superseded record from the current belief', () => {
    const superseded = condition({
      id: 'b',
      validFrom: '2026-03-14T00:00:00.000Z',
      recordedFrom: '2026-10-02T00:00:00.000Z',
      recordedTo: '2026-11-20T00:00:00.000Z',
    });
    expect(believedAt([superseded], '2026-12-01T00:00:00.000Z')).toHaveLength(0);
    expect(believedAt([superseded], '2026-10-15T00:00:00.000Z')).toHaveLength(1);
    // And it is not "currently true" either, because the belief has been replaced.
    expect(activeOn([superseded], '2026-12-01T00:00:00.000Z')).toHaveLength(0);
  });

  /**
   * §9.4: a diagnosis that turned out to be wrong is history, not a mistake to
   * be erased — it explains why a medication is in the register.
   */
  it('keeps a refuted diagnosis on the record and off the active list', () => {
    const refuted = condition({
      id: 'c',
      status: 'refuted',
      validFrom: '2026-01-01T00:00:00.000Z',
      recordedFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(activeOn([refuted], '2026-06-01T00:00:00.000Z')).toHaveLength(0);
    expect(believedAt([refuted], '2026-06-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('counts suspected and in-remission as current, and resolved as not', () => {
    const now = '2026-12-01T00:00:00.000Z';
    const made = (id: string, status: Condition['status']) =>
      condition({ id, status, validFrom: '2026-01-01T00:00:00.000Z', recordedFrom: '2026-01-01T00:00:00.000Z' });

    const current = currentConditions(
      [made('s', 'suspected'), made('a', 'active'), made('r', 'remission'), made('d', 'resolved')],
      now,
    );
    expect(current.map((entry) => entry.id).sort()).toEqual(['a', 'r', 's']);
  });
});

describe('describing an onset', () => {
  it('states both clocks when they disagree', () => {
    expect(describeOnset(LEARNED_LATE)).toBe('Began March 2026. Recorded October 2026.');
  });

  it('says it once when they agree, because the second half would be noise', () => {
    const sameMonth = condition({
      id: 'd',
      validFrom: '2026-10-02T00:00:00.000Z',
      recordedFrom: '2026-10-04T00:00:00.000Z',
    });
    expect(describeOnset(sameMonth)).toBe('Began October 2026.');
  });
});

describe('validation', () => {
  const input = {
    id: 'x',
    name: 'Anxiety disorder',
    status: 'active',
    onsetAt: '2024-05-01T00:00:00.000Z',
    zone: 'Asia/Kolkata',
  };

  it('accepts a well-formed condition', () => {
    expect(validateCondition(input).ok).toBe(true);
  });

  it('rejects an empty name, an unknown status, and a bad instant', () => {
    for (const [override, code] of [
      [{ name: '  ' }, 'condition_name_empty'],
      [{ status: 'cured' }, 'condition_status_unknown'],
      [{ onsetAt: 'last spring' }, 'condition_onset_invalid'],
    ] as const) {
      const result = validateCondition({ ...input, ...override });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
    }
  });
});

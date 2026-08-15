import { describe, expect, it } from 'vitest';

import {
  classifyAgainstRange,
  describeRange,
  effectiveFlag,
  isCritical,
  isOutOfRange,
  rangeShifts,
} from './reference-range';

const range = (low: string | null, high: string | null, unit = 'ng/mL') => ({ low, high, text: null, unit });

describe('classifying against a printed range', () => {
  it('reads the bounds inclusively', () => {
    expect(classifyAgainstRange('30', range('30', '100'))).toBe('normal');
    expect(classifyAgainstRange('100', range('30', '100'))).toBe('normal');
    expect(classifyAgainstRange('29.9', range('30', '100'))).toBe('low');
    expect(classifyAgainstRange('100.1', range('30', '100'))).toBe('high');
  });

  it('works with only one bound printed', () => {
    expect(classifyAgainstRange('5', range(null, '10'))).toBe('normal');
    expect(classifyAgainstRange('11', range(null, '10'))).toBe('high');
    expect(classifyAgainstRange('4', range('5', null))).toBe('low');
  });

  /**
   * The important negative. Defaulting a range-less line to `normal` would turn
   * every unclassifiable row on a report into reassurance.
   */
  it('returns null when there is nothing to compare against', () => {
    expect(classifyAgainstRange('42', range(null, null))).toBeNull();
    expect(classifyAgainstRange('not detected', range('0', '1'))).toBeNull();
  });
});

describe('the effective flag', () => {
  it('prefers what the laboratory printed over what arithmetic says', () => {
    // The lab said normal; the printed bounds say otherwise. The lab wins.
    const result = effectiveFlag('normal', '14', range('30', '100'));
    expect(result).toEqual({ flag: 'normal', source: 'printed' });
  });

  it('derives a flag when the report printed none, and says that it did', () => {
    const result = effectiveFlag(null, '14', range('30', '100'));
    expect(result).toEqual({ flag: 'low', source: 'derived' });
  });

  it('reports no flag at all rather than inventing one', () => {
    expect(effectiveFlag(null, null, range('30', '100'))).toEqual({ flag: null, source: 'none' });
    expect(effectiveFlag(null, '14', range(null, null))).toEqual({ flag: null, source: 'none' });
  });

  it('knows which flags belong in a consultation', () => {
    expect(isOutOfRange('low')).toBe(true);
    expect(isOutOfRange('critical_high')).toBe(true);
    expect(isOutOfRange('abnormal')).toBe(true);
    expect(isOutOfRange('normal')).toBe(false);
    expect(isOutOfRange(null)).toBe(false);
    expect(isCritical('critical_low')).toBe(true);
    expect(isCritical('low')).toBe(false);
  });
});

describe('describing a range', () => {
  it('renders both bounds, one bound, printed text, and nothing', () => {
    expect(describeRange(range('30', '100'))).toBe('30 – 100 ng/mL');
    expect(describeRange(range('30', null))).toBe('≥ 30 ng/mL');
    expect(describeRange(range(null, '100'))).toBe('≤ 100 ng/mL');
    expect(describeRange({ low: null, high: null, text: '< 0.5', unit: null })).toBe('< 0.5');
    expect(describeRange(range(null, null))).toBe('not printed');
  });

  it('strips the trailing zeros a laboratory prints for alignment', () => {
    expect(describeRange(range('30.00', '100.0'))).toBe('30 – 100 ng/mL');
  });
});

describe('range shifts', () => {
  const result = (panelId: string, collectedAt: string, low: string, high: string, unit = 'ng/mL') => ({
    panelId,
    collectedAt,
    low,
    high,
    unit,
  });

  it('says nothing when every report printed the same range', () => {
    expect(
      rangeShifts([
        result('a', '2026-03-01T00:00:00.000Z', '30', '100'),
        result('b', '2026-09-01T00:00:00.000Z', '30', '100'),
      ]),
    ).toEqual([]);
  });

  /**
   * The quiet failure: the value is identical, the assay changed, and a chart
   * with a moving shaded band reads as though the person changed.
   */
  it('reports each distinct range in the order it first appears', () => {
    const shifts = rangeShifts([
      result('b', '2026-09-01T00:00:00.000Z', '20', '250'),
      result('a', '2026-03-01T00:00:00.000Z', '30', '400'),
    ]);
    expect(shifts).toHaveLength(2);
    expect(shifts[0]?.firstPanelId).toBe('a');
    expect(shifts[0]?.range).toBe('30 – 400 ng/mL');
    expect(shifts[1]?.firstPanelId).toBe('b');
  });

  it('treats a change of unit as a change of range', () => {
    const shifts = rangeShifts([
      result('a', '2026-03-01T00:00:00.000Z', '30', '100', 'ng/mL'),
      result('b', '2026-09-01T00:00:00.000Z', '30', '100', 'nmol/L'),
    ]);
    expect(shifts).toHaveLength(2);
  });

  it('ignores results that printed no range at all', () => {
    const shifts = rangeShifts([
      result('a', '2026-03-01T00:00:00.000Z', '30', '100'),
      { panelId: 'b', collectedAt: '2026-06-01T00:00:00.000Z', low: null, high: null, unit: 'ng/mL' },
      result('c', '2026-09-01T00:00:00.000Z', '30', '100'),
    ]);
    expect(shifts).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import type { DentalProcedure } from './tooth';
import { ARCHES, byTooth, parseTooth, toothLabel, totalCost } from './tooth';

describe('FDI notation', () => {
  /** §9.2's worked example: "Root canal on tooth 36". */
  it('reads 36 as the lower-left first molar', () => {
    const tooth = parseTooth('36');
    expect(tooth?.quadrant).toBe(3);
    expect(tooth?.position).toBe(6);
    expect(tooth?.arch).toBe('lower');
    expect(tooth?.side).toBe('left');
    expect(tooth?.label).toBe('lower-left first molar');
  });

  it('places all four permanent quadrants correctly', () => {
    expect(parseTooth('11')?.label).toBe('upper-right central incisor');
    expect(parseTooth('28')?.label).toBe('upper-left third molar');
    expect(parseTooth('33')?.label).toBe('lower-left canine');
    expect(parseTooth('47')?.label).toBe('lower-right second molar');
  });

  /** A childhood record can legitimately arrive in a scanned document. */
  it('reads the primary dentition and says so', () => {
    expect(parseTooth('51')?.isPrimary).toBe(true);
    expect(parseTooth('75')?.label).toBe('lower-left second molar (primary)');
  });

  /**
   * A child has five teeth per quadrant, not eight. Labelling `56` would name a
   * tooth nobody has.
   */
  it('refuses primary positions that do not exist', () => {
    expect(parseTooth('56')).toBeNull();
    expect(parseTooth('87')).toBeNull();
  });

  it('refuses anything that is not two FDI digits', () => {
    for (const bad of ['', '3', '360', '09', '90', 'ab', '3a', ' ']) {
      expect(parseTooth(bad), bad).toBeNull();
    }
  });

  it('tolerates surrounding whitespace, because a scan will have it', () => {
    expect(parseTooth('  36 ')?.notation).toBe('36');
  });

  /**
   * The record keeps what was written. An unreadable tooth number is displayed
   * verbatim and gets no place on the chart — visibly different from being
   * placed on the wrong one.
   */
  it('falls back to the raw string rather than inventing a label', () => {
    expect(toothLabel('36')).toBe('lower-left first molar');
    expect(toothLabel('LL6')).toBe('LL6');
  });
});

describe('the arch layout', () => {
  it('has sixteen teeth per arch, with no duplicates', () => {
    expect(ARCHES.upper).toHaveLength(16);
    expect(ARCHES.lower).toHaveLength(16);
    expect(new Set([...ARCHES.upper, ...ARCHES.lower]).size).toBe(32);
  });

  /**
   * Left-to-right on the page is the patient's right quadrant reversed, then
   * their left forward. Getting this backwards puts every marked tooth on the
   * wrong side of the mouth.
   */
  it('runs right-to-left across the midline, as a dentist reads it', () => {
    expect(ARCHES.upper[0]).toBe('18');
    expect(ARCHES.upper[7]).toBe('11');
    expect(ARCHES.upper[8]).toBe('21');
    expect(ARCHES.lower[0]).toBe('48');
    expect(ARCHES.lower[15]).toBe('38');
  });

  it('is entirely parseable', () => {
    for (const notation of [...ARCHES.upper, ...ARCHES.lower]) {
      expect(parseTooth(notation), notation).not.toBeNull();
    }
  });
});

describe('grouping by tooth', () => {
  const procedure = (overrides: Partial<DentalProcedure> & Pick<DentalProcedure, 'id'>): DentalProcedure => ({
    medicalEventId: `event-${overrides.id}`,
    name: 'Root canal',
    code: null,
    performedBy: null,
    location: null,
    toothNotation: '36',
    bodySite: null,
    performedAt: '2024-03-01T12:00:00.000Z',
    outcome: null,
    complications: null,
    costMinor: null,
    currency: null,
    ...overrides,
  });

  /** §4.5's question is per tooth; a flat chronology does not answer it. */
  it('groups per tooth, most recent first', () => {
    const grouped = byTooth([
      procedure({ id: 'a', performedAt: '2024-03-01T12:00:00.000Z' }),
      procedure({ id: 'b', performedAt: '2026-01-01T12:00:00.000Z' }),
      procedure({ id: 'c', toothNotation: '46' }),
    ]);

    expect(grouped.get('36')?.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(grouped.get('46')).toHaveLength(1);
  });

  it('keeps procedures with no tooth rather than dropping them', () => {
    const grouped = byTooth([procedure({ id: 'clean', name: 'Scale and polish', toothNotation: null })]);
    expect(grouped.get('')).toHaveLength(1);
  });
});

describe('cost', () => {
  const priced = (minor: number, currency: string | null): DentalProcedure => ({
    id: `p-${String(minor)}`,
    medicalEventId: 'e',
    name: 'Root canal',
    code: null,
    performedBy: null,
    location: null,
    toothNotation: '36',
    bodySite: null,
    performedAt: '2024-03-01T12:00:00.000Z',
    outcome: null,
    complications: null,
    costMinor: minor,
    currency,
  });

  /**
   * There is no exchange rate in this system, and inventing one produces a
   * number that is wrong by a different amount every year.
   */
  it('totals per currency and never across them', () => {
    const totals = totalCost([priced(1200000, 'INR'), priced(800000, 'INR'), priced(45000, 'GBP')]);
    expect(totals).toHaveLength(2);
    expect(totals.find((entry) => entry.currency === 'INR')?.minor).toBe(2000000);
    expect(totals.find((entry) => entry.currency === 'GBP')?.minor).toBe(45000);
  });

  it('ignores a cost with no currency rather than assuming one', () => {
    expect(totalCost([priced(1000, null)])).toEqual([]);
  });
});

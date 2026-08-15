import { describe, expect, it } from 'vitest';

import { REVIEW_FLOOR, confirmCandidates, isPreAccepted, overallConfidence } from './extraction';
import { findCollectionDate, matchAnalyteLabel, parseLabReport } from './lab-parser';

/** A plausible Indian full-body panel, as a PDF text layer comes out. */
const REPORT = `
   METROPOLIS HEALTHCARE LTD
   Patient: N J                       Age: 27 Y / M
   Collected On: 12-Sep-2026 08:14
   Report Date: 13-Sep-2026

   TEST                          RESULT      UNIT        REFERENCE
   Vitamin D (25-OH)             14.2        ng/mL       30 - 100
   Vitamin B12                   412         pg/mL       211 - 911
   Serum TSH                     2.14        uIU/mL      0.55 - 4.78
   HbA1c                         5.4         %           4.0 - 5.6
   Total Cholesterol             178         mg/dL       0 - 200
   HDL Cholesterol               46          mg/dL       40 - 60
   Ferritin                      18          ng/mL       Low       22 - 322
   Homocysteine                  9.4         umol/L      5 - 15
   Page 2 of 3
`;

describe('parsing a lab report', () => {
  const parsed = parseLabReport(REPORT);

  /**
   * The line that breaks a naive parser. `Vitamin D (25-OH) 14.2` has its first
   * digit inside the analyte's own name, and a digit-scan reads this report as
   * a vitamin D of 25 ng/mL.
   */
  it('does not read a digit inside the analyte name as the result', () => {
    const vitaminD = parsed.candidates.find((candidate) => candidate.analyteSlug === 'vitamin_d_25oh');
    expect(vitaminD?.printedValue).toBe('14.2');
    expect(vitaminD?.printedUnit).toBe('ng/mL');
    expect(vitaminD?.rangeLow).toBe('30');
    expect(vitaminD?.rangeHigh).toBe('100');
  });

  it('strips a collection qualifier so `Serum TSH` resolves', () => {
    expect(parsed.candidates.some((candidate) => candidate.analyteSlug === 'tsh')).toBe(true);
  });

  it('keeps total and HDL cholesterol apart', () => {
    const slugs = parsed.candidates.map((candidate) => candidate.analyteSlug);
    expect(slugs).toContain('cholesterol_total');
    expect(slugs).toContain('hdl_cholesterol');
  });

  /** A flag word sits exactly where a unit does. Storing `Low` as a unit is worse than storing none. */
  it('does not mistake a flag word for a unit', () => {
    const ferritin = parsed.candidates.find((candidate) => candidate.analyteSlug === 'ferritin');
    expect(ferritin?.printedUnit).toBe('ng/mL');
    expect(ferritin?.printedFlag).toBe('low');
  });

  it('counts the analytes it does not know rather than dropping them silently', () => {
    expect(parsed.candidates.some((candidate) => candidate.printedName.includes('Homocysteine'))).toBe(false);
    expect(parsed.unmatchedLines).toBeGreaterThan(0);
  });

  it('reads an unambiguous named-month collection date', () => {
    expect(parsed.collectedOn).toBe('2026-09-12');
  });

  it('scores a fully understood line above the review floor and a bare one below it', () => {
    const full = parsed.candidates.find((candidate) => candidate.analyteSlug === 'vitamin_d_25oh');
    expect(full === undefined ? 0 : full.confidence).toBeGreaterThanOrEqual(REVIEW_FLOOR);

    const bare = parseLabReport('Ferritin 45').candidates[0];
    expect(bare?.confidence).toBeLessThan(REVIEW_FLOOR);
    expect(bare === undefined ? true : isPreAccepted(bare)).toBe(false);
  });

  it('never reaches certainty, because it is scoring a pattern match', () => {
    for (const candidate of parsed.candidates) {
      expect(candidate.confidence).toBeLessThan(1);
    }
  });

  /** Labs print the same result in a summary and again in a table. */
  it('emits one candidate per analyte per report', () => {
    const twice = parseLabReport(`
      Vitamin D (25-OH)   14.2  ng/mL  30 - 100
      Vitamin D (25-OH)   14.2  ng/mL  30 - 100
    `);
    expect(twice.candidates).toHaveLength(1);
  });
});

describe('label matching', () => {
  it('resolves the shapes laboratories actually print', () => {
    expect(matchAnalyteLabel('Vitamin D (25-OH)')).toBe('vitamin_d_25oh');
    expect(matchAnalyteLabel('Serum TSH')).toBe('tsh');
    expect(matchAnalyteLabel('HDL Cholesterol - Direct')).toBe('hdl_cholesterol');
    expect(matchAnalyteLabel('Plasma Fasting Glucose')).toBe('glucose_fasting');
  });

  /**
   * The dangerous near-miss: a different molecule whose name contains an alias.
   * A missing candidate is visible; a wrong one is not.
   */
  it('refuses a label an alias barely covers', () => {
    expect(matchAnalyteLabel('Vitamin D Binding Protein')).toBeNull();
    expect(matchAnalyteLabel('Cholesterol Ratio Total To HDL Calculated')).toBeNull();
  });

  it('returns null for a label with nothing in it', () => {
    expect(matchAnalyteLabel('')).toBeNull();
    expect(matchAnalyteLabel('   ')).toBeNull();
  });
});

describe('collection dates', () => {
  it('accepts ISO and named months', () => {
    expect(findCollectionDate('Collected 2026-09-12')).toBe('2026-09-12');
    expect(findCollectionDate('Collected On: 12-Sep-2026')).toBe('2026-09-12');
    expect(findCollectionDate('Sample drawn 3 March 2026')).toBe('2026-03-03');
  });

  /**
   * `12/09/2026` is 12 September in Mumbai and 9 December in Boston. Nothing in
   * the document settles it, and a wrong anchor misplaces the whole panel.
   */
  it('refuses an ambiguous numeric date and accepts an unambiguous one', () => {
    expect(findCollectionDate('Collected 12/09/2026')).toBeNull();
    expect(findCollectionDate('Collected 21/09/2026')).toBe('2026-09-21');
  });

  it('returns null when there is no date at all', () => {
    expect(findCollectionDate('No dates here')).toBeNull();
  });
});

describe('confirmation', () => {
  const parsed = parseLabReport('Vitamin D (25-OH)   14.2  ng/mL  30 - 100');
  const key = parsed.candidates[0]?.key ?? '';

  it('writes nothing that was not accepted', () => {
    const result = confirmCandidates(parsed, [{ key, accept: false }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('keeps the parse confidence on a value accepted as read', () => {
    const result = confirmCandidates(parsed, [{ key, accept: true }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.value).toBe('14.2');
    expect(result.value[0]?.wasCorrected).toBe(false);
    expect(result.value[0]?.confidence).toBeLessThan(1);
  });

  /**
   * A retyped value is a manual entry that happened to arrive beside a
   * document. Keeping the extraction's confidence on it would permanently
   * understate a number the operator read off the page themselves.
   */
  it('promotes a corrected value to full confidence', () => {
    const result = confirmCandidates(parsed, [{ key, accept: true, correctedValue: '14.8' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.value).toBe('14.8');
    expect(result.value[0]?.wasCorrected).toBe(true);
    expect(result.value[0]?.confidence).toBe(1);
  });

  it('fails loudly when the extraction has moved under the review', () => {
    const result = confirmCandidates(parsed, [{ key: 'line:99', accept: true }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('extraction_decision_stale');
  });

  /** The lowest, not the mean — nineteen clean lines must not bury one bad one. */
  it('takes the overall confidence from the weakest candidate', () => {
    const mixed = parseLabReport(`
      Vitamin D (25-OH)   14.2  ng/mL  30 - 100
      Ferritin 45
    `);
    const lowest = Math.min(...mixed.candidates.map((candidate) => candidate.confidence));
    expect(overallConfidence(mixed.candidates)).toBe(lowest);
    expect(overallConfidence([])).toBeNull();
  });
});

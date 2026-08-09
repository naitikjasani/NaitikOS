import { describe, expect, it } from 'vitest';

import type { AdherenceDay, AdherenceSeries } from './adherence';
import { MIN_BASELINE_UNITS, MIN_RECORDED_DAYS, detectAdherence } from './adherence';

function days(
  count: number,
  completed: number,
  expectedPerDay = 1,
  recorded = true,
  offset = 0,
): AdherenceDay[] {
  return Array.from({ length: count }, (_, index) => ({
    dayKey: `d${String(offset + index).padStart(4, '0')}`,
    expected: expectedPerDay,
    completed: index < completed ? expectedPerDay : 0,
    recorded,
  }));
}

function series(daysList: readonly AdherenceDay[]): AdherenceSeries {
  return {
    subject: 'medication:med-ven',
    label: 'Venlafaxine XR 150 mg',
    kind: 'medication',
    days: daysList,
  };
}

const TODAY = '2026-08-24';

describe('detectAdherence — the report', () => {
  it('reports insufficient data rather than silence below the gate', () => {
    const outcome = detectAdherence(series(days(3, 3)), TODAY, { inferentialAllowed: false });
    expect(outcome.findings).toEqual([]);
    expect(outcome.insufficient).toHaveLength(1);
    expect(outcome.insufficient[0]).toMatchObject({
      detector: 'adherence',
      required: MIN_RECORDED_DAYS,
      available: 3,
    });
    expect(outcome.insufficient[0]?.message).toContain('There are 3');
  });

  it('produces a descriptive count once the gate is cleared', () => {
    const outcome = detectAdherence(series(days(14, 12)), TODAY, { inferentialAllowed: false });
    const report = outcome.findings[0];
    expect(report?.confidence).toBe('descriptive');
    expect(report?.pValue).toBeNull();
    expect(report?.headline).toBe(
      'Venlafaxine XR 150 mg: 12 of 14 scheduled doses logged over the last 14 days.',
    );
    expect(report?.effect).toBe('86%');
  });

  it('states the unrecorded-day count in the detail', () => {
    const mixed = [...days(7, 7, 1, true), ...days(7, 0, 1, false, 7)];
    const outcome = detectAdherence(series(mixed), TODAY, { inferentialAllowed: false });
    expect(outcome.findings[0]?.detail).toBe(
      '7 of those days have no record either way, and are not counted on either side.',
    );
  });

  it('carries a doesNotProve sentence naming the logging confound', () => {
    const outcome = detectAdherence(series(days(14, 14)), TODAY, { inferentialAllowed: false });
    expect(outcome.findings[0]?.doesNotProve).toContain('indistinguishable');
  });
});

describe('detectAdherence — the deviation', () => {
  /** A long, high-adherence baseline followed by a poor fortnight. */
  function withBaseline(recentCompleted: number): AdherenceSeries {
    return series([...days(60, 58, 1, true), ...days(14, recentCompleted, 1, true, 60)]);
  }

  it('produces nothing inferential while the baseline gate is closed', () => {
    const outcome = detectAdherence(withBaseline(6), TODAY, { inferentialAllowed: false });
    expect(outcome.findings.every((finding) => finding.pValue === null)).toBe(true);
    expect(outcome.insufficient).toEqual([]);
  });

  it('reports insufficient baseline rather than testing against noise', () => {
    const short = series([...days(10, 10), ...days(14, 6, 1, true, 10)]);
    const outcome = detectAdherence(short, TODAY, { inferentialAllowed: true });
    const gate = outcome.insufficient.find((item) => item.required === MIN_BASELINE_UNITS);
    expect(gate).toBeDefined();
    expect(gate?.available).toBe(10);
    expect(outcome.findings.every((finding) => finding.pValue === null)).toBe(true);
  });

  it('flags a real drop as exploratory, with a p-value', () => {
    const outcome = detectAdherence(withBaseline(6), TODAY, { inferentialAllowed: true });
    const deviation = outcome.findings.find((finding) => finding.pValue !== null);

    expect(deviation).toBeDefined();
    expect(deviation?.confidence).toBe('exploratory');
    expect(deviation?.pValue ?? 1).toBeLessThan(0.001);
    expect(deviation?.n).toBe(14);
    expect(deviation?.effect).toBe('43% against 97%');
  });

  it('does not fire on a fortnight consistent with the baseline', () => {
    const outcome = detectAdherence(withBaseline(14), TODAY, { inferentialAllowed: true });
    expect(outcome.findings.find((finding) => finding.pValue !== null)).toBeUndefined();
  });

  it('does not fire on a rise — only a drop is tested', () => {
    const rising = series([...days(60, 40, 1, true), ...days(14, 14, 1, true, 60)]);
    const outcome = detectAdherence(rising, TODAY, { inferentialAllowed: true });
    expect(outcome.findings.find((finding) => finding.pValue !== null)).toBeUndefined();
  });

  it('produces a stable id so a re-run does not duplicate the finding', () => {
    const first = detectAdherence(withBaseline(6), TODAY, { inferentialAllowed: true });
    const second = detectAdherence(withBaseline(6), TODAY, { inferentialAllowed: true });
    expect(first.findings.map((f) => f.id)).toEqual(second.findings.map((f) => f.id));
  });

  it('produces nothing when the recent window has no scheduled doses', () => {
    const noSchedule = series([...days(60, 58, 1, true), ...days(14, 0, 0, true, 60)]);
    const outcome = detectAdherence(noSchedule, TODAY, { inferentialAllowed: true });
    expect(outcome.findings).toEqual([]);
  });

  it('sorts an out-of-order series before splitting the windows', () => {
    const ordered = withBaseline(6);
    const shuffled: AdherenceSeries = { ...ordered, days: [...ordered.days].reverse() };
    expect(detectAdherence(shuffled, TODAY, { inferentialAllowed: true })).toEqual(
      detectAdherence(ordered, TODAY, { inferentialAllowed: true }),
    );
  });

  it('says "steps" for a routine and "doses" for a medication', () => {
    const routine: AdherenceSeries = {
      subject: 'routine:rt-pm',
      label: 'Evening routine',
      kind: 'routine',
      days: days(14, 12, 3),
    };
    expect(detectAdherence(routine, TODAY, { inferentialAllowed: false }).findings[0]?.headline).toContain(
      'scheduled steps',
    );
  });
});

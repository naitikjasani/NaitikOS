import { describe, expect, it } from 'vitest';

import {
  COVERAGE_TOLERANCE,
  MIN_CALIBRATION_SAMPLE,
  NOMINAL_COVERAGE,
  NO_OBSERVATION_REASON,
  calibrationOver,
  resolvePrediction,
} from './calibration';
import type { Prediction } from './predict';

const base: Prediction = {
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'bodyweight_projection',
  metricKey: 'body.weight',
  subjectType: null,
  subjectId: null,
  madeAt: '2026-08-30T18:00:00.000Z',
  horizonDayKey: '2026-09-13',
  predictedValue: '77.5',
  intervalLow: '76.0',
  intervalHigh: '79.0',
  unit: 'kg',
  method: 'linear_trend',
  observationCount: 21,
  fitConfidence: '0.81',
  assumptions: 'Assuming intake and training continue.',
  resolvedAt: null,
  resolvedValue: null,
  wasWithinInterval: null,
  unresolvableReason: null,
};

const p = (overrides: Partial<Prediction>): Prediction => ({ ...base, ...overrides });

/** A scored prediction, hit or miss. */
const scored = (withinInterval: boolean, overrides: Partial<Prediction> = {}): Prediction =>
  p({
    resolvedAt: '2026-09-13T06:00:00.000Z',
    resolvedValue: withinInterval ? '77.4' : '82.0',
    wasWithinInterval: withinInterval,
    ...overrides,
  });

/** `n` scored predictions, `hits` of which landed inside. */
const sample = (n: number, hits: number, overrides: Partial<Prediction> = {}): readonly Prediction[] =>
  Array.from({ length: n }, (_, index) => scored(index < hits, { id: `p${String(index)}`, ...overrides }));

describe('resolvePrediction', () => {
  it('scores a value inside the interval as a hit', () => {
    const result = resolvePrediction(base, '77.4');
    expect(result).toEqual({ resolvedValue: '77.4', wasWithinInterval: true });
  });

  it('scores a value outside the interval as a miss', () => {
    const result = resolvePrediction(base, '82.0');
    expect(result).toEqual({ resolvedValue: '82.0', wasWithinInterval: false });
  });

  it('treats both bounds as inside', () => {
    expect(resolvePrediction(base, '76.0')).toEqual({ resolvedValue: '76.0', wasWithinInterval: true });
    expect(resolvePrediction(base, '79.0')).toEqual({ resolvedValue: '79.0', wasWithinInterval: true });
  });

  it('returns a reason rather than a miss when there was nothing to compare against', () => {
    /*
     * The single most important behaviour in this file. A horizon that arrives
     * with no reading is an unanswered question; scoring it as a miss would
     * punish the engine for the operator's silence, and scoring it as a hit
     * would flatter it. Either corrupts the record in a direction nobody can
     * see afterwards.
     */
    expect(resolvePrediction(base, null)).toEqual({ unresolvableReason: NO_OBSERVATION_REASON });
  });

  it('refuses a reading that is not a number rather than reading it as zero', () => {
    const result = resolvePrediction(base, 'not recorded');
    expect('unresolvableReason' in result).toBe(true);
  });
});

describe('calibrationOver', () => {
  it('says nothing has been made when nothing has', () => {
    const report = calibrationOver([]);
    expect(report.resolved).toBe(0);
    expect(report.hitRate).toBeNull();
    expect(report.verdict).toContain('No predictions have been made yet.');
  });

  it('withholds a hit rate below the minimum sample', () => {
    /* A 100% hit rate over two predictions is not a track record. */
    const report = calibrationOver(sample(2, 2));
    expect(report.resolved).toBe(2);
    expect(report.hitRate).toBeNull();
    expect(report.verdict).toContain(String(MIN_CALIBRATION_SAMPLE));
  });

  it('reports a hit rate once the sample is large enough', () => {
    const report = calibrationOver(sample(MIN_CALIBRATION_SAMPLE, 9));
    expect(report.resolved).toBe(MIN_CALIBRATION_SAMPLE);
    expect(report.withinInterval).toBe(9);
    expect(report.hitRate).toBeCloseTo(0.9, 5);
  });

  it('keeps unresolvable predictions out of the denominator entirely', () => {
    const rows = [
      ...sample(MIN_CALIBRATION_SAMPLE, 9),
      p({
        id: 'unscored',
        resolvedAt: '2026-09-13T06:00:00.000Z',
        unresolvableReason: NO_OBSERVATION_REASON,
      }),
    ];

    const report = calibrationOver(rows);
    expect(report.unresolvable).toBe(1);
    /* Ten scored, not eleven — the unscored row is neither a hit nor a miss. */
    expect(report.resolved).toBe(MIN_CALIBRATION_SAMPLE);
    expect(report.hitRate).toBeCloseTo(0.9, 5);
    expect(report.verdict).toContain('rather than counted as a miss');
  });

  it('counts predictions whose horizon has not arrived as pending, not as anything else', () => {
    const report = calibrationOver([...sample(3, 3), p({ id: 'open' })]);
    expect(report.pending).toBe(1);
    expect(report.resolved).toBe(3);
    expect(report.verdict).toContain('waiting for the horizon');
  });

  it('says the intervals are too narrow when the hit rate falls short of nominal', () => {
    /* Six of ten, well under the tolerance band below nominal coverage. */
    const report = calibrationOver(sample(MIN_CALIBRATION_SAMPLE, 6));
    expect(report.hitRate).toBeCloseTo(0.6, 5);
    expect(report.hitRate ?? 1).toBeLessThan(NOMINAL_COVERAGE - COVERAGE_TOLERANCE);
    expect(report.verdict).toContain('too narrow');
  });

  it('says a perfect record is a fault in the other direction', () => {
    /*
     * The direction nobody thinks to check. A well-calibrated 95% interval
     * should miss about one time in twenty; an interval that never misses is
     * too wide to be a claim, and a report that congratulated the engine for it
     * would be rewarding the wrong thing.
     */
    const report = calibrationOver(sample(MIN_CALIBRATION_SAMPLE, MIN_CALIBRATION_SAMPLE));
    expect(report.hitRate).toBe(1);
    expect(report.verdict).toContain('too wide');
  });

  it('breaks the record down by kind, omitting kinds nobody has predicted', () => {
    const report = calibrationOver([
      ...sample(3, 3),
      ...sample(2, 1, { kind: 'load_progression', unit: 'kg' }),
    ]);

    const kinds = report.byKind.map((row) => row.kind);
    expect(kinds).toContain('bodyweight_projection');
    expect(kinds).toContain('load_progression');
    /* A kind with no predictions is not a row of zeroes — that reads as a
     * failure rather than as a question nobody asked. */
    expect(kinds).not.toContain('adherence_risk');
  });

  it('reports mean absolute error even below the hit-rate threshold', () => {
    /*
     * The asymmetry is deliberate. A hit *rate* is a claim about future
     * behaviour and needs a sample; a mean error describes the errors that
     * actually happened, and over three predictions it describes three
     * predictions honestly.
     */
    const report = calibrationOver(sample(3, 0));
    expect(report.hitRate).toBeNull();
    expect(report.meanAbsoluteError).toBeCloseTo(4.5, 5);
  });

  it('withholds mean absolute error when the sample spans more than one unit', () => {
    /* §6.2: "unit confusion in a medical record is a real, documented category
     * of harm." The mean of a kilogram error and a repetition error has no
     * dimension. */
    const report = calibrationOver([
      ...sample(2, 0),
      ...sample(2, 0, { kind: 'load_progression', unit: 'reps' }),
    ]);
    expect(report.meanAbsoluteError).toBeNull();
  });

  it('never renders a grade', () => {
    const report = calibrationOver(sample(MIN_CALIBRATION_SAMPLE, 9));
    /* §10.0 — the system reports counts, it does not award itself an
     * adjective. */
    expect(report.verdict).not.toMatch(/\b(good|poor|excellent|bad|strong|weak)\b/iu);
    expect(report.verdict).toContain('9 of 10');
  });
});

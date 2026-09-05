import { describe, expect, it } from 'vitest';

import { MAX_PROJECTION_DAYS } from '../../statistics/trend';
import type { DailyValue } from '../../statistics/types';
import { shiftDayKey } from '../../temporal/instant';
import type { Prediction, PredictionInput, PredictionKind, PredictionOutcome, PredictionRequest } from './predict';
import {
  MAX_HORIZON_DAYS,
  MIN_PREDICTION_OBSERVATIONS,
  PERMITTED_METRICS,
  PREDICTION_KINDS,
  PREDICTION_KIND_LABELS,
  PREDICTION_METHODS,
  PREDICTION_METHOD_LABELS,
  describePrediction,
  isPermittedSubject,
  makePrediction,
} from './predict';

const START = '2026-06-01';

/** `days` consecutive readings from {@link START}, rising by `perDay`. */
function rising(days: number, from = 74, perDay = 0.05, noise: readonly number[] = []): DailyValue[] {
  return Array.from({ length: days }, (_, index) => {
    const dayKey = shiftDayKey(START, index);
    if (dayKey === null) throw new Error('bad day key');
    const wobble = noise.length === 0 ? 0 : (noise[index % noise.length] ?? 0);
    return { dayKey, value: from + perDay * index + wobble };
  });
}

function lastDayKey(series: readonly DailyValue[]): string {
  const last = series.at(-1);
  if (last === undefined) throw new Error('empty series');
  return last.dayKey;
}

function ahead(dayKey: string, days: number): string {
  const shifted = shiftDayKey(dayKey, days);
  if (shifted === null) throw new Error('bad day key');
  return shifted;
}

function request(overrides: Partial<PredictionRequest> = {}): PredictionRequest {
  return {
    id: '01930000-0000-7000-8000-000000000001',
    kind: 'bodyweight_projection',
    metricKey: 'body.weight',
    horizonDayKey: '2026-06-25',
    madeAt: '2026-06-21T18:00:00.000Z',
    unit: 'kg',
    ...overrides,
  };
}

function predictedOf(outcome: PredictionOutcome): PredictionInput {
  if (outcome.status !== 'predicted') throw new Error(`expected a prediction, got ${outcome.status}`);
  return outcome.prediction;
}

describe('the vocabulary mirrors the enums', () => {
  it('labels every kind and every method', () => {
    for (const kind of PREDICTION_KINDS) expect(PREDICTION_KIND_LABELS[kind]).not.toBe('');
    for (const method of PREDICTION_METHODS) expect(PREDICTION_METHOD_LABELS[method]).not.toBe('');
  });

  it('has no clinical kind at all', () => {
    /* §10.9: "Prohibited: any prediction about a clinical outcome, a symptom
     * course, or a medication response." The enum is the structural half of
     * that, so a member appearing here would be a silent widening. */
    expect([...PREDICTION_KINDS]).toEqual([
      'goal_trajectory',
      'bodyweight_projection',
      'load_progression',
      'adherence_risk',
    ]);
  });
});

describe('the permitted-subject gate (§10.9)', () => {
  it('refuses a symptom metric under a permitted kind', () => {
    /* The kind enum cannot stop this one: `goal_trajectory` is permitted and a
     * goal can be set on anything. A projected symptom score is a symptom
     * course regardless of which kind it is filed under. */
    expect(isPermittedSubject('goal_trajectory', 'body.symptom.intensity')).toBe(false);

    const result = makePrediction(
      request({ kind: 'goal_trajectory', metricKey: 'body.symptom.intensity' }),
      rising(30),
      '2026-06-21',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('prediction_subject_prohibited');
  });

  it('refuses a medication metric', () => {
    expect(isPermittedSubject('adherence_risk', 'medication.adherence')).toBe(false);
    const result = makePrediction(
      request({ kind: 'adherence_risk', metricKey: 'medication.adherence', unit: 'ratio' }),
      rising(30),
      '2026-06-21',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a lab analyte', () => {
    expect(isPermittedSubject('goal_trajectory', 'health.lab.ferritin')).toBe(false);
  });

  it('refuses a mood score, which is a symptom course under another name', () => {
    expect(isPermittedSubject('goal_trajectory', 'mind.mood')).toBe(false);
    expect(isPermittedSubject('goal_trajectory', 'mind.anxiety')).toBe(false);
    /* Minutes practised is a behaviour, and stays. */
    expect(isPermittedSubject('goal_trajectory', 'mind.practice.duration')).toBe(true);
  });

  it('scopes the allowlist by kind rather than globally', () => {
    expect(isPermittedSubject('bodyweight_projection', 'body.weight')).toBe(true);
    /* A bodyweight "adherence risk" has no interpretation, so it is refused
     * even though both halves are individually permitted. */
    expect(isPermittedSubject('adherence_risk', 'body.weight')).toBe(false);
  });

  it('lists nothing clinical under any kind', () => {
    for (const kind of PREDICTION_KINDS) {
      for (const key of PERMITTED_METRICS[kind]) {
        expect(key.startsWith('health.lab.')).toBe(false);
        expect(key.startsWith('medication.')).toBe(false);
        expect(key).not.toBe('body.symptom.intensity');
      }
    }
  });
});

describe('insufficient data is an answer, not an error (§10.9)', () => {
  it('declines below the observation floor and says how far short it is', () => {
    const series = rising(MIN_PREDICTION_OBSERVATIONS - 1);
    const result = makePrediction(request({ horizonDayKey: ahead(lastDayKey(series), 5) }), series, lastDayKey(series));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.status).toBe('insufficient');
    if (result.value.status !== 'insufficient') throw new Error('unreachable');
    expect(result.value.observations).toBe(MIN_PREDICTION_OBSERVATIONS - 1);
    expect(result.value.reason).toContain(String(MIN_PREDICTION_OBSERVATIONS));
  });

  it('counts days rather than readings, so a day logged twice does not buy a day', () => {
    const series = [...rising(MIN_PREDICTION_OBSERVATIONS - 1), { dayKey: START, value: 74.4 }];
    const result = makePrediction(request({ horizonDayKey: ahead(lastDayKey(rising(13)), 5) }), series, '2026-06-13');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.status).toBe('insufficient');
  });

  it('declines when the record is stale rather than pretending the line reaches', () => {
    /* Readings stopped weeks ago. The horizon is inside the cap measured from
     * today and well outside it measured from the last reading, which is a
     * data problem and therefore an `insufficient`, not a refusal. */
    const series = rising(20);
    const today = ahead(lastDayKey(series), 20);
    const result = makePrediction(request({ horizonDayKey: ahead(today, 3) }), series, today);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.status).toBe('insufficient');
    if (result.value.status !== 'insufficient') throw new Error('unreachable');
    expect(result.value.reason).toContain(lastDayKey(series));
  });
});

describe('the horizon cap is a refusal, not a shrug', () => {
  it('errors past the cap', () => {
    const series = rising(30);
    const today = lastDayKey(series);
    const result = makePrediction(request({ horizonDayKey: ahead(today, MAX_HORIZON_DAYS + 1) }), series, today);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('prediction_horizon_too_far');
  });

  it('matches the cap Goals already applies to its drawn projection', () => {
    /* One extrapolation, one cap. A chart that stops on the fourteenth day and
     * a sentence underneath it about the twenty-eighth would be two answers to
     * the same question. */
    expect(MAX_HORIZON_DAYS).toBe(MAX_PROJECTION_DAYS);
  });

  it('errors on a horizon that has already happened', () => {
    const series = rising(30);
    const today = lastDayKey(series);
    const result = makePrediction(request({ horizonDayKey: today }), series, today);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('prediction_horizon_not_future');
  });

  it('errors on a malformed day key', () => {
    const result = makePrediction(request({ horizonDayKey: 'next tuesday' }), rising(30), '2026-06-30');
    expect(result.ok).toBe(false);
  });
});

describe('a prediction that is made', () => {
  const series = rising(21, 74, 0.05, [0.06, -0.09, 0.03, -0.03, 0.07, -0.05]);
  const today = lastDayKey(series);

  function predictAhead(days: number): PredictionInput {
    const result = makePrediction(request({ horizonDayKey: ahead(today, days) }), series, today);
    if (!result.ok) throw new Error('expected a prediction');
    return predictedOf(result.value);
  }

  it('brackets the point estimate, exactly as the DB CHECK requires', () => {
    const prediction = predictAhead(7);
    expect(Number(prediction.intervalLow)).toBeLessThanOrEqual(Number(prediction.predictedValue));
    expect(Number(prediction.predictedValue)).toBeLessThanOrEqual(Number(prediction.intervalHigh));
  });

  it('lands near the fitted extrapolation', () => {
    const prediction = predictAhead(7);
    /* 74 kg plus 0.05 kg/day over 20 observed days and 7 projected ones. */
    expect(Number(prediction.predictedValue)).toBeCloseTo(74 + 0.05 * 27, 0);
  });

  it('widens the interval with the horizon', () => {
    const near = predictAhead(3);
    const far = predictAhead(MAX_HORIZON_DAYS);
    const width = (p: PredictionInput): number => Number(p.intervalHigh) - Number(p.intervalLow);

    expect(width(far)).toBeGreaterThan(width(near));
  });

  it('carries the observation count, the fit and the method', () => {
    const prediction = predictAhead(7);
    expect(prediction.observationCount).toBe(21);
    expect(prediction.method).toBe('linear_trend');
    expect(Number(prediction.fitConfidence)).toBeGreaterThan(0.9);
    expect(Number(prediction.fitConfidence)).toBeLessThanOrEqual(1);
  });

  it('states its assumptions, naming the window and what has to hold', () => {
    const prediction = predictAhead(7);
    expect(prediction.assumptions).not.toBe('');
    expect(prediction.assumptions).toContain('intake and training continue');
    expect(prediction.assumptions).toContain('20 days');
    /* The `trend.ts` caveat travels with the row, so the sentence stored and
     * the sentence under the chart cannot drift apart. */
    expect(prediction.assumptions).toContain('not independent day to day');
  });

  it('gives every kind its own assumption sentence, and none of them empty', () => {
    const kinds: readonly { kind: PredictionKind; metricKey: string }[] = [
      { kind: 'goal_trajectory', metricKey: 'body.weight' },
      { kind: 'bodyweight_projection', metricKey: 'body.weight' },
      { kind: 'load_progression', metricKey: 'gym.set.load' },
      { kind: 'adherence_risk', metricKey: 'routine.adherence' },
    ];

    const sentences = kinds.map(({ kind, metricKey }) => {
      const result = makePrediction(request({ kind, metricKey, horizonDayKey: ahead(today, 5) }), series, today);
      if (!result.ok) throw new Error('expected a prediction');
      return predictedOf(result.value).assumptions;
    });

    expect(new Set(sentences).size).toBe(kinds.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(40);
  });

  it('carries the subject through when there is one', () => {
    const result = makePrediction(
      request({
        kind: 'goal_trajectory',
        horizonDayKey: ahead(today, 5),
        subjectType: 'goal_target',
        subjectId: '01930000-0000-7000-8000-0000000000aa',
      }),
      series,
      today,
    );
    if (!result.ok) throw new Error('expected a prediction');
    const prediction = predictedOf(result.value);
    expect(prediction.subjectType).toBe('goal_target');
    expect(prediction.subjectId).toBe('01930000-0000-7000-8000-0000000000aa');
  });

  it('defaults an absent subject to null rather than leaving it undefined', () => {
    const prediction = predictAhead(5);
    expect(prediction.subjectType).toBeNull();
    expect(prediction.subjectId).toBeNull();
  });
});

describe('describePrediction', () => {
  const base: Prediction = {
    id: '01930000-0000-7000-8000-000000000009',
    kind: 'bodyweight_projection',
    metricKey: 'body.weight',
    subjectType: null,
    subjectId: null,
    madeAt: '2026-06-21T18:00:00.000Z',
    horizonDayKey: '2026-06-28',
    predictedValue: '75.400000',
    intervalLow: '74.900000',
    intervalHigh: '75.900000',
    unit: 'kg',
    method: 'linear_trend',
    observationCount: 21,
    fitConfidence: '0.9100',
    assumptions: 'Assuming intake and training continue.',
    resolvedAt: null,
    resolvedValue: null,
    wasWithinInterval: null,
    unresolvableReason: null,
  };

  it('never states the point estimate without its interval', () => {
    const sentence = describePrediction(base);
    expect(sentence).toContain('75.4 kg');
    expect(sentence).toContain('between 74.9 and 75.9');
  });

  it('reports the outcome once there is one', () => {
    expect(
      describePrediction({ ...base, resolvedAt: '2026-06-28T06:00:00.000Z', resolvedValue: '75.100000', wasWithinInterval: true }),
    ).toContain('inside the interval');
    expect(
      describePrediction({ ...base, resolvedAt: '2026-06-28T06:00:00.000Z', resolvedValue: '77.000000', wasWithinInterval: false }),
    ).toContain('outside the interval');
  });

  it('keeps an unscorable prediction visible with its reason', () => {
    const sentence = describePrediction({
      ...base,
      resolvedAt: '2026-06-28T06:00:00.000Z',
      unresolvableReason: 'No reading was recorded on the horizon day.',
    });
    expect(sentence).toContain('Not scored');
    expect(sentence).toContain('No reading was recorded');
  });
});

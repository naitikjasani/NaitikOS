import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../units/decimal';
import { initialHlcState } from './hlc';
import { type MetricDefinition, type MetricKey, createMetricRegistry } from './metric';
import { MVP_METRICS } from './mvp-metrics';
import type { ObservationInput, ObservationSourceId } from './observation';
import {
  type ObservationWriteContext,
  decodeValue,
  isTapScale,
  normaliseValue,
  prepareObservations,
} from './write';

const registry = createMetricRegistry(MVP_METRICS);

/** Non-null: every key below is in the MVP registry, which the first test asserts. */
function metricFor(key: string): MetricDefinition {
  const found = registry.get(key);
  expect(found, `metric ${key} is missing from the MVP registry`).not.toBeNull();
  return found as MetricDefinition;
}

const MOOD = metricFor('mind.mood');
const WEIGHT = metricFor('body.weight');
const SLEEP = metricFor('body.sleep.duration');
const CLOSED = metricFor('system.daily_close.completed');

let counter = 0;
function context(overrides: Partial<ObservationWriteContext> = {}): ObservationWriteContext {
  return {
    registry,
    sourceId: 'src-manual' as ObservationSourceId,
    newId: () => `generated-${String((counter += 1))}`,
    recordedAt: '2026-08-03T18:00:00.000Z',
    physicalMillis: 1_754_244_000_000,
    ...overrides,
  };
}

function input(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    metricKey: 'mind.mood',
    value: { kind: 'integer', value: 4 },
    observedAt: '2026-08-03T18:00:00.000Z',
    observedZone: 'Asia/Kolkata',
    ...overrides,
  };
}

describe('the MVP registry', () => {
  it('registers every key the application writes', () => {
    expect(registry.all().length).toBeGreaterThan(0);
    expect(registry.has('mind.mood')).toBe(true);
    expect(registry.has('body.weight')).toBe(true);
    expect(registry.get('not.a.metric')).toBeNull();
  });

  /**
   * A `Map`, not an object. `constructor` is not a plausible metric key, but
   * the lookup runs on request input and "not plausible" is not a boundary.
   */
  it('does not resolve prototype keys as metrics', () => {
    expect(registry.get('constructor')).toBeNull();
    expect(registry.get('__proto__')).toBeNull();
    expect(registry.has('toString')).toBe(false);
  });

  it('exposes the Daily Close subset in registration order', () => {
    const close = registry.dailyClose();
    expect(close.every((m) => m.inDailyClose)).toBe(true);
    expect(close.map((m) => m.key)).toEqual([
      'mind.mood',
      'mind.energy',
      'mind.anxiety',
      'body.sleep.duration',
      'body.sleep.quality',
      'body.skin.state',
    ]);
  });
});

describe('normaliseValue', () => {
  it('accepts a value of the declared type', () => {
    const result = normaliseValue(MOOD, { kind: 'integer', value: 4 });
    expect(result.ok && result.value).toEqual({ value: '4.000000', valueText: null, unit: '' });
  });

  it('rejects a value of the wrong type', () => {
    const result = normaliseValue(MOOD, { kind: 'text', value: 'quite good' });
    expect(result.ok).toBe(false);
  });

  /**
   * §9.2's bounds are not advisory. A phone keyboard produces a 900 kg
   * bodyweight regularly enough that this is the most-hit branch in the file.
   */
  it('enforces the registered bounds', () => {
    expect(normaliseValue(MOOD, { kind: 'integer', value: 0 }).ok).toBe(false);
    expect(normaliseValue(MOOD, { kind: 'integer', value: 6 }).ok).toBe(false);
    expect(normaliseValue(MOOD, { kind: 'integer', value: 1 }).ok).toBe(true);
    expect(normaliseValue(MOOD, { kind: 'integer', value: 5 }).ok).toBe(true);
    expect(normaliseValue(WEIGHT, { kind: 'number', value: '900' }).ok).toBe(false);
  });

  /**
   * §9.2: "Conversion happens at the edges." A scale reporting pounds says so,
   * and the record stores kilograms — one conversion, at one place.
   */
  it('converts a submitted unit to the metric’s canonical unit', () => {
    const result = normaliseValue(WEIGHT, { kind: 'number', value: '165', unit: 'lb' });
    expect(result.ok && result.value.unit).toBe('kg');
    // 165 lb = 74.842741 kg (to six places).
    expect(result.ok && result.value.value).toBe('74.842741');
  });

  it('refuses a conversion across dimensions rather than inventing a number', () => {
    const result = normaliseValue(WEIGHT, { kind: 'number', value: '8', unit: 'hours' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.path).toEqual(['unit']);
  });

  it('refuses an unregistered unit', () => {
    expect(normaliseValue(WEIGHT, { kind: 'number', value: '11', unit: 'stone' }).ok).toBe(false);
  });

  it('rejects a fractional value for an integer metric', () => {
    expect(normaliseValue(MOOD, { kind: 'number', value: '4.5' }).ok).toBe(false);
    expect(normaliseValue(MOOD, { kind: 'number', value: '4.0' }).ok).toBe(true);
  });

  it('accepts a decimal for a duration metric', () => {
    const result = normaliseValue(SLEEP, { kind: 'number', value: '7.5' });
    expect(result.ok && result.value).toEqual({ value: '7.500000', valueText: null, unit: 'hours' });
  });

  /**
   * The failure §5.3 exists to prevent: Postgres rounds an over-scaled numeric
   * silently, so the stored value would differ from the submitted one with no
   * error anywhere.
   */
  it('rejects more precision than the column stores rather than letting Postgres round it', () => {
    const result = normaliseValue(WEIGHT, { kind: 'number', value: '74.2000001' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.message).toMatch(/precision/i);
  });

  /**
   * Both of these finish through the same normaliser as a measured number, so
   * that a re-submitted answer compares equal to the `1.000000` Postgres reads
   * back. Without it, every Daily Close would rewrite every boolean.
   */
  it('encodes booleans and categories at the column’s scale', () => {
    const result = normaliseValue(CLOSED, { kind: 'boolean', value: true });
    expect(result.ok && result.value.value).toBe('1.000000');

    const categorical: MetricDefinition = {
      ...MOOD,
      key: 'test.category' as MetricKey,
      valueType: 'categorical',
      allowedValues: ['low', 'medium', 'high'],
      minValue: null,
      maxValue: null,
    };
    const category = normaliseValue(categorical, { kind: 'category', value: 'high' });
    expect(category.ok && category.value).toEqual({ value: '2.000000', valueText: 'high', unit: '' });

    expect(normaliseValue(categorical, { kind: 'category', value: 'extreme' }).ok).toBe(false);
    expect(
      normaliseValue({ ...categorical, allowedValues: null }, { kind: 'category', value: 'high' }).ok,
    ).toBe(false);
  });

  /**
   * §4.0 makes every Close field optional, and "optional" means *omitted*. A
   * blank row would count as a recorded answer forever.
   */
  it('refuses an empty text observation instead of recording a blank fact', () => {
    const textMetric: MetricDefinition = { ...MOOD, valueType: 'text', minValue: null, maxValue: null };
    expect(normaliseValue(textMetric, { kind: 'text', value: '   ' }).ok).toBe(false);

    const written = normaliseValue(textMetric, { kind: 'text', value: '  slept badly  ' });
    expect(written.ok && written.value).toEqual({ value: '0', valueText: 'slept badly', unit: '' });
  });

  it('rejects a value that is not a finite number', () => {
    expect(normaliseValue(WEIGHT, { kind: 'number', value: 'heavy' }).ok).toBe(false);
    expect(normaliseValue(MOOD, { kind: 'integer', value: Number.NaN }).ok).toBe(false);
  });
});

describe('prepareObservations', () => {
  const clock = initialHlcState('01991f3c-2a80-7000-8000-3fa9b2c1de40', 0);

  it('is a no-op for an empty batch', () => {
    const result = prepareObservations([], clock, context());
    expect(result.ok && result.value.observations).toEqual([]);
    expect(result.ok && result.value.hlcState).toBe(clock);
  });

  it('builds a complete row from a minimal input', () => {
    const result = prepareObservations([input({ id: 'obs-1' })], clock, context());
    expect(result.ok).toBe(true);
    const [observation] = result.ok ? result.value.observations : [];

    expect(observation).toMatchObject({
      id: 'obs-1',
      metricKey: 'mind.mood',
      value: '4.000000',
      unit: '',
      observedAt: '2026-08-03T18:00:00.000Z',
      observedZone: 'Asia/Kolkata',
      recordedAt: '2026-08-03T18:00:00.000Z',
      sourceId: 'src-manual',
      supersededById: null,
    });
  });

  it('generates an id only when the caller did not bring one', () => {
    const result = prepareObservations([input(), input({ id: 'client-uuid' })], clock, context());
    const ids = result.ok ? result.value.observations.map((o) => o.id) : [];
    expect(ids[0]).toMatch(/^generated-/);
    expect(ids[1]).toBe('client-uuid');
  });

  /**
   * §5.12 reserves `precondition_failed` for "the input is well-formed, but the
   * system is not in a state where the operation makes sense — an unregistered
   * metric key (§9.2)". No amount of retyping fixes it, so it is not a form
   * error and does not accumulate with them.
   */
  it('fails fast with a precondition error for an unregistered metric', () => {
    const result = prepareObservations([input({ metricKey: 'invented.metric' })], clock, context());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('precondition_failed');
    expect(!result.ok && result.error.code).toBe('metric_not_registered');
  });

  /**
   * A Daily Close submits six fields. Returning problems one per round trip
   * would turn a sixty-second ritual into a conversation.
   */
  it('accumulates every value problem into one rejection, with indexed paths', () => {
    const result = prepareObservations(
      [
        input({ value: { kind: 'integer', value: 9 } }),
        input({ metricKey: 'body.weight', value: { kind: 'number', value: '5' } }),
      ],
      clock,
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'validation') throw new Error('expected a validation error');
    expect(result.error.issues).toHaveLength(2);
    expect(result.error.issues[0]?.path).toEqual([0, 'value']);
    expect(result.error.issues[1]?.path).toEqual([1, 'value']);
  });

  /**
   * Strict on write, tolerant on read. Accepting a bad zone here persists the
   * fault, and every future read of the row inherits the fallback.
   */
  it('rejects a zone that is not an IANA name', () => {
    const result = prepareObservations([input({ observedZone: 'IST' })], clock, context());
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'validation') throw new Error('expected a validation error');
    expect(result.error.issues[0]?.path).toEqual([0, 'observedZone']);
  });

  it('rejects an unparseable instant', () => {
    const result = prepareObservations([input({ observedAt: 'yesterday' })], clock, context());
    expect(result.ok).toBe(false);
  });

  it('rejects a half-populated subject reference', () => {
    const result = prepareObservations([input({ subject: { type: 'workout_set', id: '  ' } })], clock, context());
    expect(result.ok).toBe(false);
  });

  it('carries a complete subject reference through', () => {
    const result = prepareObservations(
      [input({ subject: { type: 'workout_set', id: 'set-1' } })],
      clock,
      context(),
    );
    expect(result.ok && result.value.observations[0]).toMatchObject({
      subjectType: 'workout_set',
      subjectId: 'set-1',
    });
  });

  it('rejects a confidence outside 0–1', () => {
    expect(prepareObservations([input({ confidence: '1.5' })], clock, context()).ok).toBe(false);
    expect(prepareObservations([input({ confidence: '-0.1' })], clock, context()).ok).toBe(false);
    expect(prepareObservations([input({ confidence: '0.5' })], clock, context()).ok).toBe(true);
  });

  /**
   * §9.1 keeps both rows forever so the record explains itself. A supersession
   * with no reason is a silent edit wearing a paper trail.
   */
  it('requires a reason on a correction', () => {
    expect(
      prepareObservations([input({ supersedes: { id: 'old', reason: '' } })], clock, context()).ok,
    ).toBe(false);

    const result = prepareObservations(
      [input({ id: 'new-obs', supersedes: { id: 'old-obs', reason: 'Mis-tapped.' } })],
      clock,
      context(),
    );
    expect(result.ok && result.value.supersessions).toEqual([
      {
        observationId: 'old-obs',
        supersededById: 'new-obs',
        supersededAt: '2026-08-03T18:00:00.000Z',
        supersedeReason: 'Mis-tapped.',
      },
    ]);
    // The new row is never born superseded; the correction points backwards.
    expect(result.ok && result.value.observations[0]?.supersededById).toBeNull();
  });

  /**
   * One tick per observation, so two facts written in the same millisecond
   * still have a total order — which is the entire point of the HLC.
   */
  it('issues a distinct, increasing HLC for every row in a batch', () => {
    const result = prepareObservations([input(), input(), input()], clock, context());
    expect(result.ok).toBe(true);
    const hlcs = result.ok ? result.value.observations.map((o) => o.hlc) : [];

    expect(new Set(hlcs).size).toBe(3);
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(result.ok && result.value.observations.at(-1)?.hlc).toBe(hlcs[2]);
    expect(result.ok && result.value.hlcState.counter).toBeGreaterThan(clock.counter);
  });

  it('surfaces clock anomalies rather than swallowing them', () => {
    const start = initialHlcState('01991f3c-2a80-7000-8000-3fa9b2c1de40', 9_999_999_999);
    const result = prepareObservations([input()], start, context({ physicalMillis: 1000 }));
    expect(result.ok && result.value.anomalies).toContain('local_regression');
  });

});

describe('decodeValue', () => {
  it('is the inverse of normaliseValue for every value type', () => {
    expect(decodeValue(MOOD, { value: '4.000000', valueText: null, unit: '' })).toEqual({
      kind: 'integer',
      value: 4,
    });

    expect(decodeValue(CLOSED, { value: '1.000000', valueText: null, unit: '' })).toEqual({
      kind: 'boolean',
      value: true,
    });
    expect(decodeValue(CLOSED, { value: '0.000000', valueText: null, unit: '' })).toEqual({
      kind: 'boolean',
      value: false,
    });

    const weight = decodeValue(WEIGHT, { value: '74.842741', valueText: null, unit: 'kg' });
    expect(weight?.kind).toBe('number');
    expect(weight?.kind === 'number' && formatDecimal(weight.value)).toBe('74.842741');
  });

  it('decodes a category back to its label', () => {
    const categorical: MetricDefinition = {
      ...MOOD,
      valueType: 'categorical',
      allowedValues: ['low', 'medium', 'high'],
    };
    expect(decodeValue(categorical, { value: '2.000000', valueText: 'high', unit: '' })).toEqual({
      kind: 'category',
      value: 'high',
      ordinal: 2,
    });
  });

  /**
   * `null`, not a guess. An ordinal past the end of `allowed_values` happens
   * when a value is retired without migrating the rows that used it, and
   * putting a wrong label on a real observation is worse than showing none.
   */
  it('returns null when the row and its metric disagree', () => {
    const categorical: MetricDefinition = {
      ...MOOD,
      valueType: 'categorical',
      allowedValues: ['low', 'high'],
    };
    expect(decodeValue(categorical, { value: '7.000000', valueText: null, unit: '' })).toBeNull();
    expect(decodeValue({ ...categorical, allowedValues: null }, { value: '0', valueText: null, unit: '' })).toBeNull();

    const textMetric: MetricDefinition = { ...MOOD, valueType: 'text' };
    expect(decodeValue(textMetric, { value: '0', valueText: null, unit: '' })).toBeNull();
    expect(decodeValue(MOOD, { value: 'not-a-number', valueText: null, unit: '' })).toBeNull();
  });
});

describe('isTapScale', () => {
  it('recognises the bounded 1–5 integers the Close is made of', () => {
    expect(isTapScale(MOOD)).toBe(true);
    expect(isTapScale(metricFor('body.skin.state'))).toBe(true);
  });

  it('rejects anything a person would have to type', () => {
    expect(isTapScale(WEIGHT)).toBe(false);
    expect(isTapScale(SLEEP)).toBe(false);
    // Unbounded integers, and bounds too wide to tap.
    expect(isTapScale(metricFor('body.skin.lesion_count'))).toBe(false);
    expect(isTapScale({ ...MOOD, maxValue: '50' })).toBe(false);
    expect(isTapScale({ ...MOOD, minValue: null })).toBe(false);
    expect(isTapScale({ ...MOOD, minValue: 'x' })).toBe(false);
  });
});

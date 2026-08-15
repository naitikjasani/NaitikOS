/**
 * The Health core vocabulary — vitals, and one metric per catalogued analyte.
 *
 * §9.2 rejects unregistered metric keys on write, so this list is not a
 * convenience: it *is* what Health is allowed to record. It sits beside the MVP
 * registry rather than inside it because the two have different lifecycles —
 * the MVP list is closed and budgeted (§4.0's eleven elements), while this one
 * grows every time a laboratory reports something new.
 *
 * `packages/db/src/seed/metrics.ts` concatenates them. That composition is the
 * database layer's job, in the direction §5.0 permits.
 *
 * ## Lab metrics are generated, not typed out
 *
 * One metric per analyte, derived from {@link ANALYTES}. Writing them by hand
 * would let a unit in the catalogue drift from the unit in the registry, which
 * is the exact failure §6.2 exists to prevent — and the drift would be
 * invisible, because both sides would still look correct on their own.
 *
 * Every lab metric aggregates as `last`. A weekly mean of two ferritin draws is
 * not a quantity anybody has ever wanted, and §9.2's whole argument for
 * per-metric aggregation is that the registry is what stops a chart computing
 * one anyway.
 */

import type { MetricDefinition, MetricKey } from '../../observations/metric';
import { ANALYTES, labMetricKey } from './analyte';
import { MAX_SYMPTOM_INTENSITY, MIN_SYMPTOM_INTENSITY, SYMPTOM_METRIC } from './symptom';
import { VITAL_METRICS } from './vitals';

function metric(
  definition: Omit<MetricDefinition, 'key' | 'minValue' | 'maxValue' | 'allowedValues' | 'inDailyClose'> & {
    readonly key: string;
    readonly minValue?: string;
    readonly maxValue?: string;
  },
): MetricDefinition {
  return {
    ...definition,
    key: definition.key as MetricKey,
    minValue: definition.minValue ?? null,
    maxValue: definition.maxValue ?? null,
    allowedValues: null,
    /* Nothing here belongs in the sixty-second ritual. §4.0's budget is the
     * reason: a vital sign is captured when it is taken, not every evening. */
    inDailyClose: false,
  };
}

const VITALS: readonly MetricDefinition[] = [
  metric({
    key: VITAL_METRICS.systolic,
    domain: 'body',
    displayName: 'Systolic blood pressure',
    description:
      'The higher number of a blood-pressure reading, in millimetres of mercury, measured during the heartbeat. Paired with the diastolic reading taken at the same moment through a shared vital_reading subject — the two numbers are one measurement and are only meaningful together. This system records the number and its trend and deliberately does not classify it: guideline thresholds differ, and they assume measurement conditions (rested, seated, correct cuff) that are not captured here.',
    valueType: 'integer',
    canonicalUnit: 'mmHg',
    minValue: '50',
    maxValue: '300',
    aggregation: 'mean',
  }),
  metric({
    key: VITAL_METRICS.diastolic,
    domain: 'body',
    displayName: 'Diastolic blood pressure',
    description:
      'The lower number of a blood-pressure reading, in millimetres of mercury, measured between heartbeats. Always paired with a systolic reading; a diastolic at or above its systolic is rejected on write as a transposed pair.',
    valueType: 'integer',
    canonicalUnit: 'mmHg',
    minValue: '30',
    maxValue: '200',
    aggregation: 'mean',
  }),
  metric({
    key: VITAL_METRICS.restingHeartRate,
    domain: 'body',
    displayName: 'Resting heart rate',
    description:
      'Beats per minute at rest. Averaged rather than summed over a period, and worth reading alongside training load: a resting heart rate that climbs across a training block is one of the few early signals of accumulated fatigue that a person can measure at home.',
    valueType: 'integer',
    canonicalUnit: 'bpm',
    minValue: '25',
    maxValue: '220',
    aggregation: 'mean',
  }),
  metric({
    key: VITAL_METRICS.temperature,
    domain: 'body',
    displayName: 'Body temperature',
    description:
      'Degrees Celsius. Stored in Celsius regardless of what the thermometer displayed; Fahrenheit input is converted once, at the write boundary, by the unit registry. The site of measurement is not recorded, which limits comparability between an oral and a forehead reading — treat a difference under half a degree as noise.',
    valueType: 'numeric',
    canonicalUnit: 'celsius',
    minValue: '30',
    maxValue: '45',
    aggregation: 'mean',
  }),
  metric({
    key: VITAL_METRICS.oxygenSaturation,
    domain: 'body',
    displayName: 'Oxygen saturation',
    description:
      'Peripheral oxygen saturation as a percentage, from a pulse oximeter. Consumer oximeters are least accurate exactly where accuracy matters most, at low readings and on darker skin; this is a home measurement and the record says so.',
    valueType: 'integer',
    canonicalUnit: 'percent',
    minValue: '50',
    maxValue: '100',
    aggregation: 'mean',
  }),
  metric({
    key: SYMPTOM_METRIC,
    domain: 'body',
    displayName: 'Symptom intensity',
    description:
      'How intense a symptom was, 1 (barely noticeable) to 10 (as bad as it has been). Attached to a symptom entity, which carries the body site, the duration and the suspected trigger. Aggregated as max over a period rather than mean: the question a symptom answers is how bad it got, and averaging one severe hour with eleven quiet ones produces the reading that gets a symptom dismissed at an appointment.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: String(MIN_SYMPTOM_INTENSITY),
    maxValue: String(MAX_SYMPTOM_INTENSITY),
    aggregation: 'max',
  }),
];

const LABS: readonly MetricDefinition[] = ANALYTES.map((analyte) =>
  metric({
    key: labMetricKey(analyte.slug),
    domain: 'body',
    displayName: analyte.displayName,
    description:
      `Laboratory result for ${analyte.displayName}, stored in ${analyte.canonicalUnit === '' ? 'the unit the laboratory printed' : analyte.canonicalUnit} after conversion from whatever unit the report printed. ` +
      'The reference range is NOT part of this metric: ranges vary by laboratory and change over time, so each result keeps the range printed on its own report, and comparing a value against a later laboratory’s range is a clinical error. Aggregated as last, never averaged.',
    valueType: 'numeric',
    canonicalUnit: analyte.canonicalUnit,
    minValue: String(analyte.plausible.min),
    maxValue: String(analyte.plausible.max),
    aggregation: 'last',
  }),
);

/** Everything Health core can write. */
export const HEALTH_METRICS: readonly MetricDefinition[] = Object.freeze([...VITALS, ...LABS]);

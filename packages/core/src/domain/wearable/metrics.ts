/**
 * The device-stream vocabulary — what a wearable is allowed to write.
 *
 * §2.3 puts "Wearable ingestion — Apple Health / Google Fit import. Pull-based,
 * batch, never a live stream" in V3, and §9.2 rejects unregistered metric keys
 * on write. `sample.metric_key` is a foreign key to the same registry every
 * human observation uses, so a heart rate off a watch and a weight typed into
 * the Daily Close speak one language. That is P3 working: Skin can ask about
 * resting heart rate without knowing a watch exists.
 *
 * ## Why these are not the same metrics as the vitals
 *
 * `body.vitals.heart_rate_resting` already exists — a single number a person
 * took deliberately. `body.heart_rate` below is a stream: several hundred
 * readings a day, none of them chosen. Collapsing them would make "my resting
 * heart rate" mean two different things depending on which row answered, and
 * §9.2's whole argument for per-metric aggregation is that the registry is what
 * stops a chart mixing them.
 *
 * The one exception is {@link VITAL_METRICS.spo2}, which the mapping table
 * reuses deliberately — a watch's blood-oxygen reading and a pulse oximeter's
 * are the same measurement by the same method, and there is no honest reason to
 * split them. That decision is recorded at the mapping, not here.
 *
 * ## Aggregation is the interesting column
 *
 * It is what the downsampler reads when it collapses 90-day-old raw rows into
 * hourly buckets (§9.7), so getting it wrong here silently corrupts every
 * long-range chart *after* the raw rows are gone. Summing heart rate over an
 * hour is meaningless; averaging step count under-reports a day by a factor of
 * sixty. Each choice below is the one that survives the raw rows being dropped.
 */

import type { MetricDefinition, MetricKey } from '../../observations/metric';

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
    /* A device stream is never a Daily Close field. §4.0 budgets the Close at
     * eleven elements and every one of them is a thing only a human knows; a
     * number the watch already has is the opposite of that. */
    inDailyClose: false,
  };
}

/** Stable keys, so the mapping table and the importer cannot drift apart. */
export const WEARABLE_METRICS = Object.freeze({
  heartRate: 'body.heart_rate',
  heartRateVariability: 'body.heart_rate.variability',
  steps: 'body.steps',
  activeEnergy: 'body.energy.active',
  basalEnergy: 'body.energy.basal',
  walkingDistance: 'body.distance.walking',
  respiratoryRate: 'body.respiratory_rate',
  exerciseMinutes: 'body.exercise.minutes',
  flightsClimbed: 'body.flights_climbed',
});

export type WearableMetricName = keyof typeof WEARABLE_METRICS;

export const WEARABLE_METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze([
  metric({
    key: WEARABLE_METRICS.heartRate,
    domain: 'body',
    displayName: 'Heart rate',
    description:
      'A single heart-rate reading in beats per minute, taken by a wrist-worn optical sensor rather than chosen by the wearer. Hundreds arrive per day, at irregular intervals the device decides. This is distinct from the resting heart rate recorded as a vital sign: that is one deliberate measurement under known conditions, this is an ambient stream that includes climbing stairs, sitting in traffic, and sleeping. Averaging the stream does not give you the resting rate.',
    valueType: 'integer',
    canonicalUnit: 'bpm',
    /* A wrist sensor reports nonsense during motion, and the bounds are the
     * cheapest place to catch it. 20 excludes a dropped signal reading 0;
     * 250 is above any real human maximum and below the sensor's confusion. */
    minValue: '20',
    maxValue: '250',
    aggregation: 'mean',
  }),
  metric({
    key: WEARABLE_METRICS.heartRateVariability,
    domain: 'body',
    displayName: 'Heart rate variability (SDNN)',
    description:
      'The standard deviation of beat-to-beat intervals over a measurement window, in milliseconds, as reported by the device. Higher is generally associated with recovery and lower with strain, but the absolute number is only comparable against the same person on the same device — cross-device and cross-person comparison of HRV is not meaningful, and this system will not offer one.',
    valueType: 'numeric',
    canonicalUnit: 'ms',
    minValue: '1',
    maxValue: '500',
    aggregation: 'mean',
  }),
  metric({
    key: WEARABLE_METRICS.steps,
    domain: 'body',
    displayName: 'Steps',
    description:
      'Steps counted in one reporting interval, not a running daily total. The distinction matters: the device emits many short intervals per day and summing them gives the day, whereas treating each as a cumulative total and taking the last would give whatever the final interval happened to be.',
    valueType: 'integer',
    canonicalUnit: 'count',
    minValue: '0',
    aggregation: 'sum',
  }),
  metric({
    key: WEARABLE_METRICS.activeEnergy,
    domain: 'body',
    displayName: 'Active energy',
    description:
      'Energy the device attributes to movement above resting, in kilocalories, for one reporting interval. This is a model output, not a measurement — every wearable estimates it from heart rate and motion using an undisclosed formula. Useful as a relative trend for one person on one device; not comparable to a food label kilocalorie, and never to be netted against intake.',
    valueType: 'numeric',
    canonicalUnit: 'kcal',
    minValue: '0',
    aggregation: 'sum',
  }),
  metric({
    key: WEARABLE_METRICS.basalEnergy,
    domain: 'body',
    displayName: 'Basal energy',
    description:
      'The device estimate of resting metabolic expenditure over one reporting interval, in kilocalories. Derived from height, weight, age and sex through a standard equation rather than measured, so it changes only when those inputs change. Recorded for completeness of the export; it carries almost no day-to-day information.',
    valueType: 'numeric',
    canonicalUnit: 'kcal',
    minValue: '0',
    aggregation: 'sum',
  }),
  metric({
    key: WEARABLE_METRICS.walkingDistance,
    domain: 'body',
    displayName: 'Walking and running distance',
    description:
      'Distance covered on foot in one reporting interval, in kilometres. Stored in kilometres regardless of what the source reported, because §5.3 requires a single canonical unit per metric — a five-year trend must never have to reconcile miles against kilometres mid-series.',
    valueType: 'numeric',
    canonicalUnit: 'km',
    minValue: '0',
    aggregation: 'sum',
  }),
  metric({
    key: WEARABLE_METRICS.respiratoryRate,
    domain: 'body',
    displayName: 'Respiratory rate',
    description:
      'Breaths per minute, as estimated by the device, almost always during sleep. Wearables do not measure this while awake with any reliability, so a gap during the day is the sensor being honest rather than data missing.',
    valueType: 'numeric',
    canonicalUnit: 'breaths/min',
    minValue: '4',
    maxValue: '60',
    aggregation: 'mean',
  }),
  metric({
    key: WEARABLE_METRICS.exerciseMinutes,
    domain: 'body',
    displayName: 'Exercise minutes',
    description:
      'Minutes the device classified as exercise in one reporting interval. A device judgement, not a log of what was done — the gym session recorded in Gym is the record of training, and this is what the watch made of it. They will disagree, and both are kept.',
    valueType: 'numeric',
    canonicalUnit: 'min',
    minValue: '0',
    aggregation: 'sum',
  }),
  metric({
    key: WEARABLE_METRICS.flightsClimbed,
    domain: 'body',
    displayName: 'Flights climbed',
    description:
      'Flights of stairs ascended in one reporting interval, as counted by the barometric altimeter. A flight is roughly three metres of elevation gain, so a hill counts and a lift does not.',
    valueType: 'integer',
    canonicalUnit: 'count',
    minValue: '0',
    aggregation: 'sum',
  }),
]);

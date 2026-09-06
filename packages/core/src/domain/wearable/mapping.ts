/**
 * Platform identifiers → registered metrics, and foreign units → canonical ones.
 *
 * Apple Health and Google Fit each have their own vocabulary, their own units,
 * and their own opinions about what a "sample" is. This file is the whole of
 * that translation, deliberately in one place: §9.2 makes the metric registry
 * the single vocabulary, so every dialect has to be reduced to it exactly once,
 * and a conversion factor scattered across an importer is a conversion factor
 * that will be applied twice.
 *
 * ## An unmapped identifier is skipped, not rejected
 *
 * An Apple Health export contains well over a hundred quantity types, most of
 * which this system has no metric for and no intention of adding one. If an
 * unknown identifier failed the batch, the first real export would fail and the
 * operator's only recourse would be to edit an XML file. So unknowns are
 * counted and named in the outcome instead — visible, so the list is a
 * shopping list for the next metric worth registering, and harmless.
 *
 * The opposite failure — a *known* identifier arriving in an unexpected unit —
 * **does** fail the row, because silently storing pounds in a column that means
 * kilograms is the single worst thing an importer can do. §5.3's canonical-unit
 * rule exists precisely so that a five-year trend cannot be poisoned this way.
 */

import { VITAL_METRICS } from '../health/vitals';
import { WEARABLE_METRICS } from './metrics';

/** Which export produced a batch. Recorded on the provenance row (§9.2). */
export type WearablePlatform = 'apple_health' | 'google_fit';

export const WEARABLE_PLATFORMS: readonly WearablePlatform[] = ['apple_health', 'google_fit'];

export const WEARABLE_PLATFORM_LABELS: Readonly<Record<WearablePlatform, string>> = Object.freeze({
  apple_health: 'Apple Health',
  google_fit: 'Google Fit',
});

/**
 * One translation rule.
 *
 * `factors` is keyed by the *source* unit spelled exactly as the platform
 * spells it, mapping to what that unit must be multiplied by to reach the
 * metric's canonical unit. A factor of 1 is written out rather than omitted, so
 * that "this unit is accepted" and "this unit needs no conversion" are the same
 * kind of statement and neither can be inferred by accident.
 */
export type MetricMapping = {
  readonly metricKey: string;
  readonly canonicalUnit: string;
  readonly factors: Readonly<Record<string, number>>;
};

/* Apple writes units with a slash and no spaces: `count/min`, `kcal`, `km`. */
const APPLE: Readonly<Record<string, MetricMapping>> = Object.freeze({
  HKQuantityTypeIdentifierHeartRate: {
    metricKey: WEARABLE_METRICS.heartRate,
    canonicalUnit: 'bpm',
    factors: { 'count/min': 1, bpm: 1 },
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    metricKey: WEARABLE_METRICS.heartRateVariability,
    canonicalUnit: 'ms',
    factors: { ms: 1, s: 1000 },
  },
  HKQuantityTypeIdentifierStepCount: {
    metricKey: WEARABLE_METRICS.steps,
    canonicalUnit: 'count',
    factors: { count: 1 },
  },
  HKQuantityTypeIdentifierActiveEnergyBurned: {
    metricKey: WEARABLE_METRICS.activeEnergy,
    canonicalUnit: 'kcal',
    factors: { kcal: 1, Cal: 1, kJ: 0.239006 },
  },
  HKQuantityTypeIdentifierBasalEnergyBurned: {
    metricKey: WEARABLE_METRICS.basalEnergy,
    canonicalUnit: 'kcal',
    factors: { kcal: 1, Cal: 1, kJ: 0.239006 },
  },
  HKQuantityTypeIdentifierDistanceWalkingRunning: {
    metricKey: WEARABLE_METRICS.walkingDistance,
    canonicalUnit: 'km',
    factors: { km: 1, m: 0.001, mi: 1.609344, ft: 0.0003048 },
  },
  HKQuantityTypeIdentifierRespiratoryRate: {
    metricKey: WEARABLE_METRICS.respiratoryRate,
    canonicalUnit: 'breaths/min',
    factors: { 'count/min': 1 },
  },
  HKQuantityTypeIdentifierAppleExerciseTime: {
    metricKey: WEARABLE_METRICS.exerciseMinutes,
    canonicalUnit: 'min',
    factors: { min: 1, s: 1 / 60, hr: 60 },
  },
  HKQuantityTypeIdentifierFlightsClimbed: {
    metricKey: WEARABLE_METRICS.flightsClimbed,
    canonicalUnit: 'count',
    factors: { count: 1 },
  },
  /*
   * Deliberately mapped onto the *vital*, not a new stream metric.
   *
   * A watch's blood-oxygen reading and a fingertip pulse oximeter's are the
   * same measurement by the same method (transmissive vs reflective
   * photoplethysmography), differing in reliability rather than in meaning.
   * Splitting them would give the operator two SpO2 charts and no honest way to
   * say which one is their oxygen saturation. Apple reports it as a fraction;
   * the vital is registered as a percentage, hence the factor.
   */
  HKQuantityTypeIdentifierOxygenSaturation: {
    metricKey: VITAL_METRICS.oxygenSaturation,
    canonicalUnit: 'percent',
    factors: { '%': 1, count: 100 },
  },
});

/* Google spells its streams as reverse-DNS data type names. */
const GOOGLE: Readonly<Record<string, MetricMapping>> = Object.freeze({
  'com.google.heart_rate.bpm': {
    metricKey: WEARABLE_METRICS.heartRate,
    canonicalUnit: 'bpm',
    factors: { bpm: 1 },
  },
  'com.google.step_count.delta': {
    metricKey: WEARABLE_METRICS.steps,
    canonicalUnit: 'count',
    factors: { count: 1 },
  },
  'com.google.calories.expended': {
    metricKey: WEARABLE_METRICS.activeEnergy,
    canonicalUnit: 'kcal',
    factors: { kcal: 1 },
  },
  'com.google.calories.bmr': {
    metricKey: WEARABLE_METRICS.basalEnergy,
    canonicalUnit: 'kcal',
    factors: { kcal: 1 },
  },
  /* Google reports distance in metres; the metric is kilometres. */
  'com.google.distance.delta': {
    metricKey: WEARABLE_METRICS.walkingDistance,
    canonicalUnit: 'km',
    factors: { m: 0.001, km: 1 },
  },
  'com.google.active_minutes': {
    metricKey: WEARABLE_METRICS.exerciseMinutes,
    canonicalUnit: 'min',
    factors: { min: 1 },
  },
  'com.google.oxygen_saturation': {
    metricKey: VITAL_METRICS.oxygenSaturation,
    canonicalUnit: 'percent',
    factors: { '%': 1 },
  },
});

const TABLES: Readonly<Record<WearablePlatform, Readonly<Record<string, MetricMapping>>>> = Object.freeze({
  apple_health: APPLE,
  google_fit: GOOGLE,
});

/** `null` for an identifier this system has no metric for. Not an error. */
export function mappingFor(platform: WearablePlatform, identifier: string): MetricMapping | null {
  return TABLES[platform][identifier] ?? null;
}

/** Every identifier a platform can supply, for the import screen's help text. */
export function mappedIdentifiers(platform: WearablePlatform): readonly string[] {
  return Object.keys(TABLES[platform]).sort();
}

/**
 * Convert a value into the metric's canonical unit.
 *
 * Returns `null` for a unit the mapping does not list, which the caller must
 * treat as a rejected row rather than as a passthrough. That asymmetry with
 * {@link mappingFor} is the point: an unknown *metric* is a gap in this
 * system's vocabulary and is safe to skip, while an unknown *unit* on a metric
 * we do understand means the number's meaning is unknown, and storing a number
 * whose meaning is unknown is how a longitudinal record dies.
 */
/*
 * Named for the conversion rather than the destination, because
 * `domain/health/analyte.ts` already exports a `toCanonical` for lab units. Two
 * functions with one name doing the same job for two vocabularies is exactly
 * the kind of thing that gets called on the wrong input.
 */
export function convertToCanonical(mapping: MetricMapping, value: number, unit: string): number | null {
  const factor = mapping.factors[unit.trim()];
  if (factor === undefined) return null;
  return value * factor;
}

/** The units a mapping accepts, for the error message when one is refused. */
export function acceptedUnits(mapping: MetricMapping): readonly string[] {
  return Object.keys(mapping.factors);
}

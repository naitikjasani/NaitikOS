/**
 * The prediction engine, driven — §10.9.
 *
 * Two nightly steps and one read.
 *
 * ## Resolution runs before generation, and the order is load-bearing
 *
 * Tonight's new prediction is fitted over a window that includes today's
 * reading. Yesterday's prediction *about* today has to be scored against that
 * same reading first. Reversed, a run could resolve a prediction against a
 * series the same run had already extended — which is not the comparison §10.9
 * asks for, and would be invisible in the result.
 *
 * ## The id is derived, not minted
 *
 * A retried evening must write the same rows twice and land on one. §10.9's
 * whole value is the calibration record, and a run that doubled the
 * denominator every time it was retried would make that record meaningless.
 * The id is a UUIDv5-shaped digest over the subject and the horizon, so the
 * second write hits `ON CONFLICT DO NOTHING` rather than adding a row.
 *
 * ## Nothing here decides what may be predicted
 *
 * `makePrediction` refuses a prohibited subject before it does any arithmetic,
 * and the enum has no member a clinical prediction could be written under. This
 * file only names the subjects worth asking about tonight; the gate is below it.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok, uuidV7 } from '@naitikos/shared';
import type {
  CalibrationReport,
  DailyValue,
  DomainError,
  MetricDefinition,
  Prediction,
  PredictionKind,
} from '@naitikos/core';
import {
  MAX_HORIZON_DAYS,
  calibrationOver,
  dailyRollup,
  dayKeyInZone,
  isoFromMillis,
  makePrediction,
  resolvePrediction,
  shiftDayKey,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createMetricRepository,
  createObservationRepository,
  createPredictionRepository,
} from '@naitikos/db';

/**
 * How far ahead tonight's predictions look.
 *
 * Fourteen days, half the `MAX_HORIZON_DAYS` cap. Far enough that the answer is
 * not obvious from looking at the last week, near enough that the operator is
 * still around to see whether it was right — a calibration record built from
 * 28-day horizons takes a month to produce its first data point.
 */
export const PREDICTION_HORIZON_DAYS = 14;

/** How much history each fit reads. */
export const PREDICTION_WINDOW_DAYS = 90;

/**
 * What gets predicted each night.
 *
 * A short, hand-written list rather than "every permitted metric". §10.9 caps
 * what is *allowed*; this is a judgement about what is *worth asking*, and the
 * two are different. Every prediction generated is a row that has to be scored
 * and that lands in the calibration denominator — predicting nine metrics
 * nobody looks at would dilute the track record of the one that matters.
 */
export const NIGHTLY_SUBJECTS: readonly {
  readonly kind: PredictionKind;
  readonly metricKey: string;
}[] = Object.freeze([
  { kind: 'bodyweight_projection', metricKey: 'body.weight' },
  { kind: 'load_progression', metricKey: 'gym.session.volume' },
]);

/**
 * A stable id for a subject on a night.
 *
 * `uuidV7` takes a timestamp, so the same subject on the same evening produces
 * the same value — which is what makes `record` a no-op on a retry. The day is
 * folded into the timestamp and the subject into the low bits by seeding from a
 * digest of the key, so two subjects on one night do not collide.
 */
function predictionId(dayKey: string, kind: string, metricKey: string): string {
  let hash = 2_166_136_261;
  for (const char of `${dayKey}|${kind}|${metricKey}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  /*
   * UUIDv7's timestamp is milliseconds; the remaining bits are random in the
   * general case. Seeding them from the digest instead makes the value a pure
   * function of its inputs, which is the property a replayed nightly run needs.
   */
  const digits = hash.toString(16).padStart(8, '0');
  const minted = uuidV7(Date.parse(`${dayKey}T00:00:00.000Z`));
  return `${minted.slice(0, 24)}${digits}${minted.slice(32)}`.slice(0, 36);
}

export type PredictionRun = {
  readonly predicted: number;
  readonly insufficient: number;
  readonly refused: number;
  readonly notes: readonly string[];
};

/**
 * Tonight's predictions.
 *
 * An `insufficient` subject is counted and skipped, never written. §10.9
 * requires degrading to "insufficient data" rather than guessing, and storing
 * a row that says "we could not say" would put a prediction with no interval
 * into a table whose entire purpose is scoring intervals.
 */
export async function generatePredictions(
  db: Database,
  zone: string,
): Promise<Result<PredictionRun, DomainError>> {
  const predictions = createPredictionRepository(db);
  const metrics = createMetricRepository(db);
  const observations = createObservationRepository(db);

  const registry = await metrics.registry();
  if (!registry.ok) return registry;

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const horizonDayKey = shiftDayKey(todayDayKey, PREDICTION_HORIZON_DAYS);
  const fromDayKey = shiftDayKey(todayDayKey, -PREDICTION_WINDOW_DAYS);
  if (horizonDayKey === null || fromDayKey === null) {
    return ok({ predicted: 0, insufficient: 0, refused: 0, notes: ['Could not resolve a horizon.'] });
  }

  let predicted = 0;
  let insufficient = 0;
  let refused = 0;
  const notes: string[] = [];

  for (const subject of NIGHTLY_SUBJECTS) {
    const definition: MetricDefinition | null = registry.value.get(subject.metricKey);
    if (definition === null) {
      /* A metric that is not registered is a configuration problem, not a
       * prediction failure. Counted and named rather than thrown — one absent
       * key must not stop the other subjects. */
      refused += 1;
      notes.push(`${subject.metricKey} is not in the registry.`);
      continue;
    }

    const rows = await observations.query({
      metricKeys: [subject.metricKey],
      from: isoFromMillis(systemClock.nowMillis() - PREDICTION_WINDOW_DAYS * 86_400_000),
      until: isoFromMillis(systemClock.nowMillis() + 86_400_000),
      /* Superseded readings are excluded. §9.1 makes a correction a new row, and
       * fitting a line through both the wrong value and its replacement would
       * let a corrected typo bend every projection that followed it. */
      currentOnly: true,
    });
    if (!rows.ok) return rows;

    const series: readonly DailyValue[] = dailyRollup(rows.value, definition, { zone });

    const outcome = makePrediction(
      {
        id: predictionId(todayDayKey, subject.kind, subject.metricKey),
        kind: subject.kind,
        metricKey: subject.metricKey,
        horizonDayKey,
        madeAt: nowIso,
        unit: definition.canonicalUnit,
      },
      series,
      todayDayKey,
    );

    if (!outcome.ok) {
      /*
       * A refusal is a fact about the request, not a failure of the run. A
       * prohibited subject or an over-long horizon is counted and named; the
       * remaining subjects still get their predictions.
       */
      refused += 1;
      notes.push(`${subject.metricKey}: ${outcome.error.message}`);
      continue;
    }

    if (outcome.value.status === 'insufficient') {
      insufficient += 1;
      notes.push(`${subject.metricKey}: ${outcome.value.reason}`);
      continue;
    }

    const written = await predictions.record(outcome.value.prediction);
    if (!written.ok) return written;
    predicted += 1;
  }

  return ok({ predicted, insufficient, refused, notes });
}

export type ResolutionRun = {
  readonly scored: number;
  readonly hits: number;
  readonly unresolvable: number;
};

/**
 * Score every prediction whose horizon has arrived.
 *
 * A horizon day with no reading produces an `unresolvableReason`, never a miss.
 * That distinction is the one thing this function exists to protect: counting
 * the operator's silence as an engine failure would make the calibration record
 * a measure of logging discipline rather than of the engine.
 */
export async function resolveDuePredictions(
  db: Database,
  zone: string,
): Promise<Result<ResolutionRun, DomainError>> {
  const predictions = createPredictionRepository(db);
  const metrics = createMetricRepository(db);
  const observations = createObservationRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);

  const due = await predictions.pending(todayDayKey);
  if (!due.ok) return due;
  if (due.value.length === 0) return ok({ scored: 0, hits: 0, unresolvable: 0 });

  const registry = await metrics.registry();
  if (!registry.ok) return registry;

  let scored = 0;
  let hits = 0;
  let unresolvable = 0;

  for (const prediction of due.value) {
    const definition = registry.value.get(prediction.metricKey);

    let actual: string | null = null;
    if (definition !== null) {
      /*
       * A day's worth of readings, bounded by the zoned day rather than by a
       * UTC one. §5.3: an evening reading in Asia/Kolkata belongs to that date,
       * and scoring it against the following day would compare a prediction to
       * the wrong morning.
       */
      const bounds = zonedDayBounds(prediction.horizonDayKey, zone);
      const rows = await observations.query({
        metricKeys: [prediction.metricKey],
        ...(bounds === null ? {} : { from: bounds.start, until: bounds.end }),
        currentOnly: true,
      });
      if (!rows.ok) return rows;

      const day = dailyRollup(rows.value, definition, { zone }).find(
        (entry) => entry.dayKey === prediction.horizonDayKey,
      );
      actual = day === undefined ? null : String(day.value);
    }

    const resolution = resolvePrediction(prediction, actual);
    const written = await predictions.resolve({
      id: prediction.id,
      at: nowIso,
      ...('unresolvableReason' in resolution
        ? { unresolvableReason: resolution.unresolvableReason }
        : { resolvedValue: resolution.resolvedValue, wasWithinInterval: resolution.wasWithinInterval }),
    });
    if (!written.ok) return written;

    if ('unresolvableReason' in resolution) unresolvable += 1;
    else {
      scored += 1;
      if (resolution.wasWithinInterval) hits += 1;
    }
  }

  return ok({ scored, hits, unresolvable });
}

export type CalibrationBoard = {
  readonly report: CalibrationReport;
  readonly recent: readonly Prediction[];
  readonly open: readonly Prediction[];
  readonly horizonDays: number;
  readonly maxHorizonDays: number;
};

export async function loadCalibration(db: Database): Promise<Result<CalibrationBoard, DomainError>> {
  const predictions = createPredictionRepository(db);

  const all = await predictions.all(300);
  if (!all.ok) return all;

  return ok({
    report: calibrationOver(all.value),
    recent: all.value.filter((row) => row.resolvedAt !== null).slice(0, 50),
    open: all.value.filter((row) => row.resolvedAt === null),
    horizonDays: PREDICTION_HORIZON_DAYS,
    maxHorizonDays: MAX_HORIZON_DAYS,
  });
}

/**
 * The engine's own track record — §10.9's condition for being allowed to exist.
 *
 *   "Predictions ... must be retrospectively scored — every prediction is
 *    stored and compared against what actually happened, with the calibration
 *    record visible to the user. **A prediction engine that does not report its
 *    own track record is asking for trust it has not earned.**"
 *
 * `predict.ts` makes the claims. This file is the part that makes them worth
 * anything, and it is written to be unflattering: every rule below costs the
 * engine a number it would otherwise get to show.
 *
 * ## An unanswered horizon is not a miss
 *
 * The single most important rule here, and the schema already says it:
 *
 *   "A horizon that arrives with no observation on it is not a miss — it is an
 *    unanswered question, and counting it as either a hit or a miss would
 *    corrupt the calibration record in one direction or the other."
 *
 * So {@link resolvePrediction} returns an `unresolvableReason` for a missing
 * reading, {@link calibrationOver} counts those separately, and they are
 * **excluded from the hit rate's denominator entirely**. Counting them as
 * misses would punish the engine for the operator skipping a weigh-in; counting
 * them as hits would be the obvious fraud.
 *
 * ## A hit rate needs a sample
 *
 * `hitRate` is `null` below {@link MIN_CALIBRATION_SAMPLE}. Two predictions
 * both landing inside their intervals is not a 100% track record, it is two
 * predictions, and rendering "100%" next to it would be the single most
 * misleading number this system could produce about itself.
 *
 * ## Too wide is a fault too
 *
 * A well-calibrated 95% interval contains the truth about 95% of the time. Both
 * directions of departure are faults, and only one of them is intuitive:
 *
 * - Well **below** nominal coverage: the intervals are too narrow, and the
 *   engine is claiming more precision than it has. This is the failure people
 *   look for.
 * - Persistently **at or above** nominal coverage: the intervals are too wide.
 *   An interval that never misses is one that was never a claim — "your weight
 *   will be somewhere between 60 and 100 kg" is unfalsifiable and useless, and
 *   a report that praised it would be rewarding the engine for saying nothing.
 *
 * {@link calibrationOver} names both in its verdict.
 *
 * ## No grades
 *
 * §10.0: the system describes, it does not score the operator — and it does not
 * get to award itself a letter either. `verdict` is a sentence of counts. There
 * is no A/B/C, no "good", no "poor". The reader does the judging; the engine's
 * job is to hand over the arithmetic without a thumb on it.
 */

import type { Prediction, PredictionKind } from './predict';
import { PREDICTION_KINDS } from './predict';

/**
 * The outcome of comparing one prediction to what happened.
 *
 * A union rather than a record with three nullable fields, because the two
 * cases are genuinely different facts and the schema's
 * `prediction_resolution_complete` CHECK enforces exactly this shape: a value
 * with a verdict, or a reason. A caller cannot accidentally write half of one.
 */
export type Resolution =
  | { readonly resolvedValue: string; readonly wasWithinInterval: boolean }
  | { readonly unresolvableReason: string };

/** The reason a horizon most often cannot be scored, spelled one way. */
export const NO_OBSERVATION_REASON = 'No reading was recorded on the horizon day.';

/**
 * Score one prediction against the day's actual reading.
 *
 * @param actual The reading on the horizon day as a decimal string, or `null`
 *   when there was none. `null` is the ordinary case, not an error case — a
 *   person misses a weigh-in.
 */
export function resolvePrediction(p: Prediction, actual: string | null): Resolution {
  if (actual === null) return { unresolvableReason: NO_OBSERVATION_REASON };

  const value = actual.trim();
  const observed = Number(value);
  const low = Number(p.intervalLow);
  const high = Number(p.intervalHigh);

  if (value === '' || !Number.isFinite(observed) || !Number.isFinite(low) || !Number.isFinite(high)) {
    /* Unparseable rather than wrong. The engine does not get to score itself
     * against a number it could not read, in either direction. */
    return { unresolvableReason: 'The reading on the horizon day could not be read as a number.' };
  }

  /*
   * Closed interval. A value that lands exactly on a bound is inside it: the
   * bounds are stored to six decimal places and a reading that ties with one is
   * a rounding coincidence, not a miss. Counting it as a miss would make the
   * hit rate depend on the column's scale.
   */
  return { resolvedValue: value, wasWithinInterval: observed >= low && observed <= high };
}

/**
 * Scored predictions needed before a hit rate is reported at all.
 *
 * Ten is a judgement, not a derivation. It is the point at which one miss moves
 * the rate by ten points rather than by fifty, which is roughly where a
 * percentage stops being theatre.
 */
export const MIN_CALIBRATION_SAMPLE = 10;

/**
 * The coverage the intervals are drawn at.
 *
 * `statistics/trend.ts` uses a 1.96 multiplier — the normal approximation to
 * 95%. It is stated here because the verdict compares against it, and a report
 * that said "83% of predictions landed inside" without saying what the interval
 * was aiming for would be a number with no scale.
 */
export const NOMINAL_COVERAGE = 0.95;

/**
 * How far below nominal coverage before the verdict says the intervals are too
 * narrow. Ten points, which at n = 10 is one prediction — deliberately not
 * tighter, because a single miss should not produce a sentence about the
 * engine's calibration.
 */
export const COVERAGE_TOLERANCE = 0.1;

export type CalibrationReport = {
  /** Predictions with a verdict. The hit rate's denominator, and nothing else. */
  readonly resolved: number;
  readonly withinInterval: number;
  /** Horizons that arrived with nothing to score against. Never a miss. */
  readonly unresolvable: number;
  /** Horizons that have not arrived yet. */
  readonly pending: number;
  /** `null` below {@link MIN_CALIBRATION_SAMPLE}. */
  readonly hitRate: number | null;
  readonly byKind: readonly {
    readonly kind: PredictionKind;
    readonly resolved: number;
    readonly withinInterval: number;
    readonly hitRate: number | null;
  }[];
  /** In the metric's own unit, and `null` when the sample spans more than one. */
  readonly meanAbsoluteError: number | null;
  /** A sentence of counts. Never a grade — see the header. */
  readonly verdict: string;
};

type Bucket = { resolved: number; withinInterval: number };

/**
 * The whole record, over whatever set of predictions is handed in.
 *
 * Takes the predictions rather than reaching for a repository, so the same
 * function serves "all time", "this quarter" and "bodyweight only" without
 * three queries' worth of variation living in `core`.
 */
export function calibrationOver(predictions: readonly Prediction[]): CalibrationReport {
  const overall: Bucket = { resolved: 0, withinInterval: 0 };
  const perKind = new Map<PredictionKind, Bucket>();
  let unresolvable = 0;
  let pending = 0;

  const errors: number[] = [];
  const units = new Set<string>();

  for (const p of predictions) {
    if (p.resolvedAt === null) {
      pending += 1;
      continue;
    }

    /*
     * The verdict bit is what makes a row scorable, so it is tested before the
     * reason. A row can carry both — an engine that scored a prediction and
     * also noted something about it — and in that case the verdict is the fact
     * the calibration record is about.
     */
    if (p.wasWithinInterval === null) {
      unresolvable += 1;
      continue;
    }

    overall.resolved += 1;
    if (p.wasWithinInterval) overall.withinInterval += 1;

    const bucket = perKind.get(p.kind) ?? { resolved: 0, withinInterval: 0 };
    bucket.resolved += 1;
    if (p.wasWithinInterval) bucket.withinInterval += 1;
    perKind.set(p.kind, bucket);

    units.add(p.unit);
    const observed = p.resolvedValue === null ? Number.NaN : Number(p.resolvedValue);
    const predicted = Number(p.predictedValue);
    if (Number.isFinite(observed) && Number.isFinite(predicted)) errors.push(Math.abs(observed - predicted));
  }

  const hitRate = rateOver(overall);

  return {
    resolved: overall.resolved,
    withinInterval: overall.withinInterval,
    unresolvable,
    pending,
    hitRate,
    /*
     * In `PREDICTION_KINDS` order, and only for kinds that have a scored
     * prediction. A kind with no predictions is not a row of zeroes on a
     * report — it is a kind nobody has asked about, and rendering it as 0/0
     * invites reading it as a failure.
     */
    byKind: PREDICTION_KINDS.flatMap((kind) => {
      const bucket = perKind.get(kind);
      if (bucket === undefined) return [];
      return [{ kind, resolved: bucket.resolved, withinInterval: bucket.withinInterval, hitRate: rateOver(bucket) }];
    }),
    meanAbsoluteError: meanAbsolute(errors, units),
    verdict: verdictFor(overall, unresolvable, pending, hitRate),
  };
}

/** The gate, applied identically to the whole and to each kind. */
function rateOver(bucket: Bucket): number | null {
  if (bucket.resolved < MIN_CALIBRATION_SAMPLE) return null;
  return bucket.withinInterval / bucket.resolved;
}

/**
 * Mean absolute error, or `null`.
 *
 * **Not gated by {@link MIN_CALIBRATION_SAMPLE}**, unlike the hit rate, and the
 * asymmetry is deliberate. A hit *rate* is a claim about how the engine will
 * behave next time, and a claim needs a sample. A mean error is a description
 * of the errors that actually occurred — over three predictions it describes
 * three predictions, honestly, and withholding it would hide information rather
 * than avoid a false one.
 *
 * `null` when the sample spans more than one unit, because the mean of a
 * kilogram error and a repetition error is a number with no dimension. §6.2 is
 * blunt about why that matters: "unit confusion in a medical record is a real,
 * documented category of harm."
 */
function meanAbsolute(errors: readonly number[], units: ReadonlySet<string>): number | null {
  if (errors.length === 0 || units.size !== 1) return null;
  return errors.reduce((total, value) => total + value, 0) / errors.length;
}

/**
 * The sentence the calibration surface renders.
 *
 * Counts first, because counts are the thing that cannot be argued with. The
 * calibration commentary is appended only once there is a rate to comment on,
 * and it names both failure directions — see the header on why "never misses"
 * is a fault.
 */
function verdictFor(overall: Bucket, unresolvable: number, pending: number, hitRate: number | null): string {
  const parts: string[] = [];

  if (overall.resolved === 0) {
    parts.push(
      pending === 0 && unresolvable === 0
        ? 'No predictions have been made yet.'
        : 'No prediction has been scored yet.',
    );
  } else {
    parts.push(`${String(overall.withinInterval)} of ${String(overall.resolved)} landed inside the stated interval.`);
  }

  if (pending > 0) {
    parts.push(`${String(pending)} ${pending === 1 ? 'is' : 'are'} still waiting for the horizon to arrive.`);
  }
  if (unresolvable > 0) {
    parts.push(
      `${String(unresolvable)} could not be scored because nothing was recorded on the day, and ${unresolvable === 1 ? 'it is' : 'those are'} left out of the rate rather than counted as a miss.`,
    );
  }

  if (hitRate === null) {
    if (overall.resolved > 0) {
      parts.push(
        `A hit rate is withheld until ${String(MIN_CALIBRATION_SAMPLE)} predictions have been scored; ${String(overall.resolved)} have.`,
      );
    }
    return parts.join(' ');
  }

  const nominal = `${String(Math.round(NOMINAL_COVERAGE * 100))}%`;
  if (hitRate < NOMINAL_COVERAGE - COVERAGE_TOLERANCE) {
    parts.push(`That is short of the ${nominal} the intervals are drawn at, which means they are too narrow.`);
  } else if (overall.withinInterval === overall.resolved) {
    parts.push(
      `Nothing has missed, against intervals drawn at ${nominal}. An interval that never misses is too wide to be a claim, which is a fault in the other direction.`,
    );
  } else {
    parts.push(`The intervals are drawn at ${nominal}.`);
  }

  return parts.join(' ');
}

/**
 * The prediction engine — §10.9, and deliberately the least clever module here.
 *
 * §10.9 sets the method and the tone in two sentences:
 *
 *   "Classical, interpretable methods only: linear and loess trend
 *    extrapolation with prediction intervals, seasonal decomposition where a
 *    cycle is established, and simple state models for adherence probability.
 *    **No machine learning.**"
 *
 * So this file fits a straight line with `statistics/trend.ts` and stops. There
 * is no second regression implementation in here: `linearTrend`, `trendBand`
 * and `projectForward` are already built, already tested, and already carry the
 * autocorrelation caveat that any interval drawn from daily self-measurements
 * has to carry. A second copy would be a second set of caveats to keep in sync.
 *
 * ## Three rules, and each of them is a refusal
 *
 * §10.9 again:
 *
 *   "Predictions must state their interval and their assumptions, must degrade
 *    to *'insufficient data'* rather than guessing, and must be retrospectively
 *    scored — every prediction is stored and compared against what actually
 *    happened, with the calibration record visible to the user. **A prediction
 *    engine that does not report its own track record is asking for trust it
 *    has not earned.**"
 *
 * 1. **Insufficient is an answer, not an error.** {@link PredictionOutcome}
 *    carries it as a status. Below {@link MIN_PREDICTION_OBSERVATIONS} paired
 *    days there is no prediction, and the screen says so in words — which is
 *    the behaviour §10.9 asks for and the opposite of a point estimate drawn
 *    through five readings.
 * 2. **A horizon past {@link MAX_HORIZON_DAYS} is refused outright** — an
 *    `err`, not an `insufficient`. See the constant.
 * 3. **The interval is never optional and the assumptions are never empty.**
 *    Both are `notNull` in the schema for the same reason, and both are
 *    generated here rather than left to a caller.
 *
 * ## What may not be predicted
 *
 * §10.9: "Permitted: goal trajectory, bodyweight projection under current
 * intake, next-session load progression, adherence-risk flagging. **Prohibited:
 * any prediction about a clinical outcome, a symptom course, or a medication
 * response.**"
 *
 * The `prediction_kind` enum is the structural half — there is no
 * `clinical_outcome` member. That is not sufficient on its own: a
 * `goal_trajectory` prediction pointed at `body.symptom.intensity` is a symptom
 * course wearing a permitted kind. {@link PERMITTED_METRICS} is the second
 * gate, it is a closed allowlist rather than a denylist, and
 * {@link makePrediction} checks it before it does any arithmetic at all.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { preconditionFailedError, validationError } from '../../errors/domain-error';
import { collapseByDay } from '../../statistics/moving-average';
import type { DailyValue } from '../../statistics/types';
import { MAX_PROJECTION_DAYS, TREND_CAVEAT, linearTrend, projectForward } from '../../statistics/trend';
import { dayKeyIndex } from '../../temporal/instant';
import { QUANTITY_PRECISION, QUANTITY_SCALE } from '../../units/decimal';

/* =========================================================================
 * The vocabulary, mirroring `schema/enums.ts`
 * ====================================================================== */

/**
 * The four things this engine is allowed to be about.
 *
 * Mirrors the `prediction_kind` pgEnum member for member. §10.9's permitted
 * list is exactly these four, and the absence of a clinical member is the
 * point: a prohibited prediction has no kind to be written under.
 */
export const PREDICTION_KINDS = [
  'goal_trajectory',
  'bodyweight_projection',
  'load_progression',
  'adherence_risk',
] as const;

export type PredictionKind = (typeof PREDICTION_KINDS)[number];

export const PREDICTION_KIND_LABELS: Readonly<Record<PredictionKind, string>> = Object.freeze({
  goal_trajectory: 'Goal trajectory',
  bodyweight_projection: 'Bodyweight projection',
  load_progression: 'Load progression',
  adherence_risk: 'Adherence risk',
});

/**
 * How a prediction was arrived at. Mirrors the `prediction_method` pgEnum.
 *
 * Only `linear_trend` is implemented — see {@link METHOD}. The other three are
 * in the enum because the *record* has to be able to say which method produced
 * a row, and a calibration report that cannot separate a loess fit from an OLS
 * fit could not tell you which one to stop using.
 */
export const PREDICTION_METHODS = [
  'linear_trend',
  'loess_trend',
  'seasonal_decomposition',
  'adherence_state_model',
] as const;

export type PredictionMethod = (typeof PREDICTION_METHODS)[number];

export const PREDICTION_METHOD_LABELS: Readonly<Record<PredictionMethod, string>> = Object.freeze({
  linear_trend: 'Linear trend',
  loess_trend: 'Loess trend',
  seasonal_decomposition: 'Seasonal decomposition',
  adherence_state_model: 'Adherence state model',
});

/**
 * The only method this module implements.
 *
 * Named rather than inlined so the one place that would have to change when a
 * loess fit arrives is obvious.
 */
const METHOD: PredictionMethod = 'linear_trend';

/* =========================================================================
 * The gates
 * ====================================================================== */

/**
 * Fewer paired days than this and the answer is "not yet".
 *
 * Fourteen rather than `MIN_TREND_POINTS` (four). Four points are enough to
 * *draw* a line — `trend.ts` says so and it is right, because a drawn line
 * carries a visible band and sits on top of the points it was fitted to. A
 * prediction is a bare number about a day that has not happened, read without
 * the scatter underneath it, and the bar for that is higher. Two weeks is also
 * the shortest window over which a weekly rhythm (a training split, a weekend)
 * contributes more than once.
 */
export const MIN_PREDICTION_OBSERVATIONS = 14;

/**
 * How far ahead a prediction may be asked for.
 *
 * **Matched to Goals' `MAX_PROJECTION_DAYS`, which is 14.** The match is
 * deliberate and it is also forced, in that order:
 *
 * - Deliberate, because §8.9(4)'s dashed projection and this engine's point
 *   estimate are the same extrapolation of the same fit. Two different caps
 *   would mean a chart that stops on the 14th and a sentence underneath it
 *   about the 28th, drawn from a line the chart declined to draw that far.
 * - Forced, because `projectForward` is where the prediction interval lives and
 *   it clamps at `MAX_PROJECTION_DAYS`. Reaching past that would mean writing a
 *   second interval, and §10.9's whole argument for classical methods is that
 *   there is one of each and a person can check it by hand.
 *
 * A horizon beyond this is an `err` rather than an `insufficient`, and the
 * distinction is not pedantry: `insufficient` means "ask me again when there is
 * more data", which is false here. More data would not make a quarter-ahead
 * extrapolation of a straight line informative. It is a question this engine
 * does not answer, so it says so.
 */
export const MAX_HORIZON_DAYS = MAX_PROJECTION_DAYS;

/**
 * The closed list of subjects, per kind. Nothing off it is predictable.
 *
 * An allowlist, not a denylist, because §10.10's rule for the AI boundary
 * applies with equal force here: "the representation makes the harmful output
 * unrepresentable, which is stronger than any instruction." A denylist of
 * clinical keys would need updating every time the analyte catalogue grows,
 * and the failure mode of forgetting is a prediction about a lab value.
 *
 * Three deliberate omissions:
 *
 * - **Every `health.lab.*` key.** A projected ferritin is a clinical outcome.
 * - **`body.symptom.intensity`.** A projected symptom score is a symptom
 *   course, which §10.9 prohibits by name.
 * - **`mind.mood`, `mind.energy`, `mind.anxiety`.** Harder, and worth stating.
 *   They are not clinical *records*, but a line extrapolated through a mood
 *   score is a symptom course in everything but the name of the column, and it
 *   would be read as one. `mind.practice.duration` stays, because minutes
 *   practised is a behaviour.
 *
 * `medication.adherence` is also absent, and that one is a judgement rather
 * than a reading of the text: §10.9 permits "adherence-risk flagging" and doses
 * taken is a behaviour, not a response. But §10.5 is categorical that "no
 * recommendation touches medication", a predicted adherence figure is read as a
 * statement about treatment, and the cost of drawing this line too narrow is a
 * missing feature while the cost of drawing it too wide is a prediction about
 * medication. `routine.adherence` covers the honest half of the case.
 */
export const PERMITTED_METRICS: Readonly<Record<PredictionKind, readonly string[]>> = Object.freeze({
  /*
   * A goal may be set on any of these, so the trajectory list is the union of
   * the behavioural metrics. It is still a list: a goal set on a clinical
   * metric has no trajectory prediction, which is the correct answer.
   */
  goal_trajectory: Object.freeze([
    'body.weight',
    'body.sleep.duration',
    'gym.set.load',
    'gym.session.volume',
    'gym.session.duration',
    'mind.practice.duration',
    'nutrition.energy',
    'nutrition.protein',
    'routine.adherence',
  ]),
  bodyweight_projection: Object.freeze(['body.weight']),
  load_progression: Object.freeze(['gym.set.load', 'gym.session.volume']),
  adherence_risk: Object.freeze(['routine.adherence']),
});

/**
 * Whether this kind may be pointed at this metric.
 *
 * Scoped by kind rather than global, so `adherence_risk` on `body.weight` is
 * refused too. A kind is a claim about what the number *means*, and a bodyweight
 * "adherence risk" is not a thing that has an interpretation.
 */
export function isPermittedSubject(kind: PredictionKind, metricKey: string): boolean {
  return PERMITTED_METRICS[kind].includes(metricKey.trim());
}

/* =========================================================================
 * Shapes
 * ====================================================================== */

/**
 * A prediction as written.
 *
 * Row bookkeeping (`createdAt`, `version`, `deletedAt`) is deliberately absent,
 * as it is on every other domain type here — it belongs to the table, not to
 * the fact.
 */
export type PredictionInput = {
  /**
   * Client-minted UUIDv7 (§5.7).
   *
   * On the request rather than generated here, because a replayed nightly run
   * has to write the same row twice and land on one — which is the property
   * `record` in the repository depends on.
   */
  readonly id: string;
  readonly kind: PredictionKind;
  readonly metricKey: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly madeAt: string;
  readonly horizonDayKey: string;
  /** Decimal strings. These go to Postgres `numeric`, not to a chart (§5.3). */
  readonly predictedValue: string;
  readonly intervalLow: string;
  readonly intervalHigh: string;
  readonly unit: string;
  readonly method: PredictionMethod;
  readonly observationCount: number;
  /** From `rSquared`. A statement about the fit, never a probability of being right. */
  readonly fitConfidence: string | null;
  readonly assumptions: string;
};

/**
 * A prediction as read, resolution included.
 *
 * The resolution fields are the reason the table exists (§10.9), so they are
 * part of the type every reader gets rather than a separate "scored prediction"
 * shape that a caller could forget to look for.
 */
export type Prediction = PredictionInput & {
  readonly resolvedAt: string | null;
  readonly resolvedValue: string | null;
  readonly wasWithinInterval: boolean | null;
  readonly unresolvableReason: string | null;
};

export type PredictionRequest = {
  readonly id: string;
  readonly kind: PredictionKind;
  readonly metricKey: string;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly horizonDayKey: string;
  readonly madeAt: string;
  readonly unit: string;
};

/**
 * What {@link makePrediction} produces.
 *
 * `insufficient` is a *status*, not an error, and that is the shape §10.9 asks
 * for: "must degrade to 'insufficient data' rather than guessing". The caller
 * renders it as the answer — "9 of the 14 days a projection needs" is
 * information the operator can act on, and routing it through the error channel
 * would make it a failure to be logged and swallowed instead.
 */
export type PredictionOutcome =
  | { readonly status: 'predicted'; readonly prediction: PredictionInput }
  | { readonly status: 'insufficient'; readonly reason: string; readonly observations: number };

/* =========================================================================
 * Making one
 * ====================================================================== */

/**
 * Fit, project, and state the assumptions — or decline.
 *
 * The pipeline is `collapseByDay` → `linearTrend` → `projectForward`, all of it
 * already built for §8.9(4)'s chart. This function contributes the refusals and
 * the sentence, which is the part §10.9 is actually about.
 *
 * `projectForward` rather than `trendBand`, and the difference matters: a band
 * is the interval for the *fitted mean* at a day that was observed, while a
 * prediction is about a single future observation and carries the extra term
 * for that observation's own spread. Using the narrower of the two would make
 * every interval here optimistic, and the calibration record would then read as
 * an engine that misses a lot rather than as an engine whose intervals are too
 * tight.
 */
export function makePrediction(
  request: PredictionRequest,
  series: readonly DailyValue[],
  todayDayKey: string,
): Result<PredictionOutcome, DomainError> {
  /*
   * The subject gate runs first, before any arithmetic. §10.9's prohibition is
   * about what a metric *means*, and checking it after the fit would mean the
   * engine had already computed a symptom projection and merely declined to
   * return it.
   */
  if (!isPermittedSubject(request.kind, request.metricKey)) {
    return err(
      preconditionFailedError(
        'prediction_subject_permitted',
        `${request.kind} is not permitted for this metric. Blueprint §10.9 prohibits predicting a clinical outcome, a symptom course or a medication response, and this engine works from a closed allowlist rather than a denylist.`,
        'prediction_subject_prohibited',
      ),
    );
  }

  const todayIndex = dayKeyIndex(todayDayKey);
  const horizonIndex = dayKeyIndex(request.horizonDayKey);
  if (todayIndex === null || horizonIndex === null) {
    return err(validationError('prediction_day_key_invalid', 'A prediction needs a valid YYYY-MM-DD horizon and today.'));
  }

  const daysAhead = horizonIndex - todayIndex;
  if (daysAhead <= 0) {
    /* A horizon on or before today is not a prediction. Scoring one against a
     * reading that already exists would put a guaranteed hit into the
     * calibration record, which is the one number this engine cannot inflate. */
    return err(
      validationError('prediction_horizon_not_future', 'A prediction has to be about a day that has not happened yet.'),
    );
  }
  if (daysAhead > MAX_HORIZON_DAYS) {
    return err(
      validationError(
        'prediction_horizon_too_far',
        `A horizon of ${String(daysAhead)} days is past the ${String(MAX_HORIZON_DAYS)}-day cap. Extrapolating a fitted line further is arithmetic, not information.`,
      ),
    );
  }

  const daily = collapseByDay(series);
  const observations = daily.length;
  if (observations < MIN_PREDICTION_OBSERVATIONS) {
    return ok({
      status: 'insufficient',
      reason: `${String(observations)} of the ${String(MIN_PREDICTION_OBSERVATIONS)} days a projection needs.`,
      observations,
    });
  }

  const fit = linearTrend(daily);
  if (fit === null) {
    /* Reachable when every reading landed on one day — `collapseByDay` has
     * already merged those, so in practice this is the malformed-key path. */
    return ok({ status: 'insufficient', reason: 'No line could be fitted to these readings.', observations });
  }

  const last = daily.at(-1);
  const lastIndex = last === undefined ? null : dayKeyIndex(last.dayKey);
  if (last === undefined || lastIndex === null) {
    return ok({ status: 'insufficient', reason: 'No line could be fitted to these readings.', observations });
  }

  /*
   * The projection runs from the last *observation*, not from today. A series
   * that stopped a week ago has to reach further to arrive at the same horizon,
   * and past the cap the honest answer is that the record is stale rather than
   * that the horizon is too far — hence `insufficient` here and `err` above.
   */
  const aheadOfLast = horizonIndex - lastIndex;
  if (aheadOfLast > MAX_PROJECTION_DAYS) {
    return ok({
      status: 'insufficient',
      reason: `The most recent reading is from ${last.dayKey}, which is more than ${String(MAX_PROJECTION_DAYS)} days short of the horizon.`,
      observations,
    });
  }

  const projected = projectForward(daily, fit, aheadOfLast).find((point) => point.dayKey === request.horizonDayKey);
  if (projected === undefined) {
    return ok({ status: 'insufficient', reason: 'The fitted line does not reach the horizon.', observations });
  }

  const predictedValue = toQuantity(projected.value);
  const intervalLow = toQuantity(projected.lower);
  const intervalHigh = toQuantity(projected.upper);
  if (predictedValue === null || intervalLow === null || intervalHigh === null) {
    /* A slope steep enough to overflow `numeric(20,6)` is a data problem, not a
     * forecast. Declining is the same refusal as declining a short series. */
    return ok({
      status: 'insufficient',
      reason: 'The fitted line runs off the scale a stored quantity can hold.',
      observations,
    });
  }

  return ok({
    status: 'predicted',
    prediction: {
      id: request.id,
      kind: request.kind,
      metricKey: request.metricKey.trim(),
      subjectType: request.subjectType ?? null,
      subjectId: request.subjectId ?? null,
      madeAt: request.madeAt,
      horizonDayKey: request.horizonDayKey,
      predictedValue,
      intervalLow,
      intervalHigh,
      unit: request.unit,
      method: METHOD,
      observationCount: observations,
      fitConfidence: clampUnit(fit.rSquared).toFixed(4),
      assumptions: assumptionsFor(request.kind, observations, fit.spanDays),
    },
  });
}

/**
 * What had to hold, in plain words. Never empty.
 *
 * Built from a template rather than accepted from the caller, because
 * `assumptions` is `notNull` in the schema for a reason §10.9 states directly —
 * a prediction has to "state their interval and their assumptions" — and a
 * field a caller can leave blank is a field that ends up blank.
 *
 * Two clauses, always: what the operator would have to keep doing, and the fact
 * that the shape assumed is a straight line. {@link TREND_CAVEAT} is appended
 * rather than paraphrased so the sentence under the chart and the sentence on
 * the stored row cannot drift apart.
 */
function assumptionsFor(kind: PredictionKind, observations: number, spanDays: number): string {
  const window = `the last ${String(spanDays)} days`;
  const behaviour = BEHAVIOURAL_ASSUMPTION[kind];
  return `Assuming ${behaviour} as over ${window}, fitted to ${String(observations)} days of readings in that window. ${TREND_CAVEAT}`;
}

const BEHAVIOURAL_ASSUMPTION: Readonly<Record<PredictionKind, string>> = Object.freeze({
  goal_trajectory: 'the behaviour behind this metric continues',
  bodyweight_projection: 'intake and training continue',
  load_progression: 'training frequency and recovery continue',
  adherence_risk: 'the routine and the demands on it continue',
});

/* =========================================================================
 * Reading one back
 * ====================================================================== */

/**
 * A prediction in one sentence, interval included.
 *
 * The interval is not optional in the sentence any more than it is in the
 * schema. A point estimate on its own reads as certainty, which is the exact
 * over-trust §10.9 and P5 are guarding against, so the range is in the same
 * clause as the number rather than in a tooltip.
 */
export function describePrediction(p: Prediction): string {
  const point = `${trimZeros(p.predictedValue)}${p.unit === '' ? '' : ` ${p.unit}`}`;
  const range = `between ${trimZeros(p.intervalLow)} and ${trimZeros(p.intervalHigh)}`;
  const basis = `${PREDICTION_METHOD_LABELS[p.method].toLowerCase()} over ${String(p.observationCount)} days`;
  const head = `${p.metricKey} on ${p.horizonDayKey}: ${point}, ${range}, from a ${basis}.`;

  if (p.resolvedAt === null) return head;
  if (p.wasWithinInterval === null || p.resolvedValue === null) {
    /* An unresolvable prediction says why, and says it here rather than
     * disappearing from the surface — §10.9's track record includes the
     * questions that never got answered. */
    return `${head} Not scored: ${p.unresolvableReason ?? 'no reason recorded'}.`;
  }
  const verdict = p.wasWithinInterval ? 'inside the interval' : 'outside the interval';
  return `${head} Came in at ${trimZeros(p.resolvedValue)}, ${verdict}.`;
}

/* =========================================================================
 * Small shared helpers
 * ====================================================================== */

/**
 * The largest magnitude `numeric(20, 6)` can hold.
 *
 * Derived from the column's own precision and scale rather than typed out, so a
 * change to `quantity()` cannot leave a stale bound behind here.
 */
const MAX_QUANTITY_MAGNITUDE = 10 ** (QUANTITY_PRECISION - QUANTITY_SCALE);

/**
 * A float from the regression to the decimal string the column stores.
 *
 * `toFixed(QUANTITY_SCALE)` mirrors `goal/snapshot.ts`, which crosses the same
 * boundary in the same direction for the same reason: `statistics/` works in
 * `number` because it is drawing, and anything that lands in Postgres `numeric`
 * leaves as a string (§5.3).
 *
 * @returns `null` when the value is not finite or will not fit the column.
 */
function toQuantity(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) >= MAX_QUANTITY_MAGNITUDE) return null;
  return value.toFixed(QUANTITY_SCALE);
}

/** `rSquared` can drift a hair outside [0, 1] on a degenerate fit. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** `78.400000` reads as false precision in a sentence. The stored value keeps it. */
function trimZeros(decimal: string): string {
  if (!decimal.includes('.')) return decimal;
  const trimmed = decimal.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

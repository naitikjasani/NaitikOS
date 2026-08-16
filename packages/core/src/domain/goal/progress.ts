/**
 * Goal progress — derived on every read, stored never.
 *
 * §4.10 gives the rule and the reason in one sentence: "Recording progress
 * separately from the underlying observations would create two sources of truth
 * and guarantee drift." So this module is pure. It takes a target and a daily
 * series and returns a number; nothing here writes anything.
 *
 * (`goal_progress_snapshot` is not a contradiction — see `snapshot.ts`. It
 * records what the trajectory *looked like on a date*, so a correction in March
 * does not rewrite what January believed. It is history, not state.)
 *
 * ## Insufficient is a first-class answer
 *
 * §10.9: predictions "must degrade to *'insufficient data'* rather than
 * guessing". Below {@link MIN_TREND_POINTS} there is no line, and this returns
 * `insufficient` rather than a slope through three points. The screen renders
 * that plainly, which is the only honest thing to draw in week one of a goal.
 *
 * ## Nothing here reports a p-value or a confidence
 *
 * The band comes from `trendBand`/`projectForward`, whose own header is explicit
 * that daily readings are autocorrelated and the interval is therefore narrower
 * than the truth. {@link TREND_CAVEAT} travels to the screen with the chart.
 * `projectionConfidence` on the snapshot row is filled from `rSquared`, and
 * `rSquared` is labelled as *fit*, never as *likelihood* — §10.6 exists because
 * that distinction is the one people stop making first.
 */

import type { DailyValue } from '../../statistics/types';
import type { LinearFit, ProjectedPoint } from '../../statistics/trend';
import { MAX_PROJECTION_DAYS, MIN_TREND_POINTS, linearTrend, projectForward, trendBand } from '../../statistics/trend';
import type { DailyBand } from '../../statistics/types';
import { dayKeyIndex, shiftDayKey } from '../../temporal/instant';
import type { GoalTarget } from './target';

/** Days in a week. Named because a rate is quoted per week, never per day. */
const DAYS_PER_WEEK = 7;

export type ProgressStatus =
  /** On or past the target. */
  | 'met'
  /** Moving the right way and projected to arrive before the horizon. */
  | 'on_track'
  /** Moving the right way, but not fast enough to arrive by the horizon. */
  | 'behind'
  /** Moving the wrong way. */
  | 'away'
  /** Not enough data to say anything, which is a real answer (§10.9). */
  | 'insufficient';

export type GoalProgress = {
  readonly targetId: string;
  readonly metricKey: string;
  readonly status: ProgressStatus;
  /**
   * The metric's current level, or — for a rate target — the fitted slope in
   * units **per week**.
   */
  readonly current: number | null;
  readonly target: number;
  /**
   * 0–1 against the target, or `null` when it has no meaning.
   *
   * Deliberately not clamped above 1: a bulk that has gained more than it aimed
   * to has a ratio of 1.3, and flattening that to 1.0 hides the overshoot that
   * §4.10's conflict detection is looking for.
   */
  readonly ratio: number | null;
  readonly fit: LinearFit | null;
  readonly band: readonly DailyBand[];
  readonly projection: readonly ProjectedPoint[];
  /** When the line reaches the target, or `null`. See {@link projectedArrival}. */
  readonly projectedAt: string | null;
  /** How many days contributed. Travels with every figure, per §10.6. */
  readonly n: number;
};

export type ProgressInput = {
  readonly target: GoalTarget;
  /** Already rolled up per day, in the operator's zone. `dailyRollup` output. */
  readonly series: readonly DailyValue[];
  /** Used to decide `on_track` versus `behind`. */
  readonly horizonDayKey: string | null;
  readonly todayDayKey: string;
};

/**
 * Derive a target's progress from the series behind it.
 *
 * The pipeline is `dailyRollup` → `linearTrend` → `projectForward`, all of it
 * already built and tested. This function's whole job is deciding what the
 * numbers *mean* for a target, which is the part that is specific to goals.
 */
export function deriveProgress(input: ProgressInput): GoalProgress {
  const { target, series, todayDayKey } = input;
  const targetValue = Number(target.targetValue);

  const empty = {
    targetId: target.id,
    metricKey: target.metricKey,
    target: targetValue,
    band: [] as readonly DailyBand[],
    projection: [] as readonly ProjectedPoint[],
    projectedAt: null,
    n: series.length,
  } as const;

  if (!Number.isFinite(targetValue)) {
    return { ...empty, status: 'insufficient', current: null, ratio: null, fit: null };
  }

  const fit = linearTrend(series);

  /*
   * A rate target has *no* meaningful reading without a fit — the question is
   * literally about the slope. A level target does: the latest value answers
   * "am I there yet" even with one reading, and only the projection needs a
   * line. So the two branch here rather than sharing an early return.
   */
  if (target.comparator === 'rate_of_change') {
    if (fit === null || series.length < MIN_TREND_POINTS) {
      return { ...empty, status: 'insufficient', current: null, ratio: null, fit: null, n: series.length };
    }
    const perWeek = fit.slope * DAYS_PER_WEEK;
    const ratio = targetValue === 0 ? null : perWeek / targetValue;
    return {
      ...empty,
      status: rateStatus(perWeek, targetValue),
      current: perWeek,
      ratio,
      fit,
      band: trendBand(series, fit),
      projection: projectForward(series, fit, MAX_PROJECTION_DAYS),
      n: fit.n,
    };
  }

  const latest = series.at(-1);
  if (latest === undefined) {
    return { ...empty, status: 'insufficient', current: null, ratio: null, fit: null };
  }

  const current = latest.value;
  const met = target.comparator === 'at_least' ? current >= targetValue : current <= targetValue;

  const band = fit === null ? [] : trendBand(series, fit);
  const projection = fit === null ? [] : projectForward(series, fit, MAX_PROJECTION_DAYS);
  const projectedAt = fit === null ? null : projectedArrival(fit, current, targetValue, target.comparator, todayDayKey);

  return {
    ...empty,
    status: met
      ? 'met'
      : fit === null
        ? 'insufficient'
        : levelStatus(fit.slope, current, targetValue, target.comparator, projectedAt, input.horizonDayKey),
    current,
    ratio: targetValue === 0 ? null : current / targetValue,
    fit,
    band,
    projection,
    projectedAt,
    n: fit?.n ?? series.length,
  };
}

function rateStatus(perWeek: number, targetPerWeek: number): ProgressStatus {
  /* A rate target with a sign: gaining 0.25 kg/wk is met by 0.3, not by −0.3. */
  if (targetPerWeek >= 0) return perWeek >= targetPerWeek ? 'met' : perWeek > 0 ? 'behind' : 'away';
  return perWeek <= targetPerWeek ? 'met' : perWeek < 0 ? 'behind' : 'away';
}

function levelStatus(
  slope: number,
  current: number,
  targetValue: number,
  comparator: GoalTarget['comparator'],
  projectedAt: string | null,
  horizonDayKey: string | null,
): ProgressStatus {
  const needsToRise = comparator === 'at_least' && current < targetValue;
  const movingRightWay = needsToRise ? slope > 0 : slope < 0;
  if (!movingRightWay) return 'away';
  if (projectedAt === null) return 'behind';
  if (horizonDayKey === null) return 'on_track';
  return projectedAt <= horizonDayKey ? 'on_track' : 'behind';
}

/**
 * The day the fitted line crosses the target, or `null`.
 *
 * Extrapolated **without a cap**, unlike `projectForward`, and that difference
 * is deliberate. A drawn projection is capped at fourteen days because a longer
 * dashed line invites being read as a forecast; an arrival *date* is a single
 * number the operator asked for by setting a horizon, and clamping it to a
 * fortnight would silently answer a different question.
 *
 * It is still bounded — {@link MAX_ARRIVAL_DAYS} — because "you will get there
 * in 2043" is not information, it is arithmetic. Past that, `null`, and the
 * screen says the line does not reach the target on any horizon worth naming.
 */
export function projectedArrival(
  fit: LinearFit,
  current: number,
  targetValue: number,
  comparator: GoalTarget['comparator'],
  todayDayKey: string,
): string | null {
  if (comparator === 'rate_of_change') return null;
  if (fit.slope === 0) return null;

  const daysAway = (targetValue - current) / fit.slope;
  if (!Number.isFinite(daysAway) || daysAway <= 0) return null;

  const days = Math.ceil(daysAway);
  if (days > MAX_ARRIVAL_DAYS) return null;
  if (dayKeyIndex(todayDayKey) === null) return null;

  return shiftDayKey(todayDayKey, days);
}

/** Two years. Past this an arrival date is arithmetic, not information. */
export const MAX_ARRIVAL_DAYS = 730;

export const PROGRESS_STATUS_LABELS: Readonly<Record<ProgressStatus, string>> = Object.freeze({
  met: 'Met',
  on_track: 'On track',
  behind: 'Behind',
  away: 'Moving away',
  insufficient: 'Not enough data yet',
});

/**
 * Why a status says what it says, in one line.
 *
 * §4.13 requires an insight to carry "its evidence, its method, its confidence".
 * A goal is not an insight, but the same standard applies to a status badge
 * derived from a regression — a coloured word with no sentence under it is
 * exactly the unauditable claim P5 forbids.
 */
export function explainProgress(progress: GoalProgress, target: GoalTarget): string {
  if (progress.status === 'insufficient') {
    return progress.n < MIN_TREND_POINTS
      ? `${String(progress.n)} of the ${String(MIN_TREND_POINTS)} days a line needs. Nothing is being projected.`
      : 'Not enough movement in the readings to fit a line.';
  }

  const n = `${String(progress.n)} days`;
  if (target.comparator === 'rate_of_change') {
    const rate = progress.current === null ? '—' : progress.current.toFixed(2);
    return `Fitted slope is ${rate} ${target.unit}/week over ${n}.`;
  }

  const arrival = progress.projectedAt === null ? 'The line does not reach it.' : `Line reaches it around ${progress.projectedAt}.`;
  return `${arrival} Fitted over ${n}.`;
}

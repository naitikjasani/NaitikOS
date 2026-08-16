/**
 * Goal progress snapshots — the one thing Goals writes that looks like data.
 *
 * §9.2 explains why it is not a contradiction of §4.10's "goals own no progress
 * data":
 *
 *   "Snapshots exist so the *trajectory as it was believed at the time* is
 *    preserved even after the underlying data is corrected."
 *
 * Progress is still always derived on read. A snapshot is a **record of a
 * belief on a date**, and it becomes interesting precisely when the two
 * disagree: a bodyweight from March corrected in June changes today's line, and
 * without snapshots there would be no way to see that the January review was
 * looking at something different. That is P2 applied to a derived value.
 *
 * ## Written nightly, never on read
 *
 * By the `snapshot-goal-progress` job step. Writing one on every page view
 * would make the table a log of page views, and the trajectory-as-believed
 * question is a daily question.
 *
 * ## `projectionConfidence` is a fit, and it is labelled as one
 *
 * Filled from `rSquared` — how well the line describes the points supplied.
 * That is **not** a probability that the projection is right, and `trend.ts` is
 * explicit that these readings are autocorrelated so any interval derived from
 * them is narrower than the truth. The column is named `confidence` because the
 * schema had one; every surface that renders it says "fit", per P5.
 */

import type { GoalProgress } from './progress';
import type { GoalTarget } from './target';

export type ProgressSnapshot = {
  readonly id: string;
  readonly goalId: string;
  readonly goalTargetId: string | null;
  readonly takenAt: string;
  /** Decimal strings — this row goes to Postgres `numeric`, not to a chart. */
  readonly currentValue: string | null;
  readonly progressRatio: string | null;
  readonly projectedAt: string | null;
  readonly projectionConfidence: string | null;
};

/**
 * Turn a derived progress into the row to persist.
 *
 * Returns `null` for `insufficient` progress. A snapshot of "we could not say"
 * is a row that reads as a measurement of zero in six months, and the absence
 * of a row on a day is already the honest record of that day.
 */
export function planSnapshot(
  id: string,
  goalId: string,
  target: GoalTarget,
  progress: GoalProgress,
  takenAt: string,
): ProgressSnapshot | null {
  if (progress.status === 'insufficient') return null;

  return {
    id,
    goalId,
    goalTargetId: target.id,
    takenAt,
    currentValue: progress.current === null ? null : toDecimalString(progress.current),
    progressRatio: progress.ratio === null ? null : toDecimalString(progress.ratio),
    /*
     * A day key, widened to noon UTC. `projectedAt` is an `instant()` column
     * and the projection is a *day* — midnight would sit on a boundary a DST
     * rule can push into the previous day, which is the same reason every other
     * day-anchored instant in this codebase uses noon.
     */
    projectedAt: progress.projectedAt === null ? null : `${progress.projectedAt}T12:00:00.000Z`,
    projectionConfidence: progress.fit === null ? null : clampUnit(progress.fit.rSquared).toFixed(4),
  };
}

/**
 * How the believed trajectory has moved between two snapshots.
 *
 * The review ritual's actual content: not "where am I" — the screen already
 * shows that — but "has the picture changed since I last looked, and did it
 * change because I moved or because the data was corrected?" This function
 * cannot distinguish those two, and says so rather than guessing; the point is
 * to make the divergence visible so the operator can go and look.
 */
export function snapshotDrift(
  earlier: ProgressSnapshot,
  later: ProgressSnapshot,
): { readonly ratioDelta: number | null; readonly arrivalMoved: boolean } {
  const from = earlier.progressRatio === null ? null : Number(earlier.progressRatio);
  const to = later.progressRatio === null ? null : Number(later.progressRatio);

  return {
    ratioDelta: from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to) ? null : to - from,
    arrivalMoved: earlier.projectedAt !== later.projectedAt,
  };
}

/**
 * A JS number as a string Postgres `numeric(20,6)` will take.
 *
 * Six places, matching `QUANTITY_SCALE`. Non-finite becomes `null` upstream;
 * this only ever sees a real number, and it must not emit `1e-7` — exponential
 * notation is valid JSON and not valid input for the column.
 */
function toDecimalString(value: number): string {
  return value.toFixed(6);
}

/** `rSquared` is 0–1 by construction; floating point occasionally disagrees. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

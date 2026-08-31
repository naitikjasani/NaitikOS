/**
 * The Reviews service — §4.12, assembled.
 *
 * ## Nothing here calls a model
 *
 * §4.12 says "model-drafted from the record", and §10.0 settles what the first
 * half is allowed to mean: "the model never computes, discovers, or asserts."
 * So `buildReviewInputs` runs queries, `assembleDraft` arranges their answers,
 * and no third party is on the path of any figure a person will read.
 *
 * The consequence is the same one the Consultation Pack records: drafting works
 * with no model, no API key and no budget remaining. That is not a degraded
 * mode. A Sunday-evening review that produced a blank page because a token cap
 * was hit would fail on precisely the evening the habit is most fragile, and a
 * habit that fails once is a habit that stops.
 *
 * ## Every figure is sourced, and an unsourceable one is left empty
 *
 * The rule this file follows without exception: if a number cannot be read out
 * of the record, the honest empty value goes in and a comment says why. Never a
 * zero standing in for an unknown, never a plausible default. §8.9(3) — missing
 * data is shown as missing — is a rule about charts, and a review is the surface
 * where breaking it would be least visible and most permanent.
 *
 * ## Windows are zoned, at both ends
 *
 * A period is a pair of day keys, and every query below converts it through
 * `zonedDayBounds` before it touches the database. A week that ended at
 * midnight UTC would file Sunday evening — when a weekly review is actually
 * written — under the following week, in the operator's zone and in no other.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  DomainError,
  Exercise,
  ReviewDraft,
  ReviewInputs,
  ReviewKind,
  ReviewPeriod,
  ReviewState,
} from '@naitikos/core';
import {
  REVIEW_KINDS,
  assembleDraft,
  dayKeyInZone,
  dayKeyIndex,
  formatDecimal,
  isoFromMillis,
  isReviewComplete,
  notFoundError,
  periodContaining,
  recentPeriods,
  sessionVolume,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  closedDaysBetween,
  createExerciseRepository,
  createGoalRepository,
  createInsightRepository,
  createLearningRepository,
  createReviewRepository,
  createObservationRepository,
  createWorkRepository,
  createWorkoutRepository,
} from '@naitikos/db';

/**
 * The metric the mood section reads.
 *
 * One key, named here rather than inferred from a category, because a review is
 * a permanent document and "mood" quietly coming to mean a different metric in
 * 2029 would silently change what every archived review meant.
 */
const MOOD_METRIC_KEY = 'mind.mood';

/**
 * How many periods of each kind the board offers.
 *
 * Enough to cover a gap — a fortnight of missed weeklies, a skipped quarter —
 * and not so many that the page becomes a calendar. Reviews older than this are
 * still reachable through the list of existing reviews below them.
 */
const RECENT_PER_KIND: Readonly<Record<ReviewKind, number>> = Object.freeze({
  weekly: 8,
  monthly: 6,
  quarterly: 4,
  annual: 3,
});

/**
 * A review as the `review` table holds it.
 *
 * Defined here from the columns rather than imported, because this is the shape
 * the screens are typed against and it is deliberately narrower than the row:
 * `searchVector` and the entity columns are not the operator's business, and a
 * type that carried them would invite a screen to render one.
 */
export type ReviewRow = {
  readonly id: string;
  readonly kind: ReviewKind;
  /** ISO instant — the first moment of the period's first day, in its zone. */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Assembled from the record. Rebuildable, and therefore safe to overwrite. */
  readonly draftContent: string | null;
  /** The operator's own writing. Nothing can reconstruct this (§4.12). */
  readonly editedContent: string | null;
  readonly state: ReviewState;
  readonly completedAt: string | null;
};

export type ReviewsBoard = {
  readonly todayDayKey: string;
  readonly periods: readonly {
    readonly period: ReviewPeriod;
    readonly review: ReviewRow | null;
    /**
     * Whether the period has ended.
     *
     * The draft button is disabled when this is false, and the page says why.
     * A review of a period that has not ended is a review of a partial record
     * whose figures do not say so.
     */
    readonly closed: boolean;
  }[];
  readonly reviews: readonly ReviewRow[];
};

export type ReviewDetail = {
  readonly review: ReviewRow;
  /**
   * The period the row covers, recomputed from its stored start.
   *
   * `null` for a row whose start does not resolve to a real date — a corrupt
   * row is shown as corrupt rather than given a plausible window it never had.
   */
  readonly period: ReviewPeriod | null;
  /**
   * The draft as the record stands **now**.
   *
   * Not the stored text. This is what a re-draft would produce, and having both
   * is what lets the detail screen say "the record has changed since this was
   * drafted" instead of leaving the operator to notice. `null` when the period
   * could not be resolved, or when the inputs could not be read.
   */
  readonly draft: ReviewDraft | null;
  /** §4.12's judgement, from `core`. Never `state === 'complete'` on its own. */
  readonly complete: boolean;
};

/* =========================================================================
 * Reads
 * ====================================================================== */

export async function loadReviews(db: Database, zone: string): Promise<Result<ReviewsBoard, DomainError>> {
  const reviews = createReviewRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);

  const all = await reviews.all();
  if (!all.ok) return all;

  const rows = all.value.map(toReviewRow);

  /*
   * Matched on the period's *first day key*, not on the stored instant. Two
   * instants for the same Monday differ if the operator moved zones between
   * drafting and reading, and a review that vanished from its own row because
   * of a trip would be the worst possible bug in an archive.
   */
  const byPeriod = new Map<string, ReviewRow>();
  for (const row of rows) {
    byPeriod.set(`${row.kind}:${dayKeyInZone(row.periodStart, zone)}`, row);
  }

  const periods: ReviewsBoard['periods'] = REVIEW_KINDS.flatMap((kind) =>
    recentPeriods(kind, todayDayKey, RECENT_PER_KIND[kind]).map((period) => ({
      period,
      review: byPeriod.get(`${kind}:${period.fromDayKey}`) ?? null,
      closed: isClosed(period, todayDayKey),
    })),
  );

  return ok({
    todayDayKey,
    periods,
    /* Newest first. An archive is read from the near end. */
    reviews: [...rows].sort((a, b) => b.periodStart.localeCompare(a.periodStart)),
  });
}

export async function loadReview(
  db: Database,
  id: string,
  zone: string,
): Promise<Result<ReviewDetail | null, DomainError>> {
  const found = await createReviewRepository(db).byId(id);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);

  const review = toReviewRow(found.value);
  const period = periodContaining(review.kind, dayKeyInZone(review.periodStart, zone));

  let draft: ReviewDraft | null = null;
  if (period !== null) {
    const inputs = await buildReviewInputs(db, period, zone);
    if (!inputs.ok) return inputs;
    draft = assembleDraft(inputs.value);
  }

  return ok({
    review,
    period,
    draft,
    complete: isReviewComplete(review.state, review.editedContent),
  });
}

/* =========================================================================
 * The inputs the draft is assembled from
 * ====================================================================== */

/**
 * Read the period out of the record.
 *
 * Every field of {@link ReviewInputs} is produced by a query here. Nothing is
 * estimated, and nothing is carried over from an adjacent period. The one field
 * that is not yet sourced is named in a `TODO` rather than filled in — see the
 * sleep block.
 */
export async function buildReviewInputs(
  db: Database,
  period: ReviewPeriod,
  zone: string,
): Promise<Result<ReviewInputs, DomainError>> {
  const bounds = periodBounds(period, zone);
  if (bounds === null) {
    return err(
      notFoundError('review period', `${period.fromDayKey}..${period.toDayKey}`, 'review_period_unresolvable'),
    );
  }
  const { fromIso, untilIso, totalDays } = bounds;

  const workouts = createWorkoutRepository(db);
  const work = createWorkRepository(db);

  const [closed, sets, sessionDays, moods, tasks, career, learning, insights, goals] = await Promise.all([
    /* Not a Result — this one throws on a database fault like any other query
     * the caller is already wrapped against. */
    closedDaysBetween(db, fromIso, untilIso, zone),
    workouts.setsBetween(fromIso, untilIso),
    workouts.sessionDays(fromIso, untilIso),
    createObservationRepository(db).query({
      metricKeys: [MOOD_METRIC_KEY],
      from: fromIso,
      until: untilIso,
    }),
    work.tasksClosedBetween(period.fromDayKey, period.toDayKey),
    work.careerEntriesBetween(fromIso, untilIso),
    createLearningRepository(db).items(),
    /* The whole archive, then filtered on `actedOnAt`. The repository has no
     * window query and adding one is another agent's file. */
    createInsightRepository(db).all(1000),
    createGoalRepository(db).all(),
  ]);

  if (!sets.ok) return sets;
  if (!sessionDays.ok) return sessionDays;
  if (!moods.ok) return moods;
  if (!tasks.ok) return tasks;
  if (!career.ok) return career;
  if (!learning.ok) return learning;
  if (!insights.ok) return insights;
  if (!goals.ok) return goals;

  /* --- training ------------------------------------------------------- */

  const exercises = await createExerciseRepository(db).byIds(sets.value.map((set) => set.exerciseId));
  if (!exercises.ok) return exercises;
  const lookup = (exerciseId: string): Exercise | null => exercises.value.get(exerciseId) ?? null;

  /*
   * `null` bodyweight, so bodyweight movements are *excluded* from the total
   * rather than counted at some assumed mass. `sessionVolume` reports them as
   * `excluded.bodyweight_unknown`, and a review that quietly invented 75 kg for
   * every pull-up would put a fabricated figure into a permanent document.
   */
  const volume = sessionVolume(sets.value, lookup, null);
  const totalVolume =
    volume.countedSets === 0 ? null : `${formatDecimal(volume.total, { trim: true })} kg`;

  /* --- mood ------------------------------------------------------------ */

  const moodValues = moods.value
    .filter((observation) => observation.valueText === null)
    .map((observation) => Number(observation.value))
    .filter((value) => Number.isFinite(value));

  const mood =
    moodValues.length === 0
      ? { mean: null, low: null, high: null, observations: 0 }
      : {
          mean: moodValues.reduce((sum, value) => sum + value, 0) / moodValues.length,
          low: Math.min(...moodValues),
          high: Math.max(...moodValues),
          observations: moodValues.length,
        };

  /* --- everything else ------------------------------------------------- */

  const inPeriod = (instant: string | null): boolean => {
    if (instant === null) return false;
    return instant >= fromIso && instant < untilIso;
  };

  return ok({
    period,
    closedDays: closed.length,
    totalDays,
    /*
     * TODO(sleep): read from `createSleepRepository` in `@naitikos/db` once it
     * lands — it is being written concurrently with this file. Until then the
     * honest empty value: zero nights *recorded*, and two nulls. `assembleDraft`
     * omits the whole Sleep section rather than printing zeroes, which is the
     * correct rendering of "this system has no sleep data" and is not the same
     * claim as "you did not sleep".
     */
    sleep: { nights: 0, meanDurationHours: null, meanQuality: null },
    training: { sessions: sessionDays.value.length, totalVolume },
    mood,
    tasksClosed: tasks.value.length,
    careerEntries: career.value.map((entry) => ({
      kind: entry.kind,
      title: entry.title,
      occurredAt: entry.occurredAt,
    })),
    /*
     * Finished *inside the period*. An item with no `finishedAt` is excluded
     * even when its status says finished — the review is about a window, and a
     * book whose completion date was never recorded cannot be placed in one.
     */
    learningFinished: learning.value
      .filter((item) => item.status === 'finished' && inPeriod(item.finishedAt))
      .map((item) => item.title),
    insightsActedOn: insights.value.filter((row) => inPeriod(row.actedOnAt)).length,
    goalsAchieved: goals.value
      .filter((goal) => goal.status === 'achieved' && inPeriod(goal.achievedAt))
      .map((goal) => goal.title),
  });
}

/* =========================================================================
 * Helpers
 * ====================================================================== */

/**
 * The period as a half-open instant range, plus its length in days.
 *
 * Half-open at the far end — `[start of the first day, start of the day after
 * the last)` — because that is how §9.6's indexes are used, and because an
 * inclusive `23:59:59.999` is wrong by a millisecond every day and by an hour
 * on the two days a DST rule moves.
 */
function periodBounds(
  period: ReviewPeriod,
  zone: string,
): { readonly fromIso: string; readonly untilIso: string; readonly totalDays: number } | null {
  const start = zonedDayBounds(period.fromDayKey, zone);
  const end = zonedDayBounds(period.toDayKey, zone);
  const first = dayKeyIndex(period.fromDayKey);
  const last = dayKeyIndex(period.toDayKey);
  if (start === null || end === null || first === null || last === null) return null;

  return { fromIso: start.start, untilIso: end.end, totalDays: last - first + 1 };
}

/**
 * Whether the period has ended, as of today.
 *
 * `isPeriodClosed` lives in `core` and is the authority; this is the same
 * question asked without importing a second name into the screens. Strictly
 * after the last day: the last day of a period is still being lived.
 */
function isClosed(period: ReviewPeriod, todayDayKey: string): boolean {
  const today = dayKeyIndex(todayDayKey);
  const end = dayKeyIndex(period.toDayKey);
  if (today === null || end === null) return false;
  return today > end;
}

/** Narrow a repository row to the shape the screens are typed against. */
function toReviewRow(row: {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly draftContent: string | null;
  readonly editedContent: string | null;
  readonly state: ReviewState;
  readonly completedAt: string | null;
}): ReviewRow {
  return {
    id: row.id,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    draftContent: row.draftContent,
    editedContent: row.editedContent,
    state: row.state,
    completedAt: row.completedAt,
  };
}

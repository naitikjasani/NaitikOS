/**
 * Per-exercise progression, and the prefill that makes the logger usable.
 *
 * ## The prefill is the feature
 *
 * §4.1's design note is the strongest statement about Gym in the blueprint:
 *
 *   "The logger must default to *last session's numbers* for the same exercise,
 *    so the primary interaction is confirming or nudging rather than typing.
 *    Typing a weight from scratch every set is a P1 violation."
 *
 * A novice's session is four exercises × four sets, and almost every one of
 * those sixteen sets is either identical to last week's or one increment above
 * it. Sixteen numeric keyboard interactions, between sets, out of breath, is the
 * difference between a system that gets used in the gym and one that gets filled
 * in from memory that evening — which is a different, worse dataset.
 *
 * So {@link prefillFor} is not a convenience feature. It is the interaction
 * model, and everything else on the logger screen is arranged around it.
 *
 * ## Progression, and what it deliberately does not do
 *
 * {@link progressionBySession} produces one point per session per exercise, and
 * nothing here interprets it. §4.1 lists "deload suggestion based on volume
 * trend" as a feature; §2.1 keeps every non-adherence insight out of the MVP and
 * §10.6 explains at length why a detector that fires on noise is worse than no
 * detector. The chart shows what happened. The reading is the operator's.
 */

import type { Decimal } from '../../units/decimal';
import { addDecimal, compareDecimal, formatDecimal } from '../../units/decimal';
import { dayKeyInZone } from '../../timeline/grouping';
import type { DailyValue } from '../../statistics/types';
import type { Exercise, WorkoutSetKind } from './exercise';
import { countsTowardsVolume } from './exercise';
import { estimateOneRepMax, relativeStrength } from './records';
import type { SetSide } from './session';
import { setVolume } from './volume';

/**
 * A set as history sees it: the row, plus the session context needed to make
 * sense of it.
 *
 * `bodyweightKg` travels per set rather than being looked up, because a
 * bodyweight movement's true load is the bodyweight *at that session* — using
 * today's for a set performed eight kilograms ago is the exact mistake
 * `volume.ts` refuses to make.
 */
export type HistoricalSet = {
  readonly sessionId: string;
  readonly setId: string;
  readonly exerciseId: string;
  readonly performedAt: string;
  readonly zone: string;
  readonly orderIndex: number;
  readonly kind: WorkoutSetKind;
  readonly load: string | null;
  readonly loadUnit: string;
  readonly reps: number | null;
  readonly rpe: string | null;
  readonly side: SetSide | null;
  readonly bodyweightKg: string | null;
};

/* -------------------------------------------------------------------------
 * Prefill
 * ---------------------------------------------------------------------- */

/**
 * What the logger puts in the fields before the operator touches them.
 *
 * Every field is nullable, and `source` says where the numbers came from, so
 * the UI can label a prefilled row "last time" rather than presenting invented
 * values as though they were entered. A prefill that cannot be distinguished
 * from a record is a data-integrity problem wearing a convenience hat.
 */
export type SetPrefill = {
  readonly load: string | null;
  readonly loadUnit: string;
  readonly reps: number | null;
  readonly rpe: string | null;
  readonly source: 'last_session' | 'last_set' | 'none';
  /** The session the numbers came from, for "last time: 60 kg × 8, 12 Aug". */
  readonly fromSessionId: string | null;
  readonly fromDayKey: string | null;
};

export const EMPTY_PREFILL: SetPrefill = Object.freeze({
  load: null,
  loadUnit: 'kg',
  reps: null,
  rpe: null,
  source: 'none',
  fromSessionId: null,
  fromDayKey: null,
});

/** The sets of the most recent session that included this exercise. */
export function lastSessionFor(
  history: readonly HistoricalSet[],
  exerciseId: string,
  excludeSessionId?: string,
): readonly HistoricalSet[] {
  const relevant = history.filter(
    (set) => set.exerciseId === exerciseId && set.sessionId !== excludeSessionId,
  );
  if (relevant.length === 0) return [];

  // Most recent first, then take everything from that session.
  const latest = relevant.reduce((newest, set) => (set.performedAt > newest.performedAt ? set : newest));
  return relevant
    .filter((set) => set.sessionId === latest.sessionId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * The prefill for the *n*th set of this exercise in the current session.
 *
 * Matches by position within the previous session, which is what a lifter
 * actually means by "same as last time": their third set of squats matches
 * their third set of squats, not their first. When the current session runs
 * longer than the previous one, the last set repeats — because a fifth set
 * after four is nearly always a repeat of the fourth.
 *
 * Warm-ups are matched separately from working sets, so a working set never
 * prefills from a warm-up's weight. That single rule prevents the most annoying
 * possible failure: tapping "add set" mid-session and being offered the empty
 * bar.
 */
export function prefillFor(
  history: readonly HistoricalSet[],
  exerciseId: string,
  setIndex: number,
  kind: WorkoutSetKind = 'working',
  options: { readonly excludeSessionId?: string } = {},
): SetPrefill {
  const previous = lastSessionFor(history, exerciseId, options.excludeSessionId);
  if (previous.length === 0) return EMPTY_PREFILL;

  const sameKind = previous.filter((set) =>
    kind === 'warmup' ? set.kind === 'warmup' : countsTowardsVolume(set.kind),
  );
  const pool = sameKind.length > 0 ? sameKind : previous;

  const exact = pool[setIndex];
  const chosen = exact ?? pool.at(-1);
  if (chosen === undefined) return EMPTY_PREFILL;

  return {
    load: chosen.load,
    loadUnit: chosen.loadUnit,
    reps: chosen.reps,
    // RPE is deliberately not prefilled: it is a judgement about *this* set,
    // and copying last week's would turn the only subjective field in the
    // logger into a number nobody actually assessed.
    rpe: null,
    source: exact === undefined ? 'last_set' : 'last_session',
    fromSessionId: chosen.sessionId,
    fromDayKey: dayKeyInZone(chosen.performedAt, chosen.zone),
  };
}

/* -------------------------------------------------------------------------
 * Progression
 * ---------------------------------------------------------------------- */

/** One session's worth of an exercise. */
export type ProgressionPoint = {
  readonly sessionId: string;
  readonly dayKey: string;
  /** Heaviest effective load moved in the session, in kg. */
  readonly topLoad: Decimal | null;
  /** Reps at the top load. Together these are "60 kg × 8". */
  readonly topLoadReps: number | null;
  /**
   * The top load as a multiple of that session's bodyweight.
   *
   * §4.1 lists bodyweight as a *read* dependency of Gym for exactly this: "reads
   * bodyweight for relative-strength calculation". A 100 kg squat means
   * something different at 65 kg than at 95 kg, and during a bulk the absolute
   * number rises for reasons that are not strength — so the two lines diverging
   * is the interesting signal.
   *
   * `null` when the session recorded no bodyweight, which is the honest answer
   * rather than a ratio against a stale weigh-in.
   */
  readonly relativeTopLoad: Decimal | null;
  readonly bestEstimatedMax: Decimal | null;
  readonly volume: Decimal | null;
  readonly workingSets: number;
  readonly totalReps: number;
};

/**
 * Fold an exercise's history into one point per session.
 *
 * Sorted oldest first, which is chart order. A session that produced nothing
 * countable — all warm-ups, or bodyweight sets with no bodyweight — still
 * appears, with nulls: it *happened*, and dropping it would make the frequency
 * chart claim the operator skipped a week they did not skip.
 */
export function progressionBySession(
  history: readonly HistoricalSet[],
  exercise: Pick<Exercise, 'isBodyweight'>,
): readonly ProgressionPoint[] {
  const bySession = new Map<string, HistoricalSet[]>();
  for (const set of history) {
    const existing = bySession.get(set.sessionId);
    if (existing === undefined) bySession.set(set.sessionId, [set]);
    else existing.push(set);
  }

  const points: ProgressionPoint[] = [];

  for (const [sessionId, sets] of bySession) {
    const first = sets[0];
    if (first === undefined) continue;

    let topLoad: Decimal | null = null;
    let topLoadReps: number | null = null;
    let topLoadBodyweight: string | null = null;
    let bestEstimatedMax: Decimal | null = null;
    let volume: Decimal | null = null;
    let workingSets = 0;
    let totalReps = 0;

    for (const set of sets) {
      const contribution = setVolume(set, exercise, set.bodyweightKg);
      if (!contribution.counted) continue;
      // `counted` implies a usable load and at least one rep; the checks below
      // are for the type system rather than for the logic.
      if (set.reps === null) continue;

      const load = contribution.effectiveLoad;

      workingSets += 1;
      totalReps += set.reps;
      // Exact addition. This figure is charted, not stored, but it is compared
      // to the stored session volume and the two must agree digit for digit.
      volume = volume === null ? contribution.volume : addDecimal(volume, contribution.volume);

      const comparison = topLoad === null ? 1 : compareDecimal(load, topLoad);
      if (comparison > 0) {
        topLoad = load;
        topLoadReps = set.reps;
        topLoadBodyweight = set.bodyweightKg;
      } else if (comparison === 0 && (topLoadReps === null || set.reps > topLoadReps)) {
        topLoadReps = set.reps;
      }

      const estimate = estimateOneRepMax(load, set.reps);
      if (estimate !== null && (bestEstimatedMax === null || compareDecimal(estimate, bestEstimatedMax) > 0)) {
        bestEstimatedMax = estimate;
      }
    }

    points.push({
      sessionId,
      dayKey: dayKeyInZone(first.performedAt, first.zone),
      topLoad,
      topLoadReps,
      relativeTopLoad: topLoad === null ? null : relativeStrength(topLoad, topLoadBodyweight),
      bestEstimatedMax,
      volume,
      workingSets,
      totalReps,
    });
  }

  return points.sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

/** Progression as a chartable series. `null` points become gaps (§8.9(3)). */
export function progressionSeries(
  points: readonly ProgressionPoint[],
  measure: 'topLoad' | 'bestEstimatedMax' | 'volume',
): readonly DailyValue[] {
  return points.flatMap((point) => {
    const value = point[measure];
    return value === null ? [] : [{ dayKey: point.dayKey, value: Number(formatDecimal(value)) }];
  });
}

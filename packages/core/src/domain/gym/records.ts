/**
 * Personal-record detection — §4.1's "personal-record detection".
 *
 * The feature is one line in the blueprint and three decisions in practice, all
 * of which are about *not overclaiming*. A PR badge is the most emotionally
 * loaded thing this application renders; awarding one for a set that was not
 * actually better is how the operator learns to ignore them.
 *
 * ## Three kinds, each with a definition that survives scrutiny
 *
 * | Kind | Beats the record when | Why it exists separately |
 * |---|---|---|
 * | `load` | the heaviest weight moved for at least one rep | The number a lifter quotes. Says nothing about work done. |
 * | `reps` | the most reps at or above the previous best load | Progression on a fixed weight, which is most of a novice's year. |
 * | `e1rm` | the best estimated one-rep max | Compares a heavy triple to a light ten. The only one that ranks *across* rep ranges. |
 *
 * Single-set volume was considered as a fourth and rejected: it is maximised by
 * doing thirty easy reps, so it would reward the one thing a novice should not
 * be optimising for.
 *
 * ## The estimate, and its ceiling
 *
 * Epley: `1RM = w × (1 + r / 30)`. Chosen over Brzycki because it degrades more
 * gracefully at higher reps and because it is exact in rational arithmetic —
 * `w × (30 + r) ÷ 30` — which matters when the result is compared for equality
 * against a stored record.
 *
 * It is **refused above {@link MAX_ESTIMABLE_REPS}**. Every rep-max formula is
 * fitted to sets of roughly one to ten and diverges badly past that; a set of
 * twenty at bodyweight would estimate a one-rep max nobody could lift, and the
 * app would then congratulate the operator on a PR that does not exist. §4.1's
 * own note on RPE applies here too: "subjective and known to be unreliable in
 * novice lifters — treat early values as directional."
 *
 * ## What is *not* a record
 *
 * Warm-ups. A warm-up is submaximal by definition, and a ramp to a heavy single
 * would otherwise award three PRs on the way up.
 */

import type { Decimal } from '../../units/decimal';
import {
  DECIMAL_ZERO,
  addDecimal,
  compareDecimal,
  decimalFromInteger,
  divideDecimal,
  multiplyDecimal,
  parseDecimal,
} from '../../units/decimal';
import type { Exercise } from './exercise';
import { countsTowardsVolume } from './exercise';
import type { WorkoutSet } from './session';
import { effectiveLoad } from './volume';

/**
 * The highest rep count an estimate is offered for.
 *
 * Twelve. Past this the formula is extrapolating well outside the range it was
 * fitted on, and a confident-looking wrong number is worse than no number.
 */
export const MAX_ESTIMABLE_REPS = 12;

/** Scale for estimated maxima. Six, matching the storage scale (§5.3). */
const ESTIMATE_SCALE = 6;

const THIRTY = decimalFromInteger(30) ?? DECIMAL_ZERO;

/**
 * Estimated one-rep max, by Epley.
 *
 * @returns `null` for a non-positive load, a rep count outside 1…
 *   {@link MAX_ESTIMABLE_REPS}, or an unparseable input. Never a guess.
 */
export function estimateOneRepMax(loadKg: Decimal, reps: number): Decimal | null {
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_ESTIMABLE_REPS) return null;
  if (compareDecimal(loadKg, DECIMAL_ZERO) <= 0) return null;

  // A single is its own maximum; the formula agrees, but stating it avoids a
  // rounding artefact on the most common heavy set there is.
  if (reps === 1) return loadKg;

  const repsDecimal = decimalFromInteger(reps);
  if (repsDecimal === null) return null;

  // w × (30 + r) ÷ 30 — the same value as w × (1 + r/30), without the
  // intermediate division that would round before the multiply.
  return divideDecimal(multiplyDecimal(loadKg, addDecimal(THIRTY, repsDecimal)), THIRTY, ESTIMATE_SCALE);
}

export type PersonalRecordKind = 'load' | 'reps' | 'e1rm';

/** The best an exercise has seen, before the candidate set. */
export type ExerciseBest = {
  /** Heaviest effective load moved for at least one rep. */
  readonly load: Decimal | null;
  /** Most reps performed at or above {@link load}. */
  readonly repsAtBestLoad: number | null;
  readonly e1rm: Decimal | null;
  /** Whether any qualifying set has ever been logged for this exercise. */
  readonly hasHistory: boolean;
};

export const NO_HISTORY: ExerciseBest = Object.freeze({
  load: null,
  repsAtBestLoad: null,
  e1rm: null,
  hasHistory: false,
});

/** A set as `records` needs to see it. */
export type RecordCandidate = Pick<WorkoutSet, 'kind' | 'load' | 'reps'>;

/**
 * Fold a history of sets into the bests they establish.
 *
 * Takes every set ever logged for one exercise. The caller supplies them; this
 * function does not care about order, which means a late-arriving offline set
 * produces the same answer as one that arrived on time.
 */
export function bestFrom(
  history: readonly RecordCandidate[],
  exercise: Pick<Exercise, 'isBodyweight'>,
  bodyweightKg: string | null,
): ExerciseBest {
  let load: Decimal | null = null;
  let repsAtBestLoad: number | null = null;
  let e1rm: Decimal | null = null;
  let hasHistory = false;

  for (const set of history) {
    if (!countsTowardsVolume(set.kind)) continue;
    if (set.reps === null || set.reps < 1) continue;

    const resolved = effectiveLoad(set.load, exercise, bodyweightKg);
    if (resolved === null) continue;

    hasHistory = true;

    const comparison = load === null ? 1 : compareDecimal(resolved, load);
    if (comparison > 0) {
      load = resolved;
      repsAtBestLoad = set.reps;
    } else if (comparison === 0 && (repsAtBestLoad === null || set.reps > repsAtBestLoad)) {
      repsAtBestLoad = set.reps;
    }

    const estimate = estimateOneRepMax(resolved, set.reps);
    if (estimate !== null && (e1rm === null || compareDecimal(estimate, e1rm) > 0)) {
      e1rm = estimate;
    }
  }

  return { load, repsAtBestLoad, e1rm, hasHistory };
}

export type RecordVerdict = {
  readonly kinds: readonly PersonalRecordKind[];
  /**
   * Whether this is the first qualifying set for the exercise.
   *
   * Everything is a record the first time, and badging it "PR" is noise that
   * teaches the operator to ignore the badge. The UI renders "first logged"
   * instead, which is true and useful.
   */
  readonly isFirst: boolean;
  /** The candidate's estimated one-rep max, when one could be computed. */
  readonly estimatedOneRepMax: Decimal | null;
};

export const NO_RECORD: RecordVerdict = Object.freeze({
  kinds: [],
  isFirst: false,
  estimatedOneRepMax: null,
});

/**
 * Decide which records, if any, a set breaks.
 *
 * Strictly greater in every case. Equalling a personal best is a good session
 * and not a new record, and a system that says otherwise awards one every time
 * the operator repeats last week's work.
 */
export function detectRecords(
  candidate: RecordCandidate,
  best: ExerciseBest,
  exercise: Pick<Exercise, 'isBodyweight'>,
  bodyweightKg: string | null,
): RecordVerdict {
  if (!countsTowardsVolume(candidate.kind)) return NO_RECORD;
  if (candidate.reps === null || candidate.reps < 1) return NO_RECORD;

  const load = effectiveLoad(candidate.load, exercise, bodyweightKg);
  if (load === null) return NO_RECORD;

  const estimate = estimateOneRepMax(load, candidate.reps);

  if (!best.hasHistory) {
    return { kinds: [], isFirst: true, estimatedOneRepMax: estimate };
  }

  const kinds: PersonalRecordKind[] = [];

  if (best.load === null || compareDecimal(load, best.load) > 0) {
    kinds.push('load');
  }

  /*
   * A rep PR requires the load to be *at least* the previous best.
   *
   * Without that guard, doing twelve reps at half the weight would count as a
   * rep record, and the badge would fire on every deload week — which is the
   * one week it should be silent.
   */
  if (
    best.load !== null &&
    compareDecimal(load, best.load) >= 0 &&
    best.repsAtBestLoad !== null &&
    candidate.reps > best.repsAtBestLoad
  ) {
    kinds.push('reps');
  }

  if (estimate !== null && (best.e1rm === null || compareDecimal(estimate, best.e1rm) > 0)) {
    kinds.push('e1rm');
  }

  return { kinds, isFirst: false, estimatedOneRepMax: estimate };
}

/** Human-readable, for the badge and for the timeline. */
export const RECORD_LABELS: Readonly<Record<PersonalRecordKind, string>> = Object.freeze({
  load: 'Heaviest ever',
  reps: 'Most reps at this weight',
  e1rm: 'Best estimated max',
});

/**
 * Relative strength — load moved as a multiple of bodyweight.
 *
 * §4.1 lists bodyweight as a *read* dependency of Gym for exactly this: "reads
 * bodyweight for relative-strength calculation". A 100 kg squat means something
 * different at 65 kg than at 95 kg, and during a bulk the absolute number rises
 * for reasons that are not strength.
 *
 * @returns `null` when bodyweight is unknown, which is the honest answer rather
 *   than a ratio computed against a stale weigh-in.
 */
export function relativeStrength(loadKg: Decimal, bodyweightKg: string | null): Decimal | null {
  const body = bodyweightKg === null ? null : parseDecimal(bodyweightKg);
  if (body === null || compareDecimal(body, DECIMAL_ZERO) <= 0) return null;
  // Two places. A third would imply a precision that a bodyweight varying by a
  // kilogram between mornings does not support.
  return divideDecimal(loadKg, body, 2);
}

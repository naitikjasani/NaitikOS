/**
 * Training volume — §4.1's "volume/intensity/frequency analysis by muscle group".
 *
 * Volume is load × reps, summed. That is the whole of the arithmetic and almost
 * none of the difficulty. The difficulty is in three modelling decisions that
 * every training app makes silently and gets slightly wrong, and which matter
 * here because `gym.session.volume` is written to the observation log and
 * consumed by the insight engine (§4.1: "training-load signals... which is what
 * makes 'your skin flares two days after high-volume leg sessions' computable at
 * all"). A quietly wrong number propagates into a clinical-sounding claim.
 *
 * ## 1. Bodyweight movements
 *
 * `gym.set.load` records *external* load and says so: "excludes bodyweight even
 * for bodyweight movements". So a set of pull-ups at +10 kg has `load = 10`, and
 * its volume computed naively is `10 × 8 = 80 kg` — for eight pull-ups, which is
 * absurd, and which would make a pull-up day look like a rest day.
 *
 * The fix is to add the session's bodyweight. The trap is what to do when
 * bodyweight is unknown, and the tempting answers are both wrong: treating it as
 * zero understates volume by an order of magnitude, and guessing from the most
 * recent weigh-in silently attributes today's number to a session six weeks ago.
 *
 * **So an unresolvable set is excluded and counted.** {@link SessionVolume}
 * carries `excludedSets`, the UI shows "3 sets not counted — no bodyweight
 * recorded", and the operator can fix it. A visible gap beats an invisible lie;
 * this is §8.9(3) applied to arithmetic rather than to a chart.
 *
 * ## 2. Warm-ups
 *
 * Excluded, per `gym.session.volume`'s own description. A lifter ramping to a
 * heavy single does five warm-up sets, and counting them turns the highest-
 * intensity day of the week into the highest-*volume* day of the week — which
 * inverts the signal the insight engine is reading.
 *
 * ## 3. Attributing volume to muscles
 *
 * A bench press trains chest, and it also trains triceps and front delts. There
 * is no measurement that says how much, so any split is a modelling choice.
 * {@link SECONDARY_MUSCLE_SHARE} makes ours explicit and adjustable rather than
 * scattered through the code as a magic `0.5`.
 *
 * **This is the least defensible number in the file and it is deliberately the
 * most visible.** It is not derived from physiology. It exists so that "which
 * muscle groups am I actually training" has an answer that is consistent over
 * twenty years, and consistency is the property that makes the comparison
 * useful even when the absolute figure is arbitrary. The volume chart says so.
 */

import type { Decimal } from '../../units/decimal';
import {
  DECIMAL_ZERO,
  addDecimal,
  decimalFromInteger,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
} from '../../units/decimal';
import type { Exercise, MuscleGroup } from './exercise';
import { countsTowardsVolume } from './exercise';
import type { WorkoutSet } from './session';

/**
 * The share of a set's volume attributed to each secondary muscle.
 *
 * Half. See the file header — this is a convention, not a measurement, and the
 * chart that renders it says as much on its face.
 */
export const SECONDARY_MUSCLE_SHARE = '0.5';

/** Why a set contributed nothing. */
export type VolumeExclusion =
  /** A warm-up. Excluded by definition, not by absence. */
  | 'warmup'
  /** No load, or no reps. Nothing to multiply. */
  | 'incomplete'
  /** A bodyweight movement in a session with no recorded bodyweight. */
  | 'bodyweight_unknown';

export type SetVolume =
  | { readonly counted: true; readonly volume: Decimal; readonly effectiveLoad: Decimal }
  | { readonly counted: false; readonly reason: VolumeExclusion };

/**
 * The load actually moved by one repetition.
 *
 * External load for a loaded movement; external load *plus bodyweight* for a
 * bodyweight movement. Returns `null` when a bodyweight movement has no
 * bodyweight to add — see the header for why that is not zero.
 */
export function effectiveLoad(
  loadKg: string | null,
  exercise: Pick<Exercise, 'isBodyweight'>,
  bodyweightKg: string | null,
): Decimal | null {
  const external = loadKg === null ? DECIMAL_ZERO : parseDecimal(loadKg);
  if (external === null) return null;
  if (!exercise.isBodyweight) return external;

  const body = bodyweightKg === null ? null : parseDecimal(bodyweightKg);
  if (body === null) return null;

  return addDecimal(external, body);
}

/**
 * Volume for one set.
 *
 * Exact throughout: this feeds an observation, and §5.3's "numeric never float"
 * governs anything that reaches the record. A `74.5 × 8` computed in binary
 * floating point is `595.9999999999999` often enough to matter over a decade of
 * summing.
 */
export function setVolume(
  set: Pick<WorkoutSet, 'kind' | 'load' | 'reps'>,
  exercise: Pick<Exercise, 'isBodyweight'>,
  bodyweightKg: string | null,
): SetVolume {
  if (!countsTowardsVolume(set.kind)) return { counted: false, reason: 'warmup' };
  if (set.reps === null || set.reps <= 0) return { counted: false, reason: 'incomplete' };

  const load = effectiveLoad(set.load, exercise, bodyweightKg);
  if (load === null) {
    return {
      counted: false,
      reason: exercise.isBodyweight ? 'bodyweight_unknown' : 'incomplete',
    };
  }

  const reps = decimalFromInteger(set.reps);
  if (reps === null) return { counted: false, reason: 'incomplete' };

  return { counted: true, volume: multiplyDecimal(load, reps), effectiveLoad: load };
}

export type SessionVolume = {
  /** Kilograms. Exact. */
  readonly total: Decimal;
  readonly countedSets: number;
  /** Sets that contributed nothing, by reason. Surfaced, never swallowed. */
  readonly excluded: Readonly<Record<VolumeExclusion, number>>;
  /** Total repetitions across counted sets — the other half of "how much work". */
  readonly totalReps: number;
};

/** An exercise lookup, so callers pass a map rather than re-joining per set. */
export type ExerciseLookup = (exerciseId: string) => Pick<Exercise, 'isBodyweight' | 'primaryMuscle' | 'secondaryMuscles'> | null;

/**
 * Total volume for a session.
 *
 * A set whose exercise is unknown is `incomplete` rather than an exception. The
 * logger writes the set and the exercise separately, and a partially synced
 * device can genuinely hold one without the other for a few seconds — throwing
 * there would break the live session screen for a transient state that resolves
 * itself.
 */
export function sessionVolume(
  sets: readonly Pick<WorkoutSet, 'exerciseId' | 'kind' | 'load' | 'reps'>[],
  exercises: ExerciseLookup,
  bodyweightKg: string | null,
): SessionVolume {
  let total = DECIMAL_ZERO;
  let countedSets = 0;
  let totalReps = 0;
  const excluded: Record<VolumeExclusion, number> = {
    warmup: 0,
    incomplete: 0,
    bodyweight_unknown: 0,
  };

  for (const set of sets) {
    const exercise = exercises(set.exerciseId);
    if (exercise === null) {
      excluded.incomplete += 1;
      continue;
    }

    const contribution = setVolume(set, exercise, bodyweightKg);
    if (!contribution.counted) {
      excluded[contribution.reason] += 1;
      continue;
    }

    total = addDecimal(total, contribution.volume);
    countedSets += 1;
    totalReps += set.reps ?? 0;
  }

  // Six places is the storage scale (§5.3). Rounding here rather than at the
  // write keeps the number the UI shows and the number the record holds equal.
  return { total: roundDecimal(total, 6), countedSets, excluded, totalReps };
}

/**
 * Volume attributed to each muscle group.
 *
 * The primary muscle takes the full set; each secondary takes
 * {@link SECONDARY_MUSCLE_SHARE}. Consequently the sum across groups exceeds the
 * session total, and that is correct rather than a bug: the question "how much
 * did I train my back this week" is not a partition of a fixed quantity, and
 * normalising it to one would understate every compound movement.
 *
 * The chart labels its axis "attributed volume" for exactly this reason.
 */
export function volumeByMuscle(
  sets: readonly Pick<WorkoutSet, 'exerciseId' | 'kind' | 'load' | 'reps'>[],
  exercises: ExerciseLookup,
  bodyweightKg: string | null,
): ReadonlyMap<MuscleGroup, Decimal> {
  const share = parseDecimal(SECONDARY_MUSCLE_SHARE) ?? DECIMAL_ZERO;
  const totals = new Map<MuscleGroup, Decimal>();

  const add = (muscle: MuscleGroup, amount: Decimal): void => {
    totals.set(muscle, addDecimal(totals.get(muscle) ?? DECIMAL_ZERO, amount));
  };

  for (const set of sets) {
    const exercise = exercises(set.exerciseId);
    if (exercise === null) continue;

    const contribution = setVolume(set, exercise, bodyweightKg);
    if (!contribution.counted) continue;

    add(exercise.primaryMuscle, contribution.volume);
    for (const secondary of exercise.secondaryMuscles) {
      // A muscle listed as both primary and secondary would otherwise be paid
      // 1.5×. Data entry makes that mistake; the arithmetic should not repeat it.
      if (secondary === exercise.primaryMuscle) continue;
      add(secondary, multiplyDecimal(contribution.volume, share));
    }
  }

  return new Map([...totals].map(([muscle, value]) => [muscle, roundDecimal(value, 6)]));
}

/**
 * Sets performed per muscle group — §4.1's "frequency analysis".
 *
 * Counted rather than weighted, because the training literature that discusses
 * weekly set counts counts *sets*, not fractions of sets. Presenting a
 * half-set would be a false precision that no source supports.
 */
export function setsByMuscle(
  sets: readonly Pick<WorkoutSet, 'exerciseId' | 'kind'>[],
  exercises: ExerciseLookup,
): ReadonlyMap<MuscleGroup, number> {
  const counts = new Map<MuscleGroup, number>();

  for (const set of sets) {
    if (!countsTowardsVolume(set.kind)) continue;
    const exercise = exercises(set.exerciseId);
    if (exercise === null) continue;

    counts.set(exercise.primaryMuscle, (counts.get(exercise.primaryMuscle) ?? 0) + 1);
  }

  return counts;
}

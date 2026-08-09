/**
 * The exercise library, as the domain sees it (§4.1, §9.2).
 *
 * The `exercise` table is reference data — the one part of Gym that is a
 * *library* rather than a record. §3.2 puts it under `/library/exercises` as
 * well as `/body/gym/exercises`, and that duplication in the navigation is a
 * clue about the model: an exercise is a shared noun that sessions point at, not
 * something a session owns.
 *
 * ## Why the unions are restated from `db/schema/enums.ts`
 *
 * Same reason `observations/metric.ts` restates the metric enums, and the same
 * direction: §5.0 lets `db` depend on `core` and never the reverse. `db` carries
 * a compile-time assertion that the lists still agree, so drift is a build
 * failure rather than a runtime surprise.
 */

/** Broad movement classification, for volume analysis by muscle group (§4.1). */
export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'core'
  | 'full_body';

export const MUSCLE_GROUPS: readonly MuscleGroup[] = Object.freeze([
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'core',
  'full_body',
]);

/** How a muscle group reads on a screen. */
export const MUSCLE_GROUP_LABELS: Readonly<Record<MuscleGroup, string>> = Object.freeze({
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  core: 'Core',
  full_body: 'Full body',
});

export type ExerciseMechanic = 'compound' | 'isolation';

export type EquipmentKind =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'kettlebell'
  | 'band'
  | 'other';

export const EQUIPMENT_KINDS: readonly EquipmentKind[] = Object.freeze([
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'kettlebell',
  'band',
  'other',
]);

export type WorkoutSetKind =
  /** Counts towards volume and towards progression. */
  | 'working'
  /** Excluded from volume (§9.2's `gym.session.volume`: "warm-up sets are excluded"). */
  | 'warmup'
  /** The tail of a drop set. Real work, so it counts. */
  | 'drop'
  /** Taken to failure. Counts, and is worth marking for RPE context. */
  | 'failure'
  /** A deliberately lighter set after the top set. Counts. */
  | 'backoff'
  /** As many reps as possible. Counts, and is the usual source of a rep PR. */
  | 'amrap';

export const WORKOUT_SET_KINDS: readonly WorkoutSetKind[] = Object.freeze([
  'working',
  'warmup',
  'drop',
  'failure',
  'backoff',
  'amrap',
]);

/**
 * Set kinds that contribute to training volume.
 *
 * Warm-ups are the only exclusion, and it is not a rounding decision: a lifter
 * who ramps to a heavy single does five warm-up sets, and counting them would
 * make a maximal-intensity day look like a high-volume day. The insight engine
 * consumes `gym.session.volume` for cross-domain work (§4.1), so the distinction
 * propagates well beyond the Gym screen.
 */
export const VOLUME_BEARING_KINDS: readonly WorkoutSetKind[] = Object.freeze([
  'working',
  'drop',
  'failure',
  'backoff',
  'amrap',
]);

export function countsTowardsVolume(kind: WorkoutSetKind): boolean {
  return VOLUME_BEARING_KINDS.includes(kind);
}

/**
 * A library exercise.
 *
 * `isBodyweight` and `isUnilateral` are the two flags that change arithmetic
 * rather than presentation, and both are easy to get wrong:
 *
 * - **`isBodyweight`** means the *external* load recorded excludes the body.
 *   A pull-up at +10 kg is `load = 10`, and its true load is
 *   `10 + bodyweight`. `derivation/volume.ts` is the only place that resolves
 *   this, and it refuses to guess when bodyweight is unknown.
 * - **`isUnilateral`** means a set is one side. Volume is counted per set as
 *   logged, so logging both sides separately is correct and logging "8 reps"
 *   for a two-sided movement is not. The UI enforces the distinction; the
 *   arithmetic simply trusts what it is given.
 */
export type Exercise = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** `Bench Press` also answers to `BP`, `Barbell Bench`. Aids fuzzy lookup (§9.6). */
  readonly aliases: readonly string[];

  readonly primaryMuscle: MuscleGroup;
  readonly secondaryMuscles: readonly MuscleGroup[];
  readonly mechanic: ExerciseMechanic | null;
  readonly equipment: EquipmentKind | null;

  readonly isBodyweight: boolean;
  readonly isUnilateral: boolean;

  readonly instructions: string | null;
  /** User-authored cues that actually work for them. */
  readonly formNotes: string | null;
};

/**
 * A URL- and search-safe slug for an exercise name.
 *
 * Deterministic, so a re-seed cannot mint a second `barbell-bench-press` and
 * split an exercise's history in half. That is the whole reason it is a pure
 * function in `core` rather than a database default.
 */
export function exerciseSlug(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining marks so "Pallof Préss" and "Pallof Press" agree.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Score an exercise against a search term. Higher is better; 0 means no match.
 *
 * §4.1's design note governs this: under fatigue, mid-session, an exact-match
 * search box is a P1 violation. The database has a trigram index for genuine
 * fuzzy matching (§9.6), and this is the client-side half — it ranks an already
 * loaded library instantly, with no round trip, which is what makes the picker
 * usable in a basement with no signal.
 *
 * The ordering is deliberate: an exact name beats a prefix, a prefix beats an
 * alias, and an alias beats a substring. A lifter typing "bench" wants Bench
 * Press first, not Bench Press Close Grip because it happens to be shorter.
 */
export function scoreExerciseMatch(exercise: Exercise, term: string): number {
  const needle = term.trim().toLowerCase();
  if (needle === '') return 1;

  const name = exercise.name.toLowerCase();
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 80;

  const aliases = exercise.aliases.map((alias) => alias.toLowerCase());
  if (aliases.includes(needle)) return 70;
  if (aliases.some((alias) => alias.startsWith(needle))) return 60;

  if (name.includes(needle)) return 40;
  if (aliases.some((alias) => alias.includes(needle))) return 30;

  /*
   * Last resort: every word of the query appears somewhere, in any order.
   * "press bench" and "incline db" both find what they mean, which matters more
   * than it sounds when the alternative is typing precisely while out of breath.
   */
  const words = needle.split(/\s+/).filter((word) => word !== '');
  const haystack = [name, ...aliases].join(' ');
  if (words.length > 1 && words.every((word) => haystack.includes(word))) return 20;

  return 0;
}

/** Rank a library against a term, dropping non-matches. */
export function searchExercises(library: readonly Exercise[], term: string): readonly Exercise[] {
  return library
    .map((exercise) => ({ exercise, score: scoreExerciseMatch(exercise, term) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name))
    .map((candidate) => candidate.exercise);
}

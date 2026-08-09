/**
 * The seeded exercise library — §12's "exercise library, seeded".
 *
 * ## Why this is reference data rather than fixture data
 *
 * §12 lists it as a week-three deliverable, and the reason it must ship seeded
 * rather than be typed in is §4.1's design note: the logger's job is to make
 * logging a set a matter of *confirming* numbers. An empty library turns the
 * first session into forty minutes of data entry, which is exactly the friction
 * the whole module is arranged to remove — and the operator would give up
 * before reaching the part that works.
 *
 * So this is seeded in every environment, production included, and it is
 * idempotent on the slug (see `exercise.repository.ts` for why the slug and not
 * the id).
 *
 * ## What is in it, and what is not
 *
 * Roughly fifty movements: the barbell lifts, their dumbbell and machine
 * equivalents, the common bodyweight movements, and enough accessory work to
 * cover a normal push/pull/legs or upper/lower split. Deliberately **not** a
 * five-hundred-entry catalogue — §3.1's warning about "fourteen mostly-empty
 * sections" applies to a search box too, and a library where "row" returns
 * thirty variants is one where the picker is slower than typing.
 *
 * Adding one is a two-line edit here plus a re-seed, and the operator can also
 * add their own through the library screen. Both paths converge on the same
 * table.
 *
 * ## The fields that change arithmetic
 *
 * `isBodyweight` and `isUnilateral` are not descriptive — `domain/gym/volume.ts`
 * reads both, and getting either wrong makes every volume figure for that
 * movement wrong. A pull-up marked as loaded contributes 10 kg × 8 rather than
 * 84 kg × 8; a lunge marked bilateral halves its recorded leg volume. They are
 * stated per row rather than inferred from the equipment.
 */

import { exerciseSlug, type Exercise } from '@naitikos/core';

type SeedExercise = Omit<Exercise, 'id' | 'slug' | 'instructions' | 'formNotes'> & {
  readonly instructions?: string;
};

function movement(definition: SeedExercise): Omit<Exercise, 'id'> {
  return {
    ...definition,
    slug: exerciseSlug(definition.name),
    instructions: definition.instructions ?? null,
    // Never seeded. §4.1 calls this "user-authored cues that actually work for
    // them" — it is the operator's column, and the upsert deliberately leaves
    // it alone on a re-seed.
    formNotes: null,
  };
}

export const SEED_EXERCISES: readonly Omit<Exercise, 'id'>[] = [
  /* --- Chest --------------------------------------------------------- */
  movement({
    name: 'Barbell Bench Press',
    aliases: ['bench', 'bench press', 'bp', 'flat bench'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Incline Barbell Bench Press',
    aliases: ['incline bench', 'incline bp'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['shoulders', 'triceps'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Dumbbell Bench Press',
    aliases: ['db bench', 'dumbbell press'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Incline Dumbbell Bench Press',
    aliases: ['incline db bench', 'incline db press'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['shoulders', 'triceps'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Machine Chest Press',
    aliases: ['chest press'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders'],
    mechanic: 'compound',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Cable Fly',
    aliases: ['cable crossover', 'fly'],
    primaryMuscle: 'chest',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Push-Up',
    aliases: ['pushup', 'press-up'],
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'core'],
    mechanic: 'compound',
    equipment: 'bodyweight',
    // The body is the load. `volume.ts` adds the session bodyweight, and
    // refuses to count the set at all when none was recorded.
    isBodyweight: true,
    isUnilateral: false,
  }),

  /* --- Back ---------------------------------------------------------- */
  movement({
    name: 'Deadlift',
    aliases: ['conventional deadlift', 'dl'],
    primaryMuscle: 'back',
    secondaryMuscles: ['hamstrings', 'glutes', 'forearms'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Barbell Row',
    aliases: ['bent over row', 'bb row', 'pendlay row'],
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Pull-Up',
    aliases: ['pullup', 'chin-up', 'chinup'],
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    mechanic: 'compound',
    equipment: 'bodyweight',
    isBodyweight: true,
    isUnilateral: false,
  }),
  movement({
    name: 'Lat Pulldown',
    aliases: ['pulldown', 'lat pull'],
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps'],
    mechanic: 'compound',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Seated Cable Row',
    aliases: ['cable row', 'seated row'],
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    mechanic: 'compound',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Single-Arm Dumbbell Row',
    aliases: ['db row', 'one arm row'],
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    // Logged per side. The logger requires a side, and `volume.ts` counts each
    // logged set once — so both sides are two sets, which is correct.
    isUnilateral: true,
  }),
  movement({
    name: 'Face Pull',
    aliases: ['facepull'],
    primaryMuscle: 'shoulders',
    secondaryMuscles: ['back'],
    mechanic: 'isolation',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),

  /* --- Shoulders ----------------------------------------------------- */
  movement({
    name: 'Overhead Press',
    aliases: ['ohp', 'military press', 'shoulder press'],
    primaryMuscle: 'shoulders',
    secondaryMuscles: ['triceps', 'core'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Seated Dumbbell Shoulder Press',
    aliases: ['db shoulder press', 'db ohp'],
    primaryMuscle: 'shoulders',
    secondaryMuscles: ['triceps'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Lateral Raise',
    aliases: ['side raise', 'lat raise'],
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Rear Delt Fly',
    aliases: ['reverse fly', 'rear fly'],
    primaryMuscle: 'shoulders',
    secondaryMuscles: ['back'],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),

  /* --- Arms ---------------------------------------------------------- */
  movement({
    name: 'Barbell Curl',
    aliases: ['bb curl', 'bicep curl'],
    primaryMuscle: 'biceps',
    secondaryMuscles: ['forearms'],
    mechanic: 'isolation',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Dumbbell Curl',
    aliases: ['db curl'],
    primaryMuscle: 'biceps',
    secondaryMuscles: ['forearms'],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Hammer Curl',
    aliases: [],
    primaryMuscle: 'biceps',
    secondaryMuscles: ['forearms'],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Preacher Curl',
    aliases: [],
    primaryMuscle: 'biceps',
    secondaryMuscles: ['forearms'],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Cable Triceps Pushdown',
    aliases: ['pushdown', 'tricep pushdown'],
    primaryMuscle: 'triceps',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Overhead Triceps Extension',
    aliases: ['skullcrusher', 'tricep extension'],
    primaryMuscle: 'triceps',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Dip',
    aliases: ['dips', 'parallel bar dip'],
    primaryMuscle: 'triceps',
    secondaryMuscles: ['chest', 'shoulders'],
    mechanic: 'compound',
    equipment: 'bodyweight',
    isBodyweight: true,
    isUnilateral: false,
  }),
  movement({
    name: 'Wrist Curl',
    aliases: [],
    primaryMuscle: 'forearms',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: false,
  }),

  /* --- Legs ---------------------------------------------------------- */
  movement({
    name: 'Back Squat',
    aliases: ['squat', 'barbell squat'],
    primaryMuscle: 'quads',
    secondaryMuscles: ['glutes', 'hamstrings', 'core'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Front Squat',
    aliases: [],
    primaryMuscle: 'quads',
    secondaryMuscles: ['glutes', 'core'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Romanian Deadlift',
    aliases: ['rdl', 'stiff leg deadlift'],
    primaryMuscle: 'hamstrings',
    secondaryMuscles: ['glutes', 'back'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Leg Press',
    aliases: [],
    primaryMuscle: 'quads',
    secondaryMuscles: ['glutes'],
    mechanic: 'compound',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Bulgarian Split Squat',
    aliases: ['split squat', 'bss'],
    primaryMuscle: 'quads',
    secondaryMuscles: ['glutes', 'hamstrings'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: true,
  }),
  movement({
    name: 'Walking Lunge',
    aliases: ['lunge'],
    primaryMuscle: 'quads',
    secondaryMuscles: ['glutes', 'hamstrings'],
    mechanic: 'compound',
    equipment: 'dumbbell',
    isBodyweight: false,
    isUnilateral: true,
  }),
  movement({
    name: 'Leg Extension',
    aliases: ['quad extension'],
    primaryMuscle: 'quads',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Lying Leg Curl',
    aliases: ['leg curl', 'hamstring curl'],
    primaryMuscle: 'hamstrings',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Hip Thrust',
    aliases: ['barbell hip thrust'],
    primaryMuscle: 'glutes',
    secondaryMuscles: ['hamstrings'],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Standing Calf Raise',
    aliases: ['calf raise'],
    primaryMuscle: 'calves',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Seated Calf Raise',
    aliases: [],
    primaryMuscle: 'calves',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'machine',
    isBodyweight: false,
    isUnilateral: false,
  }),

  /* --- Core ---------------------------------------------------------- */
  movement({
    name: 'Plank',
    aliases: [],
    primaryMuscle: 'core',
    secondaryMuscles: ['shoulders'],
    mechanic: 'isolation',
    equipment: 'bodyweight',
    /*
     * A plank is held, not repeated, and the logger records seconds in the reps
     * field with the unit implied by the movement. Marking it `isBodyweight`
     * would make `volume.ts` multiply the operator's bodyweight by a duration,
     * producing a number in kilogram-seconds that means nothing — so it is
     * false, and a plank contributes no volume at all. That is the honest
     * answer: this system has no volume model for isometric work.
     */
    isBodyweight: false,
    isUnilateral: false,
    instructions: 'Held, not repeated. Record the hold in seconds; it contributes no training volume.',
  }),
  movement({
    name: 'Hanging Leg Raise',
    aliases: ['leg raise'],
    primaryMuscle: 'core',
    secondaryMuscles: ['forearms'],
    mechanic: 'compound',
    equipment: 'bodyweight',
    isBodyweight: true,
    isUnilateral: false,
  }),
  movement({
    name: 'Cable Crunch',
    aliases: [],
    primaryMuscle: 'core',
    secondaryMuscles: [],
    mechanic: 'isolation',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: false,
  }),
  movement({
    name: 'Pallof Press',
    aliases: ['anti-rotation press'],
    primaryMuscle: 'core',
    secondaryMuscles: ['shoulders'],
    mechanic: 'isolation',
    equipment: 'cable',
    isBodyweight: false,
    isUnilateral: true,
  }),
];

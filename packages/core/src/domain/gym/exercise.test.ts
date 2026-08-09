import { describe, expect, it } from 'vitest';

import type { Exercise } from './exercise';
import {
  MUSCLE_GROUPS,
  VOLUME_BEARING_KINDS,
  WORKOUT_SET_KINDS,
  countsTowardsVolume,
  exerciseSlug,
  scoreExerciseMatch,
  searchExercises,
} from './exercise';

function exercise(name: string, aliases: readonly string[] = []): Exercise {
  return {
    id: exerciseSlug(name),
    name,
    slug: exerciseSlug(name),
    aliases,
    primaryMuscle: 'chest',
    secondaryMuscles: [],
    mechanic: 'compound',
    equipment: 'barbell',
    isBodyweight: false,
    isUnilateral: false,
    instructions: null,
    formNotes: null,
  };
}

describe('exerciseSlug', () => {
  it('is deterministic and URL-safe', () => {
    expect(exerciseSlug('Barbell Bench Press')).toBe('barbell-bench-press');
    expect(exerciseSlug('Pull-Up')).toBe('pull-up');
    expect(exerciseSlug('Romanian Deadlift (RDL)')).toBe('romanian-deadlift-rdl');
    expect(exerciseSlug('  Leading and trailing  ')).toBe('leading-and-trailing');
  });

  /**
   * The reason it is a pure function in `core` rather than a database default:
   * a re-seed must not be able to mint a second slug for the same movement and
   * split its history in half.
   */
  it('folds accents so one movement cannot become two exercises', () => {
    expect(exerciseSlug('Pallof Préss')).toBe(exerciseSlug('Pallof Press'));
  });
});

describe('countsTowardsVolume', () => {
  it('excludes only warm-ups', () => {
    for (const kind of WORKOUT_SET_KINDS) {
      expect(countsTowardsVolume(kind)).toBe(kind !== 'warmup');
    }
    expect(VOLUME_BEARING_KINDS).not.toContain('warmup');
  });
});

describe('scoreExerciseMatch', () => {
  it('ranks an exact name above a prefix above an alias above a substring', () => {
    const exact = scoreExerciseMatch(exercise('Bench'), 'bench');
    const prefix = scoreExerciseMatch(exercise('Bench Press'), 'bench');
    const alias = scoreExerciseMatch(exercise('Barbell Chest Press', ['bench']), 'bench');
    const substring = scoreExerciseMatch(exercise('Close Grip Bench Press'), 'bench');

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(alias);
    expect(alias).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  it('matches every word in any order, which is what a tired lifter types', () => {
    expect(scoreExerciseMatch(exercise('Incline Dumbbell Press'), 'press incline')).toBeGreaterThan(0);
    expect(scoreExerciseMatch(exercise('Incline Dumbbell Press'), 'incline squat')).toBe(0);
  });

  it('returns everything for an empty term', () => {
    expect(scoreExerciseMatch(exercise('Anything'), '   ')).toBe(1);
  });

  it('does not match an unrelated movement', () => {
    expect(scoreExerciseMatch(exercise('Barbell Squat'), 'bench')).toBe(0);
  });
});

describe('searchExercises', () => {
  const library = [
    exercise('Close Grip Bench Press'),
    exercise('Barbell Bench Press', ['bp']),
    exercise('Barbell Squat'),
    exercise('Incline Dumbbell Press', ['incline db press']),
  ];

  it('puts the movement the operator meant first', () => {
    expect(searchExercises(library, 'bench')[0]?.name).toBe('Barbell Bench Press');
    expect(searchExercises(library, 'bp')[0]?.name).toBe('Barbell Bench Press');
    expect(searchExercises(library, 'incline db')[0]?.name).toBe('Incline Dumbbell Press');
  });

  it('drops non-matches rather than ranking them last', () => {
    expect(searchExercises(library, 'bench').map((item) => item.name)).not.toContain('Barbell Squat');
  });

  it('returns the whole library, alphabetically, for an empty term', () => {
    expect(searchExercises(library, '')).toHaveLength(library.length);
  });
});

describe('the muscle taxonomy', () => {
  it('has no duplicates, because a duplicate would double-count a chart', () => {
    expect(new Set(MUSCLE_GROUPS).size).toBe(MUSCLE_GROUPS.length);
  });
});

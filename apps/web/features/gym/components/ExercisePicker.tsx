'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { searchExercises, type Exercise } from '@naitikos/core';
import { Badge, EmptyState, Inline, SearchField, Sheet, Stack, Text } from '@naitikos/design-system';

/**
 * Choosing an exercise, mid-session, out of breath.
 *
 * §4.1's design note is unambiguous about the standard: "under fatigue,
 * mid-session, an exact-match search box is a P1 violation."
 *
 * ## Recents are the path; search is the fallback
 *
 * §4.3 states the hierarchy that §4.1 assumes: "recents and frequents — one
 * tap, covers the large majority of real intake for a person who eats broadly
 * the same things … search — the fallback, not the default." Training is *more*
 * repetitive than eating, not less; a lifter on a program performs the same
 * twelve movements for a mesocycle.
 *
 * Two things follow, and both used to be the other way round.
 *
 * **The recents are not scoped to this session.** They were, which meant the
 * list was empty at the exact moment it was most valuable — the first movement
 * of the workout — so every session began with a search. `liveSessionStore`
 * now remembers them across sessions, on the device.
 *
 * **The search field is not focused on open.** Autofocusing it raises the
 * software keyboard, which on a phone covers the bottom half of the screen:
 * the half the recents are in, and the half a thumb can reach (§8.13). It
 * turned a sheet whose top item is usually the right answer into a sheet
 * showing four rows and a keyboard. The operator who wants to type taps the
 * field, which costs one tap and is the *uncommon* path.
 *
 * ## Ranking happens on the device
 *
 * The whole library is loaded once and `core`'s `searchExercises` ranks it
 * locally on every keystroke. There is a perfectly good trigram index in
 * Postgres and this deliberately does not use it: a gym is a basement, and a
 * picker that needs a round trip to show results is a picker that shows nothing
 * for the ninety minutes it is actually needed.
 *
 * Fifty movements is a few kilobytes. The server path exists for the library
 * screen, where the catalogue may eventually outgrow that.
 */

export type ExercisePickerProps = {
  readonly open: boolean;
  readonly exercises: readonly Exercise[];
  readonly onSelect: (exercise: Exercise) => void;
  readonly onClose: () => void;
  /** Shown at the top, above the search. The last few movements used. */
  readonly recent?: readonly Exercise[];
};

export function ExercisePicker({
  open,
  exercises,
  onSelect,
  onClose,
  recent = [],
}: ExercisePickerProps): ReactNode {
  const [term, setTerm] = useState('');

  const results = useMemo(() => searchExercises(exercises, term), [exercises, term]);

  const choose = (exercise: Exercise): void => {
    setTerm('');
    onSelect(exercise);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTerm('');
          onClose();
        }
      }}
      title="Add an exercise"
    >
      <Stack gap="3">
        <SearchField
          label="Find a movement"
          value={term}
          onValueChange={setTerm}
          placeholder="bench, squat, rdl…"
        />

        {/*
          Recent movements, above the results and only when nothing is typed.
          Most sessions repeat last week's, so the fastest path is usually a tap
          rather than a search — and showing them *under* a search box the
          operator has already started using would be noise.

          `gap-2` rather than `gap-1` throughout: these rows are full-width
          touch targets stacked directly on one another, and §8.13's "≥ 8px
          separation. Non-negotiable for gym use" is a rule about the space
          *between* targets, which `gap-1` (4px) breaks.
        */}
        {term === '' && recent.length > 0 && (
          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Recent
            </Text>
            {recent.map((exercise) => (
              <ExerciseRow key={exercise.id} exercise={exercise} onSelect={choose} />
            ))}
          </Stack>
        )}

        {results.length === 0 ? (
          <EmptyState
            icon="action.search"
            title="Nothing matches"
            description="Try a shorter word, or part of the equipment — “db”, “cable”."
          />
        ) : (
          <Stack gap="2">
            {results.slice(0, 40).map((exercise) => (
              <ExerciseRow key={exercise.id} exercise={exercise} onSelect={choose} />
            ))}
          </Stack>
        )}
      </Stack>
    </Sheet>
  );
}

function ExerciseRow({
  exercise,
  onSelect,
}: {
  readonly exercise: Exercise;
  readonly onSelect: (exercise: Exercise) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="nos-option-row"
      onClick={() => {
        onSelect(exercise);
      }}
    >
      <Stack gap="1">
        <Text role="body" as="span">
          {exercise.name}
        </Text>
        <Inline gap="1" align="center">
          <Badge tone="neutral">{exercise.primaryMuscle.replace('_', ' ')}</Badge>
          {exercise.equipment !== null && <Badge tone="neutral">{exercise.equipment}</Badge>}
          {/*
            Both of these change arithmetic rather than presentation, so they are
            surfaced at the point of choosing. A unilateral movement is logged
            per side; a bodyweight movement needs a recorded bodyweight before
            it counts towards volume at all.
          */}
          {exercise.isUnilateral && <Badge tone="accent">per side</Badge>}
          {exercise.isBodyweight && <Badge tone="accent">bodyweight</Badge>}
        </Inline>
      </Stack>
    </button>
  );
}

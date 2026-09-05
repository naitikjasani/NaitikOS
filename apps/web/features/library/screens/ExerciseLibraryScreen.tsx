'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { MUSCLE_GROUP_LABELS, searchExercises, type MuscleGroup } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, SearchField, Stack, Text } from '@naitikos/design-system';

import type { ExerciseLibraryBoard } from '@/lib/platform/library';

/**
 * `/library/exercises` — canonical exercise definitions (§3.2, §4.1).
 *
 * **A Client Component, and one of only two in this pillar.** The line is not
 * "a list is long" — it is *who writes the registry*. Exercises and foods grow
 * incidentally, a row at a time, as a side effect of logging; the other four
 * registries change only when someone deliberately changes them. A registry
 * that grows without an upper bound needs ranked search to stay usable, and
 * that needs state.
 *
 * The ranking is `core`'s `searchExercises` over the already-loaded board —
 * the same function the mid-session picker uses, so a movement found here and a
 * movement found there are found by the same rules. §4.1: "under fatigue,
 * mid-session, an exact-match search box is a P1 violation."
 *
 * ## Not the same page as `/body/gym/exercises`
 *
 * That one lives with the module, fetches through react-query and links each
 * movement to its history — it is the picker's neighbour. This one is the
 * reference read: server-loaded, grouped by primary muscle, and annotated with
 * how much the movement has actually been used. Neither owns the data.
 */
export function ExerciseLibraryScreen({ board }: { readonly board: ExerciseLibraryBoard }): ReactNode {
  const [term, setTerm] = useState('');

  const grouped = useMemo(() => {
    const matched = searchExercises(board.exercises, term);
    const byMuscle = new Map<MuscleGroup, typeof matched>();
    for (const exercise of matched) {
      byMuscle.set(exercise.primaryMuscle, [...(byMuscle.get(exercise.primaryMuscle) ?? []), exercise]);
    }
    return [...byMuscle.entries()].sort(([a], [b]) =>
      (MUSCLE_GROUP_LABELS[a] ?? a).localeCompare(MUSCLE_GROUP_LABELS[b] ?? b),
    );
  }, [board.exercises, term]);

  if (board.exercises.length === 0) {
    return (
      <EmptyState
        title="No exercises registered"
        description="The library is seeded on deploy and added to from the session logger. An empty one means neither has happened yet."
      />
    );
  }

  return (
    <Stack gap="4">
      <SearchField label="Find a movement" value={term} onValueChange={setTerm} placeholder="bench, squat, rdl…" />

      <Text role="body-sm" tone="secondary">
        {board.usageResolved
          ? `${String(board.exercises.length)} movements. Set counts cover the last ${String(board.usageDays)} days.`
          : `${String(board.exercises.length)} movements. Usage figures are unavailable for this window.`}
      </Text>

      {grouped.length === 0 ? (
        <EmptyState icon="action.search" title="Nothing matches" description="Try a shorter word." />
      ) : (
        grouped.map(([muscle, exercises]) => (
          <Stack key={muscle} gap="2">
            <Text role="title-3" as="h2">
              {MUSCLE_GROUP_LABELS[muscle] ?? muscle}
            </Text>
            {exercises.map((exercise) => {
              const sets = board.recentSets[exercise.id] ?? 0;
              return (
                <Card key={exercise.id} variant="outlined">
                  <CardBody>
                    <Inline gap="3" align="start" justify="between" wrap>
                      <Stack gap="1">
                        <Text role="body" as="h3">
                          {exercise.name}
                        </Text>
                        <Text role="mono" tone="tertiary" as="code">
                          {exercise.slug}
                        </Text>
                        {exercise.aliases.length > 0 && (
                          <Text role="caption" tone="tertiary">
                            {`Also: ${exercise.aliases.join(', ')}`}
                          </Text>
                        )}
                      </Stack>
                      <Inline gap="1" wrap>
                        {exercise.equipment !== null && <Badge tone="neutral">{exercise.equipment}</Badge>}
                        {exercise.mechanic !== null && <Badge tone="neutral">{exercise.mechanic}</Badge>}
                        {exercise.isUnilateral && <Badge tone="accent">per side</Badge>}
                        {exercise.isBodyweight && <Badge tone="accent">bodyweight</Badge>}
                        {board.usageResolved && (
                          /* Zero is said, not hidden. A movement in the library
                             that has never been done is a fact about the
                             library worth seeing. */
                          <Badge tone={sets === 0 ? 'neutral' : 'positive'}>{`${String(sets)} sets`}</Badge>
                        )}
                      </Inline>
                    </Inline>
                  </CardBody>
                </Card>
              );
            })}
          </Stack>
        ))
      )}
    </Stack>
  );
}

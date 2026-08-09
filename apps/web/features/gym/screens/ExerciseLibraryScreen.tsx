'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MUSCLE_GROUP_LABELS, searchExercises, type MuscleGroup } from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  SearchField,
  Stack,
  Text,
} from '@naitikos/design-system';

import { queryKeys } from '@/lib/query/QueryProvider';
import { fetchExercises } from '../services/gymClient';

/**
 * `/body/gym/exercises` — the library.
 *
 * Grouped by primary muscle rather than listed flat. Fifty entries in one
 * alphabetical column is a list nobody reads; grouped, it is a page you can scan
 * for "what do I have for back" — which is the question a library is actually
 * opened with.
 *
 * Search ranks locally, the same as the picker, for the same reason: it is
 * instant and it works with no signal.
 */

export function ExerciseLibraryScreen(): ReactNode {
  const [term, setTerm] = useState('');

  const library = useQuery({
    queryKey: queryKeys.gymExercises(),
    queryFn: () => fetchExercises(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const grouped = useMemo(() => {
    const matched = searchExercises(library.data ?? [], term);
    const byMuscle = new Map<MuscleGroup, typeof matched>();
    for (const exercise of matched) {
      byMuscle.set(exercise.primaryMuscle, [...(byMuscle.get(exercise.primaryMuscle) ?? []), exercise]);
    }
    return [...byMuscle.entries()].sort(([a], [b]) =>
      (MUSCLE_GROUP_LABELS[a] ?? a).localeCompare(MUSCLE_GROUP_LABELS[b] ?? b),
    );
  }, [library.data, term]);

  if (library.isLoading) return <LoadingState label="Loading the library" />;
  if (library.error !== null) {
    return <ErrorState title="Could not load the exercise library" description="Your sessions are unaffected." />;
  }

  return (
    <Stack gap="4">
      <SearchField label="Find a movement" value={term} onValueChange={setTerm} placeholder="bench, squat, rdl…" />

      {grouped.length === 0 ? (
        <EmptyState icon="action.search" title="Nothing matches" description="Try a shorter word." />
      ) : (
        grouped.map(([muscle, exercises]) => (
          <Stack key={muscle} gap="2">
            <Text role="title-3" as="h2">
              {MUSCLE_GROUP_LABELS[muscle] ?? muscle}
            </Text>
            {exercises.map((exercise) => (
              <Card key={exercise.id} variant="interactive">
                <CardBody>
                  <Link href={`/body/gym/exercises/${exercise.id}`} className="nos-card__link">
                    <Inline justify="between" align="center">
                      <Stack gap="1">
                        <Text role="body" as="span">
                          {exercise.name}
                        </Text>
                        <Inline gap="1">
                          {exercise.equipment !== null && <Badge tone="neutral">{exercise.equipment}</Badge>}
                          {exercise.mechanic !== null && <Badge tone="neutral">{exercise.mechanic}</Badge>}
                          {exercise.isUnilateral && <Badge tone="accent">per side</Badge>}
                          {exercise.isBodyweight && <Badge tone="accent">bodyweight</Badge>}
                        </Inline>
                      </Stack>
                    </Inline>
                  </Link>
                </CardBody>
              </Card>
            ))}
          </Stack>
        ))
      )}
    </Stack>
  );
}

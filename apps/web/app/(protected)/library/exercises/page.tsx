/** `/library/exercises` — canonical exercise definitions (§3.2, §4.1). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ExerciseLibraryScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadExerciseLibrary } from '@/lib/platform/library';

export const metadata = { title: 'Exercise library · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ExerciseLibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadExerciseLibrary(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Exercises"
      description="Every movement the record knows about, and how much each has actually been used."
    >
      {board.ok ? (
        <ExerciseLibraryScreen board={board.value} />
      ) : (
        <p>Could not load the exercise library: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

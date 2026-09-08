/** `/body/gym/exercises` — the exercise library (§3.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ExerciseLibraryScreen } from '@/features/gym';

export const metadata = { title: 'Exercises · Ekayu' };
export const dynamic = 'force-dynamic';

export default function ExerciseLibraryPage(): ReactNode {
  return (
    <PageContainer title="Exercises" description="Every movement the record knows about.">
      <ExerciseLibraryScreen />
    </PageContainer>
  );
}

/** `/work/learning/notes` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LearningNotesScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadLearning } from '@/lib/platform/learning';

export const metadata = { title: 'Notes & synthesis · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function LearningNotesPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadLearning(getDb());

  return (
    <PageContainer
      title="Notes & synthesis"
      description="Your own thinking, filed against the thing that prompted it."
    >
      {board.ok ? (
        <LearningNotesScreen board={board.value} />
      ) : (
        <p>Could not load the notes: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

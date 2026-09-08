/** `/work/learning` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LearningScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadLearning } from '@/lib/platform/learning';

export const metadata = { title: 'Learning · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function LearningPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadLearning(getDb());

  return (
    <PageContainer title="Learning" description="Queue, progress, and what actually stuck.">
      {board.ok ? (
        <LearningScreen board={board.value} />
      ) : (
        <p>Could not load learning: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

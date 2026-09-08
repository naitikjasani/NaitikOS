/** `/work/tasks` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { TaskBoardScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTaskBoard } from '@/lib/platform/work';

export const metadata = { title: 'Tasks · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TasksPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadTaskBoard(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Tasks" description="Deliberately minimal. Here for linkage, not for management.">
      {board.ok ? (
        <TaskBoardScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load tasks: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

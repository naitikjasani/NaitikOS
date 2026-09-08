/**
 * `/work/learning/queue` — §3.2, §4.8.
 *
 * This renders the same board as `/work/learning`, deliberately. §3.2 lists
 * both routes, so both exist and both are linkable; the queue *is* the learning
 * surface, and there is nothing on it that the parent page would want to hide.
 *
 * A second component showing a filtered subset — queued and in-progress only —
 * would be two things to keep in step for no gain: every change to how an item
 * renders its progress, its unit or its "put down" reason would have to land
 * twice, and the second copy is the one that quietly falls behind.
 *
 * If a split later earns its keep — a queue that reorders, or one long enough
 * to need its own paging — this is the file where it happens.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LearningScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadLearning } from '@/lib/platform/learning';

export const metadata = { title: 'Reading queue · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function LearningQueuePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadLearning(getDb());

  return (
    <PageContainer
      title="Reading queue"
      description="What is open, what is next, and what was put down. Putting something down is an ending, not a failure."
    >
      {board.ok ? (
        <LearningScreen board={board.value} />
      ) : (
        <p>Could not load the queue: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

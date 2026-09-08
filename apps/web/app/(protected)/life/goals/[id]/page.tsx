/** `/life/goals/:id` — target, trajectory, evidence (§3.2, §4.10). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { GoalDetailScreen } from '@/features/goals';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadGoal } from '@/lib/platform/goals';

export const metadata = { title: 'Goal · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function GoalPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadGoal(getDb(), id, DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title={detail.ok && detail.value !== null ? detail.value.goal.title : 'Goal'}
      description="What it is measured against, and where the line goes."
    >
      {!detail.ok ? (
        <p>Could not load it: {detail.error.message}</p>
      ) : detail.value === null ? (
        <p>No such goal.</p>
      ) : (
        <GoalDetailScreen detail={detail.value} />
      )}
    </PageContainer>
  );
}

/** `/life/goals` — §3.2, §4.10. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { GoalsScreen } from '@/features/goals';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadGoals } from '@/lib/platform/goals';

export const metadata = { title: 'Goals · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function GoalsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadGoals(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Goals" description="Am I moving toward what I said mattered?">
      {overview.ok ? <GoalsScreen overview={overview.value} /> : <p>Could not load goals: {overview.error.message}</p>}
    </PageContainer>
  );
}

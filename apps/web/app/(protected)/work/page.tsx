/** `/work` — the pillar overview (§3.2, §4.8). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { WorkOverviewScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadWorkOverview } from '@/lib/platform/work';

export const metadata = { title: 'Work · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function WorkPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadWorkOverview(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Work"
      description="Am I building the career I want, and what does it cost me?"
    >
      {overview.ok ? (
        <WorkOverviewScreen overview={overview.value} />
      ) : (
        <p>Could not load work: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

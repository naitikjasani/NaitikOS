/** `/body/health` — Health core's overview (§3.2, §4.4). */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { HealthOverviewScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadHealthOverview } from '@/lib/platform/health';

export const metadata = { title: 'Health · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function HealthPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadHealthOverview(getDb());

  return (
    <PageContainer
      title="Health"
      description="What your clinical state is, what you are taking, and what has actually happened."
    >
      {overview.ok ? (
        <HealthOverviewScreen overview={overview.value} nowIso={isoFromMillis(systemClock.nowMillis())} />
      ) : (
        <p>Could not load Health: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

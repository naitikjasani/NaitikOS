/** `/insights/archive` — §3.2's "dismissed & acted-on history". */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadInsightArchive } from '@/lib/platform/insights';
import { InsightArchiveScreen } from '@/features/insights';

export const metadata = { title: 'Insight history · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function InsightArchivePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const insights = await loadInsightArchive(getDb());

  return (
    <PageContainer
      title="Insight history"
      description="Everything ever surfaced, including what you dismissed. A surface that hid its own misses would report a hit rate of 100%."
    >
      {insights.ok ? (
        <InsightArchiveScreen insights={insights.value} />
      ) : (
        <p>Could not load the history: {insights.error.message}</p>
      )}
    </PageContainer>
  );
}

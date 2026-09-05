/** `/library/metrics` — the metric registry (§3.2, §9.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { MetricRegistryScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadMetricRegistry } from '@/lib/platform/library';

export const metadata = { title: 'Metric registry · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function MetricRegistryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadMetricRegistry(getDb());

  return (
    <PageContainer
      title="Metrics"
      description="Units, ranges, aggregation and meaning. What every number in this system is a number of."
    >
      {board.ok ? (
        <MetricRegistryScreen board={board.value} />
      ) : (
        <p>Could not load the metric registry: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

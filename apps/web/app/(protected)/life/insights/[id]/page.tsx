/** `/life/insights/:id` — §3.2, §4.13's audit view. */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadInsightDetail } from '@/lib/platform/insights';
import { InsightDetailScreen } from '@/features/insights';

export const metadata = { title: 'Insight · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function InsightDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadInsightDetail(getDb(), id);

  if (detail.ok && detail.value === null) notFound();

  return (
    <PageContainer title="Insight" description="The method, the sample, and the rows behind it.">
      {detail.ok && detail.value !== null ? (
        <InsightDetailScreen insight={detail.value.insight} evidence={detail.value.evidence} />
      ) : (
        <p>Could not load it{detail.ok ? '.' : `: ${detail.error.message}`}</p>
      )}
    </PageContainer>
  );
}

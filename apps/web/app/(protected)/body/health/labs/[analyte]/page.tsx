/** `/body/health/labs/:analyte` — one analyte over time (§3.2, §4.4). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { AnalyteScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadAnalyteHistory } from '@/lib/platform/health';

export const metadata = { title: 'Analyte · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AnalytePage({
  params,
}: {
  readonly params: Promise<{ readonly analyte: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { analyte } = await params;
  const history = await loadAnalyteHistory(getDb(), analyte);

  return (
    <PageContainer
      title={history.ok ? history.value.displayName : 'Analyte'}
      description="Every result, with the reference range each report printed."
    >
      {history.ok ? <AnalyteScreen history={history.value} /> : <p>Could not load it: {history.error.message}</p>}
    </PageContainer>
  );
}

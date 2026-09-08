/** `/body/health/labs` — every analyte with a result (§3.2, §4.4). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LabsScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadHealthOverview } from '@/lib/platform/health';

export const metadata = { title: 'Labs · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function LabsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadHealthOverview(getDb());

  return (
    <PageContainer title="Labs" description="Every analyte with a result, and the range printed beside it.">
      {overview.ok ? <LabsScreen analytes={overview.value.analytes} /> : <p>Could not load labs: {overview.error.message}</p>}
    </PageContainer>
  );
}

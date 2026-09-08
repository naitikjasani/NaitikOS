/** `/body/teeth/hygiene` — the shared routine engine's third consumer (§4.5, §9.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTeeth } from '@/lib/platform/teeth';
import { HygieneScreen } from '@/features/teeth';

export const metadata = { title: 'Dental hygiene · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function HygienePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadTeeth(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Hygiene" description="The routine, and how often it actually happens.">
      {overview.ok ? <HygieneScreen overview={overview.value} /> : <p>Could not load hygiene: {overview.error.message}</p>}
    </PageContainer>
  );
}

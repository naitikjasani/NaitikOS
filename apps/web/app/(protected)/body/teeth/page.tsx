/** `/body/teeth` — §3.2, §4.5. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTeeth } from '@/lib/platform/teeth';
import { TeethOverviewScreen } from '@/features/teeth';

export const metadata = { title: 'Teeth · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TeethPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadTeeth(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Teeth" description="What has been done, and am I protecting the work?">
      {overview.ok ? <TeethOverviewScreen overview={overview.value} /> : <p>Could not load Teeth: {overview.error.message}</p>}
    </PageContainer>
  );
}

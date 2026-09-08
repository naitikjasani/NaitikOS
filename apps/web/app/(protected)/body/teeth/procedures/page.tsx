/** `/body/teeth/procedures` — per-tooth history (§3.2, §4.5). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTeeth } from '@/lib/platform/teeth';
import { ProceduresScreen } from '@/features/teeth';

export const metadata = { title: 'Procedures · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ProceduresPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadTeeth(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Procedures"
      description="What has been done, per tooth — the record no practice keeps for you across a move."
    >
      {overview.ok ? (
        <ProceduresScreen overview={overview.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load procedures: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

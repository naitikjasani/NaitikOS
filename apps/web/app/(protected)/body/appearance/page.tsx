/** `/body/appearance` — §2.3's aggregate lens over skin, physique, grooming, hair. */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { AppearanceScreen } from '@/features/appearance';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadAppearance } from '@/lib/platform/appearance';

export const metadata = { title: 'Appearance · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function AppearancePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadAppearance(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Appearance"
      description="Skin and physique over the same ninety days. Two figures next to each other, and no number combining them."
    >
      {board.ok ?
        <AppearanceScreen board={board.value} />
      : <ErrorState title="Could not read the record" description={board.error.message} />}
    </PageContainer>
  );
}

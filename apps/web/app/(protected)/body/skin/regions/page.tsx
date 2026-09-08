/** `/body/skin/regions` — §4.2's three regions, each as its own series. */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { SkinRegionsScreen } from '@/features/skin';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadSkinRegions } from '@/lib/platform/skin';

export const metadata = { title: 'Skin regions · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function SkinRegionsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const toDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  const view = await loadSkinRegions(getDb(), { toDayKey });

  return (
    <PageContainer
      title="Regions"
      description="Face, chest and back as three separate lines — because they move independently, which is the whole reason they are recorded separately."
    >
      {view.ok ?
        <SkinRegionsScreen view={view.value} />
      : <ErrorState title="Could not read the skin log" description={view.error.message} />}
    </PageContainer>
  );
}

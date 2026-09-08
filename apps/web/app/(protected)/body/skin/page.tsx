/** `/body/skin` — the module overview (§3.2, §4.2). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { SkinOverviewScreen } from '@/features/skin';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Skin · Ekayu' };
export const dynamic = 'force-dynamic';

export default function SkinPage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer
      title="Skin"
      description="Is my skin improving, what is driving it, and what have I already tried?"
      width="wide"
    >
      <SkinOverviewScreen dayKey={today} />
    </PageContainer>
  );
}

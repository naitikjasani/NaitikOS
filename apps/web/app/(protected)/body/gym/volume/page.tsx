/** `/body/gym/volume` — volume and frequency by muscle group (§3.2, §4.1). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { VolumeScreen } from '@/features/gym';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Volume · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function VolumePage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer title="Volume" description="How much work, and where it went." width="wide">
      <VolumeScreen todayDayKey={today} zone={DEFAULT_PROFILE_ZONE} />
    </PageContainer>
  );
}

/**
 * `/body/composition` — bodyweight (§3.2, §4.6).
 *
 * §4.6's whole point in one screen: the seven-day trend is the number, and the
 * daily readings are the noise it is computed from.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { CompositionScreen } from '@/features/composition';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Composition · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function CompositionPage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer title="Composition" description="Bodyweight, and the trend that means something." width="wide">
      <CompositionScreen todayDayKey={today} />
    </PageContainer>
  );
}

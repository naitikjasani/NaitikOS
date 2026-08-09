/** `/body/gym/history` — past sessions (§3.2). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { SessionHistoryScreen } from '@/features/gym';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Session history · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function GymHistoryPage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer title="History" description="What you have done, and on which days." width="wide">
      <SessionHistoryScreen todayDayKey={today} />
    </PageContainer>
  );
}

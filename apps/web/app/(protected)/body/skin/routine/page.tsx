/** `/body/skin/routine` — AM/PM routine and adherence (§3.2, §4.2, §9.2). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { RoutineScreen } from '@/features/skin';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Routine · Ekayu' };
export const dynamic = 'force-dynamic';

export default function RoutinePage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer title="Routine" description="Tap a step to record it. It works offline." width="wide">
      <RoutineScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

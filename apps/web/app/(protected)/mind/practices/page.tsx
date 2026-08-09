/** `/mind/practices` — meditation, breathwork, grounding (§3.2, §4.7). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { PracticesScreen } from '@/features/mind';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Practices · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function PracticesPage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer title="Practices" description="Before and after is the only honest measure.">
      <PracticesScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

/** `/mind/anxiety` — episodes and triggers (§3.2, §4.7). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { AnxietyScreen } from '@/features/mind';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Anxiety · Ekayu' };
export const dynamic = 'force-dynamic';

export default function AnxietyPage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer
      title="Anxiety"
      description="One tap records it. Everything else is optional, now or later."
    >
      <AnxietyScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

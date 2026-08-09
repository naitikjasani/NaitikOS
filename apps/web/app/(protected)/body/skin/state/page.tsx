/** `/body/skin/state` — the daily log (§3.2, §4.2). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { SkinStateScreen } from '@/features/skin';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Skin log · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function SkinStatePage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer title="Skin log" description="One row per day. Saving again edits it.">
      <SkinStateScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

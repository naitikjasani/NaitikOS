/**
 * `/mind` — the pillar overview (§3.2).
 *
 * §7.5 keeps pillar overviews thin: this page owns no data. It resolves the day
 * in the operator's zone — §5.3, and the reason it happens here rather than in
 * the client is that a browser in a different zone must not silently re-file the
 * evening under tomorrow — and hands it to the feature.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { MindOverviewScreen } from '@/features/mind';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Mind · Ekayu' };
export const dynamic = 'force-dynamic';

export default function MindPage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer title="Mind" description="How am I actually doing, and what moves it?" width="wide">
      <MindOverviewScreen dayKey={today} zone={DEFAULT_PROFILE_ZONE} />
    </PageContainer>
  );
}

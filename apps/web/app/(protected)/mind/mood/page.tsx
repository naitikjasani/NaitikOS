/** `/mind/mood` — §3.2's "Mood & energy tracking", over a long window. */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { MoodScreen } from '@/features/mind';
import { requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Mood · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MoodPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  return (
    <PageContainer
      title="Mood and energy"
      description="Six months of both, with medication changes marked. The markers say when something changed, and nothing about what it did."
      width="wide"
    >
      <MoodScreen
        zone={DEFAULT_PROFILE_ZONE}
        toDayKey={dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE)}
      />
    </PageContainer>
  );
}

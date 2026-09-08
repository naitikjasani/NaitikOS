/** `/body/sleep` — §3.2, §4.6. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { SleepScreen } from '@/features/sleep';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadSleep } from '@/lib/platform/sleep';

export const metadata = { title: 'Sleep · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function SleepPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadSleep(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Sleep"
      description="Am I recovering? Duration, quality, timing, consistency and disturbances — and nothing about why."
    >
      {board.ok ? (
        <SleepScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load sleep: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

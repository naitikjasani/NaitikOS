/** `/work/focus` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { FocusScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadFocus } from '@/lib/platform/learning';

export const metadata = { title: 'Focus · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function FocusPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadFocus(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Focus"
      description="Deep-work sessions, and when in the day they actually happen."
    >
      {board.ok ? (
        <FocusScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load focus sessions: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

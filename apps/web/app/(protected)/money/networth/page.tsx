/** `/money/networth` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { NetWorthScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadNetWorth } from '@/lib/platform/money';

export const metadata = { title: 'Net worth · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function NetWorthPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadNetWorth(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Net worth"
      description="Built from balances that were read, never from balances that were computed."
    >
      {board.ok ? (
        <NetWorthScreen board={board.value} />
      ) : (
        <p>Could not load net worth: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

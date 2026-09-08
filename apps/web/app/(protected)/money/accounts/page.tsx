/** `/money/accounts` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { AccountsScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadAccounts } from '@/lib/platform/money';

export const metadata = { title: 'Accounts · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function AccountsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadAccounts(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Accounts"
      description="Named, not numbered. Each with the balance last read off it, and how long ago that was."
    >
      {board.ok ? (
        <AccountsScreen board={board.value} />
      ) : (
        <p>Could not load accounts: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

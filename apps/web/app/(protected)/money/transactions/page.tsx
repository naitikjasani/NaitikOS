/** `/money/transactions` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { TransactionsScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTransactions } from '@/lib/platform/money';

export const metadata = { title: 'Transactions · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function TransactionsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadTransactions(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Transactions"
      description="Import over entry (§4.9). Re-importing a statement is a no-op, not a double count."
    >
      {board.ok ? (
        <TransactionsScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load transactions: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

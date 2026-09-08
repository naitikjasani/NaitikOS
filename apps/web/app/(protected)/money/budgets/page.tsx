/** `/money/budgets` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { BudgetsScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadBudgets } from '@/lib/platform/money';

export const metadata = { title: 'Budgets · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function BudgetsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadBudgets(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Budgets"
      description="A budget owns no spending. What was spent is summed from transactions, every time."
    >
      {board.ok ? (
        <BudgetsScreen board={board.value} />
      ) : (
        <p>Could not load budgets: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

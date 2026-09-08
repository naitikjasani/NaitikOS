/** `/money/subscriptions` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { SubscriptionsScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadSubscriptions } from '@/lib/platform/money';

export const metadata = { title: 'Subscriptions · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function SubscriptionsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadSubscriptions(getDb());

  return (
    <PageContainer
      title="Subscriptions"
      description="Recurring commitments. The question is not what you pay for — it is what you have stopped noticing."
    >
      {board.ok ? (
        <SubscriptionsScreen board={board.value} />
      ) : (
        <p>Could not load subscriptions: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

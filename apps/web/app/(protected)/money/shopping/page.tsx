/** `/money/shopping` — §3.2, §4.9. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ShoppingScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadShopping } from '@/lib/platform/money';

export const metadata = { title: 'Shopping · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ShoppingPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadShopping(getDb());

  return (
    <PageContainer
      title="Shopping"
      description="A list and a purchase history, because they are one thing at two moments."
    >
      {board.ok ? (
        <ShoppingScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the shopping list: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

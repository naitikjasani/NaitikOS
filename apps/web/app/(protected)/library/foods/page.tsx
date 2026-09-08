/** `/library/foods` — canonical food definitions (§3.2, §4.3). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { FoodLibraryScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadFoodLibrary } from '@/lib/platform/library';

export const metadata = { title: 'Food library · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function FoodLibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadFoodLibrary(getDb());

  return (
    <PageContainer
      title="Foods"
      description="Every food the record knows about, and the basis its nutrition is stated per."
    >
      {board.ok ? (
        <FoodLibraryScreen board={board.value} />
      ) : (
        <p>Could not load the food library: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

/** `/body/nutrition/foods` — the food library (§4.3, §9.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadFoodLibrary } from '@/lib/platform/nutrition';
import { FoodLibraryScreen } from '@/features/nutrition';

export const metadata = { title: 'Foods · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function FoodLibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const foods = await loadFoodLibrary(getDb());

  return (
    <PageContainer title="Foods" description="Ordered by how often it is eaten, not alphabetically.">
      {foods.ok ? <FoodLibraryScreen foods={foods.value} /> : <p>Could not load the library: {foods.error.message}</p>}
    </PageContainer>
  );
}

/** `/body/nutrition/meals` — saved meals, the log's one-tap path (§4.3). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadFoodLibrary, loadTemplates } from '@/lib/platform/nutrition';
import { MealTemplatesScreen } from '@/features/nutrition';

export const metadata = { title: 'Saved meals · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MealTemplatesPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const db = getDb();
  const [templates, foods] = await Promise.all([loadTemplates(db), loadFoodLibrary(db)]);

  return (
    <PageContainer title="Saved meals" description="A saved meal stores foods, not versions — it means the oats as they are today.">
      {templates.ok && foods.ok ? (
        <MealTemplatesScreen templates={templates.value} foods={foods.value} />
      ) : (
        <p>Could not load saved meals.</p>
      )}
    </PageContainer>
  );
}

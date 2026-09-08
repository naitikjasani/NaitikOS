/** `/body/nutrition` — §3.2, §4.3. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadNutritionOverview } from '@/lib/platform/nutrition';
import { NutritionOverviewScreen } from '@/features/nutrition';

export const metadata = { title: 'Nutrition · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function NutritionPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadNutritionOverview(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Nutrition" description="How today is going, and what the protein is made of.">
      {overview.ok ? (
        <NutritionOverviewScreen overview={overview.value} />
      ) : (
        <p>Could not load Nutrition: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

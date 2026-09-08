/** `/body/nutrition/trends` — ninety days of macros (§8.9). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { NUTRITION_TREND_DAYS, loadNutritionTrends } from '@/lib/platform/nutrition';
import { TrendsScreen } from '@/features/nutrition';

export const metadata = { title: 'Nutrition trends · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function NutritionTrendsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const trends = await loadNutritionTrends(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Trends" description="Daily totals against the target that was in force on each day.">
      {trends.ok ? (
        <TrendsScreen series={trends.value.series} phase={trends.value.phase} windowDays={NUTRITION_TREND_DAYS} />
      ) : (
        <p>Could not load trends: {trends.error.message}</p>
      )}
    </PageContainer>
  );
}

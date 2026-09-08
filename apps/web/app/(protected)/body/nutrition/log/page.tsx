/**
 * `/body/nutrition/log` — the ten-second surface (§2.2, §4.3).
 *
 * `PageContainer` carries no description here on purpose. §2.2 gates this
 * module on how fast a meal can be logged, and a paragraph of prose above the
 * picker is a line of copy that costs a scroll on every meal, forever.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadLogSurface } from '@/lib/platform/nutrition';
import { MealLogScreen } from '@/features/nutrition';

export const metadata = { title: 'Log a meal · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MealLogPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:write');
  if (!authorized.ok) return null;

  const surface = await loadLogSurface(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Log a meal">
      {surface.ok ? (
        <MealLogScreen surface={surface.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the picker: {surface.error.message}</p>
      )}
    </PageContainer>
  );
}

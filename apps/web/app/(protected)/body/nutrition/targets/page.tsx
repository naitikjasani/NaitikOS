/** `/body/nutrition/targets` — what a day is measured against (§4.3, §4.10). */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadTargets } from '@/lib/platform/nutrition';
import { TargetsScreen } from '@/features/nutrition';

export const metadata = { title: 'Targets · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TargetsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const targets = await loadTargets(getDb());

  return (
    <PageContainer title="Targets" description="Time-bounded, so a bulk does not erase the cut that preceded it.">
      {targets.ok ? (
        <TargetsScreen targets={targets.value} todayIso={isoFromMillis(systemClock.nowMillis())} />
      ) : (
        <p>Could not load targets: {targets.error.message}</p>
      )}
    </PageContainer>
  );
}

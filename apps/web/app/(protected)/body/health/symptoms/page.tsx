/** `/body/health/symptoms` — the symptom log (§3.2, §4.4). */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { SymptomsScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { HEALTH_WINDOW_DAYS, createHealthRepository } from '@/lib/platform/health';

export const metadata = { title: 'Symptoms · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function SymptomsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const nowMillis = systemClock.nowMillis();
  const symptoms = await createHealthRepository(getDb()).symptomsBetween(
    isoFromMillis(nowMillis - HEALTH_WINDOW_DAYS * 86_400_000),
    isoFromMillis(nowMillis + 86_400_000),
  );

  return (
    <PageContainer title="Symptoms" description="What happened, how long it lasted, and what you suspected.">
      {symptoms.ok ? (
        <SymptomsScreen symptoms={symptoms.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the log: {symptoms.error.message}</p>
      )}
    </PageContainer>
  );
}

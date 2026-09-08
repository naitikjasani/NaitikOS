/** `/body/health/vitals` — capture and history (§3.2, §4.4). */

import type { ReactNode } from 'react';
import { isoFromMillis, pairReadings, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { VitalsScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { HEALTH_WINDOW_DAYS, createHealthRepository } from '@/lib/platform/health';

export const metadata = { title: 'Vitals · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function VitalsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const nowMillis = systemClock.nowMillis();
  const vitals = await createHealthRepository(getDb()).vitalsBetween(
    isoFromMillis(nowMillis - HEALTH_WINDOW_DAYS * 86_400_000),
    isoFromMillis(nowMillis + 86_400_000),
  );

  return (
    <PageContainer title="Vitals" description="Blood pressure, resting heart rate, temperature, oxygen saturation.">
      {vitals.ok ? (
        <VitalsScreen readings={pairReadings(vitals.value)} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load vitals: {vitals.error.message}</p>
      )}
    </PageContainer>
  );
}

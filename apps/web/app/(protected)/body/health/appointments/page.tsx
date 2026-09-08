/** `/body/health/appointments` — upcoming and past (§3.2, §4.4). */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { AppointmentsScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { createHealthRepository } from '@/lib/platform/health';

export const metadata = { title: 'Appointments · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function AppointmentsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const appointments = await createHealthRepository(getDb()).appointments();

  return (
    <PageContainer title="Appointments" description="What is coming, and the questions worth taking to it.">
      {appointments.ok ? (
        <AppointmentsScreen
          appointments={appointments.value}
          nowIso={isoFromMillis(systemClock.nowMillis())}
          zone={DEFAULT_PROFILE_ZONE}
        />
      ) : (
        <p>Could not load appointments: {appointments.error.message}</p>
      )}
    </PageContainer>
  );
}

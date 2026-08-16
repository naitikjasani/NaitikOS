/** `/body/teeth/appointments` — cadence, as a lens over Health's register (§4.5). */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { DentalAppointmentsScreen } from '@/features/teeth';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTeeth } from '@/lib/platform/teeth';

export const metadata = { title: 'Dental appointments · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function DentalAppointmentsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadTeeth(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Dental appointments" description="How long since the last one, and what is booked.">
      {overview.ok ? (
        <DentalAppointmentsScreen overview={overview.value} nowIso={isoFromMillis(systemClock.nowMillis())} />
      ) : (
        <p>Could not load appointments: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

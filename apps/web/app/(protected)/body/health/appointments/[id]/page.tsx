/**
 * `/body/health/appointments/:id` — the pre-visit question list.
 *
 * P5's deliverable: "a better question for your next appointment, printed and
 * ready". The derivation runs on the server at request time rather than being
 * cached, because it reads the record as it stands *now* — a result confirmed
 * ten minutes ago should be on the list.
 */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { AppointmentPrepScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadAppointmentPreparation } from '@/lib/platform/health';

export const metadata = { title: 'Preparing · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AppointmentPrepPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const preparation = await loadAppointmentPreparation(getDb(), id, DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Preparing" description="Questions your record suggests are worth asking.">
      {!preparation.ok ? (
        <p>Could not prepare: {preparation.error.message}</p>
      ) : preparation.value === null ? (
        <p>No such appointment.</p>
      ) : (
        <AppointmentPrepScreen preparation={preparation.value} nowIso={isoFromMillis(systemClock.nowMillis())} />
      )}
    </PageContainer>
  );
}

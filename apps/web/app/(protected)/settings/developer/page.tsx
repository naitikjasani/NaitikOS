/**
 * `/settings/developer` — §5.11's internal dashboard.
 *
 * > "A single internal dashboard at `/settings/developer` renders it."
 *
 * A Server Component that reads once and hands the whole report down. There is
 * no client query here on purpose: the dashboard is opened deliberately, rarely,
 * and by the maintainer — polling it would add exactly the kind of background
 * request that makes the counter-metric it displays worse.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { DeveloperScreen } from '@/features/validation';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadValidationReport } from '@/lib/platform/validation';

export const metadata = { title: 'Developer · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function DeveloperPage(): Promise<ReactNode> {
  /*
   * Authorized here as well as in the layout, per §5.4's single-authorization-
   * site-per-data-path rule. This page reads the observation log and the event
   * table; a Server Component that reads without asking is a second way in.
   */
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const zone = DEFAULT_PROFILE_ZONE;
  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const report = await loadValidationReport(getDb(), { todayDayKey, zone });

  return (
    <PageContainer
      title="Developer"
      description="The metrics that protect the metrics. §1.4, §5.11, and the V1 gate."
      width="wide"
    >
      {report.ok ? (
        <DeveloperScreen report={report.value} />
      ) : (
        /*
         * A plain sentence rather than an ErrorState: this page failing is a
         * maintenance signal, not something the operator needs recovering from.
         */
        <p>Telemetry is unavailable: {report.error.message}</p>
      )}
    </PageContainer>
  );
}

/**
 * `/body/health/medications` — the full medication register (§3.2, §4.4).
 *
 * The canonical route. §3.2 describes `/mind/meds` as "→ /body/health/
 * medications, filtered", and this is the thing it filters: every medication on
 * record, psychiatric first, rather than the two §4.7's lens shows.
 *
 * One component serves both, separated by a prop. §3.3(3)'s "one row, three
 * lenses" is the reason — two screens over one endpoint would drift on the
 * detail that matters most here, which is whether a day with no record counts
 * as a missed dose. It does not, and saying so once is the only way it stays
 * true on both pages.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { MedicationScreen } from '@/features/mind';
import { requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Medications · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MedicationsPage(): Promise<ReactNode> {
  /* `medical:read`. The full register is clinical — it holds every substance,
   * not the two §4.7 surfaces — and §5.4 splits the permissions so a narrower
   * grant reaches the lens and not this. */
  const authorized = await requireServerPermission('medical:read');
  if (!authorized.ok) return null;

  const now = isoFromMillis(systemClock.nowMillis());

  return (
    <PageContainer
      title="Medications"
      description="Every medication on record, with adherence shown beside the days that have no record either way."
    >
      <MedicationScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
        psychiatricOnly={false}
      />
    </PageContainer>
  );
}

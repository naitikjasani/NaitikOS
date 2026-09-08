/**
 * `/mind/meds` — the psychiatric medication lens (§3.2).
 *
 * §3.2 describes this route as "→ /body/health/medications, filtered". Health
 * core is V2, so the register has no full surface yet; this lens reads the same
 * rows through `?lens=psychiatric`. When Health ships, this page stays exactly
 * as it is — §3.3(3): "one row, three lenses."
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { MedicationScreen } from '@/features/mind';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Medication · Ekayu' };
export const dynamic = 'force-dynamic';

export default function MedsPage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer title="Medication" description="A lens over the register, not a second copy of it.">
      <MedicationScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

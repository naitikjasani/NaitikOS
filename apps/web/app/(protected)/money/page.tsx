/**
 * `/money` — the pillar overview (§3.2, §4.9).
 *
 * A set of doors, plus the two figures §3.2 asks the parent page to carry:
 * this month's spend by category and the net-worth line. §7.5's "thin
 * composition" — this page owns no data and no logic.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { MoneyOverviewScreen } from '@/features/money';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadMoneyOverview } from '@/lib/platform/money';

export const metadata = { title: 'Money · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MoneyPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadMoneyOverview(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Money"
      description="Where does it go, and is it aligned with what I want?"
    >
      {overview.ok ? (
        <MoneyOverviewScreen overview={overview.value} />
      ) : (
        <p>Could not load money: {overview.error.message}</p>
      )}
    </PageContainer>
  );
}

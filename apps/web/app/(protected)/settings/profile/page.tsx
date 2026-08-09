/**
 * `/settings/profile` — §3.2's "Identity, demographics, clinical context".
 *
 * Only the crisis plan today. It lives here rather than under `/mind` because
 * §4.7 requires the plan to be written *when well*, and a form on `/mind` would
 * be met on the days Mind is opened — disproportionately the days it should not
 * be met. `/mind` surfaces an invitation instead, on a settled stretch, and the
 * invitation and the form are in different places on purpose.
 */

import type { ReactNode } from 'react';
import { createMindRepository } from '@naitikos/db';

import { PageContainer } from '@/components/shell';
import { CrisisPlanScreen } from '@/features/registers';
import { getDb, requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Profile · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ProfilePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  const plan = await createMindRepository(getDb()).activeCrisisPlan();

  return (
    <PageContainer title="Crisis plan" description="Written when well, shown back when it is needed.">
      <CrisisPlanScreen initial={plan.ok ? plan.value : null} />
    </PageContainer>
  );
}

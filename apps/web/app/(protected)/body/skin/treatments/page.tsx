/** `/body/skin/treatments` — treatment courses and the cumulative dose. */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { TreatmentsScreen } from '@/features/skin';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadTreatments } from '@/lib/platform/treatments';

export const metadata = { title: 'Treatments · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TreatmentsPage(): Promise<ReactNode> {
  /* `medical:read`, not `observation:read`. A treatment course is clinical, and
   * §5.4 splits the two so a narrower grant cannot reach it. */
  const authorized = await requireServerPermission('medical:read');
  if (!authorized.ok) return null;

  const board = await loadTreatments(getDb());

  return (
    <PageContainer
      title="Treatments"
      description="Courses run, and how much has been taken across all of them. The total, not a dose per kilogram and not a figure measured against a threshold."
    >
      {board.ok ?
        <TreatmentsScreen board={board.value} />
      : <ErrorState title="Could not read the treatment record" description={board.error.message} />}
    </PageContainer>
  );
}

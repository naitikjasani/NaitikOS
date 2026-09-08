/** `/body/health/medications/:id` — §3.2's "medication detail + adherence + side effects". */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { MedicationDetailScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadMedicationDetail } from '@/lib/platform/medication';

export const metadata = { title: 'Medication · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function MedicationDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  /* `medical:read`, as the register itself. §5.4 splits the permissions by
   * blast radius and this page is strictly more revealing than the list: it
   * adds the dose history and the side effects suspected of it. */
  const authorized = await requireServerPermission('medical:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadMedicationDetail(getDb(), id, DEFAULT_PROFILE_ZONE);

  if (!detail.ok) {
    return (
      <PageContainer title="Medication">
        <ErrorState title="Could not read the medication" description={detail.error.message} />
      </PageContainer>
    );
  }

  /* An unknown or soft-deleted id is a 404. §9.4 keeps deleted rows; refusing
   * to render one is a statement about what may be read, not a fault. */
  if (detail.value === null) notFound();

  return (
    <PageContainer
      title={detail.value.label}
      description="How the dose got to where it is, what was recorded over the last quarter, and what you suspected it of."
    >
      <MedicationDetailScreen detail={detail.value} />
    </PageContainer>
  );
}

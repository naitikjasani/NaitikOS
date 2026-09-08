/** `/body/health/conditions` — the register (§3.2, §4.4, §9.5). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ConditionsScreen } from '@/features/health';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { createHealthRepository } from '@/lib/platform/health';

export const metadata = { title: 'Conditions · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ConditionsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const conditions = await createHealthRepository(getDb()).conditions();

  return (
    <PageContainer
      title="Conditions"
      description="What you have been diagnosed with, when it began, and when you found out."
    >
      {conditions.ok ? (
        <ConditionsScreen conditions={conditions.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the register: {conditions.error.message}</p>
      )}
    </PageContainer>
  );
}

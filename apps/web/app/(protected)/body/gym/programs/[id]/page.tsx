/** `/body/gym/programs/:id` — the blocks, the cycle, and how the fortnight went. */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { ProgramDetailScreen } from '@/features/gym';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadProgram } from '@/lib/platform/programs';

export const metadata = { title: 'Program · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ProgramPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadProgram(getDb(), DEFAULT_PROFILE_ZONE, id);

  if (!detail.ok) {
    return (
      <PageContainer title="Program">
        <ErrorState title="Could not read the program" description={detail.error.message} />
      </PageContainer>
    );
  }

  if (detail.value === null) notFound();

  return (
    <PageContainer
      title={detail.value.program.name}
      description="Blocks cycle in order. The session logger offers whichever comes next."
    >
      <ProgramDetailScreen detail={detail.value} />
    </PageContainer>
  );
}

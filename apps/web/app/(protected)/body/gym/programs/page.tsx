/** `/body/gym/programs` — §4.1's program definition and adherence. */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { ProgramsScreen } from '@/features/gym';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadPrograms } from '@/lib/platform/programs';

export const metadata = { title: 'Programs · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ProgramsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadPrograms(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Programs"
      description="A plan your training is measured against — never a schedule that decides you missed something."
    >
      {board.ok ?
        <ProgramsScreen board={board.value} />
      : <ErrorState title="Could not read the programs" description={board.error.message} />}
    </PageContainer>
  );
}

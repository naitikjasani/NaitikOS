/** `/life/people` — §3.2's "People & relationships". */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { PeopleScreen } from '@/features/social';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadPeople } from '@/lib/platform/social';

export const metadata = { title: 'People · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function PeoplePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadPeople(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="People"
      description="Who have I not spoken to. Measured against a rhythm you set, and nothing else."
    >
      {board.ok ?
        <PeopleScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      : <ErrorState title="Could not read the record" description={board.error.message} />}
    </PageContainer>
  );
}

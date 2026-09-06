/** `/life/places` — §3.2's "Places & travel". */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { PlacesScreen } from '@/features/social';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadPlaces } from '@/lib/platform/social';

export const metadata = { title: 'Places · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function PlacesPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadPlaces(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Places"
      description="Where you were, and for how long — the record that stops a fortnight abroad reading as a finding."
    >
      {board.ok ?
        <PlacesScreen board={board.value} />
      : <ErrorState title="Could not read the record" description={board.error.message} />}
    </PageContainer>
  );
}

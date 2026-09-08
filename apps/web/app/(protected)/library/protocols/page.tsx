/** `/library/protocols` — personal protocols and SOPs (§3.2, §9.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ProtocolLibraryScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadProtocolLibrary } from '@/lib/platform/library';

export const metadata = { title: 'Protocols · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ProtocolLibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadProtocolLibrary(getDb());

  return (
    <PageContainer
      title="Protocols"
      description="The routine engine's definitions, read as documents. Skincare, dental hygiene and supplements all run on the same one."
    >
      {board.ok ? (
        <ProtocolLibraryScreen board={board.value} />
      ) : (
        <p>Could not load the protocols: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

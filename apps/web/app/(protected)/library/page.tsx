/** `/library` — the pillar overview (§3.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LibraryOverviewScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadLibraryOverview } from '@/lib/platform/library';

export const metadata = { title: 'Library · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function LibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadLibraryOverview(getDb());

  return (
    <PageContainer
      title="Library"
      description="Reference data. The vocabulary the record is written in — not a new domain, a place to read the ones that already exist."
    >
      {board.ok ? (
        <LibraryOverviewScreen board={board.value} />
      ) : (
        <p>Could not load the library: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

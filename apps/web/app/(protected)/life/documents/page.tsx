/** `/life/documents` — the vault (§3.2, §4.11). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { VaultScreen } from '@/features/documents';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { listDocuments } from '@/lib/platform/documents';

export const metadata = { title: 'Documents · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function DocumentsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const documents = await listDocuments(getDb());

  return (
    <PageContainer title="Documents" description="Where the paperwork is, and what it says.">
      {documents.ok ? (
        <VaultScreen documents={documents.value} />
      ) : (
        <p>Could not load the vault: {documents.error.message}</p>
      )}
    </PageContainer>
  );
}

/** `/library/products` — the skincare and supplement register (§3.2, §4.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ProductLibraryScreen } from '@/features/library';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadProductLibrary } from '@/lib/platform/library';

export const metadata = { title: 'Products · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ProductLibraryPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadProductLibrary(getDb());

  return (
    <PageContainer
      title="Products"
      description="What is registered, what is in the routine, and how long each has been there. Read-only."
    >
      {board.ok ? (
        <ProductLibraryScreen board={board.value} />
      ) : (
        <p>Could not load the product register: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

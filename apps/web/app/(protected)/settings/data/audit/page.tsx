/** `/settings/data/audit` — §9.4's permanent log. */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { AuditScreen } from '@/features/settings';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadAudit } from '@/lib/platform/audit';

export const metadata = { title: 'Audit log · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function AuditPage(): Promise<ReactNode> {
  /* `audit:read`. §5.4 gives the log its own permission because it names every
   * entity that has ever been touched, which is a wider read than any single
   * domain surface. */
  const authorized = await requireServerPermission('audit:read');
  if (!authorized.ok) return null;

  const board = await loadAudit(getDb());

  return (
    <PageContainer
      title="Audit log"
      description="Every deletion, revision and restore. Kept forever, and nothing can amend it."
    >
      {board.ok ?
        <AuditScreen board={board.value} />
      : <ErrorState title="Could not read the log" description={board.error.message} />}
    </PageContainer>
  );
}

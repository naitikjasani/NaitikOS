/** `/settings/data/export` — §9.10's export builder. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ExportBuilderScreen } from '@/features/settings';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Export · Ekayu' };

export default async function ExportPage(): Promise<ReactNode> {
  /* `export:execute`, not `settings:read`. Building an archive of the whole
   * record is the widest read in the system, and §5.4 gives it its own
   * permission for that reason. */
  const authorized = await requireServerPermission('export:execute');
  if (!authorized.ok) return null;

  return (
    <PageContainer
      title="Export"
      description="Everything, as files a person can read without this application. P2 makes the record yours; this is what makes that true rather than stated."
    >
      <ExportBuilderScreen />
    </PageContainer>
  );
}

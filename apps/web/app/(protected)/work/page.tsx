/** `/work` — the pillar overview (§3.2, §4.8). */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { WorkOverviewScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadWorkOverview } from '@/lib/platform/work';

export const metadata = { title: 'Work · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function WorkPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const overview = await loadWorkOverview(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Work"
      description="Am I building the career I want, and what does it cost me?"
    >
      {overview.ok ? (
        <WorkOverviewScreen overview={overview.value} />
      ) : (
        /*
          A designed failure, not a bare paragraph with a `DomainError.message`
          printed into it — which is what was here, and which `core`'s own
          definition of that field forbids: "`message` is developer-facing and
          appears in logs", never on a screen. §5.12 sets the tone the operator
          gets instead: the record is intact and nothing has been lost.
        */
        <ErrorState
          title="Could not load Work"
          description="Nothing is lost — this is a read that failed, not a record that did. Reloading usually resolves it."
        />
      )}
    </PageContainer>
  );
}

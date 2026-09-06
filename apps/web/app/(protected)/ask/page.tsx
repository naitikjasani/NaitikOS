/** `/ask` — §4.13, §2.5. Deliberately not the primary interface. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadThreads } from '@/lib/platform/enquiry';
import { AskScreen, ThreadListScreen } from '@/features/ask';

export const metadata = { title: 'Ask · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AskPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  /*
   * The thread list is server-rendered above the (client) Ask box. It has data
   * before the operator does anything, which is this codebase's rule for which
   * side a surface belongs on; the box does not, which is why it stays a client
   * component.
   */
  const board = await loadThreads(getDb());

  return (
    <PageContainer
      title="Ask"
      description="For the question you cannot express as a filter. One question at a time, answered from your own records."
    >
      {board.ok && <ThreadListScreen board={board.value} />}
      <AskScreen />
    </PageContainer>
  );
}

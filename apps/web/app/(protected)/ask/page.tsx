/** `/ask` — §4.13, §2.5. Deliberately not the primary interface. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';
import { AskScreen } from '@/features/ask';

export const metadata = { title: 'Ask · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AskPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  return (
    <PageContainer
      title="Ask"
      description="For the question you cannot express as a filter. One question at a time, answered from your own records."
    >
      <AskScreen />
    </PageContainer>
  );
}

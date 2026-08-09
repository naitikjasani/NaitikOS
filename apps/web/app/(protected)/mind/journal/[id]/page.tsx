/**
 * `/mind/journal/:id` — one entry.
 *
 * The only route that renders journal prose. `dynamic = 'force-dynamic'` and the
 * route handler's `Cache-Control: no-store` between them keep it out of every
 * cache, which is the point.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { JournalEntryScreen } from '@/features/mind';

export const metadata = { title: 'Entry · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function JournalEntryPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  return (
    <PageContainer title="Entry">
      <JournalEntryScreen entryId={id} />
    </PageContainer>
  );
}

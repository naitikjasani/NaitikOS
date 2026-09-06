/**
 * `/mind/journal/:id` — one entry.
 *
 * The only route that renders journal prose. `dynamic = 'force-dynamic'` and the
 * route handler's `Cache-Control: no-store` between them keep it out of every
 * cache, which is the point.
 *
 * `journal:read`, which a clinician holding a shared export deliberately does
 * not have (`core/auth/roles.ts`). The API this screen fetches from is the real
 * enforcement — the guard here is the second one, so a reader without the
 * permission gets nothing rather than a page shell that fails a fetch.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { JournalEntryScreen } from '@/features/mind';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Entry · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function JournalEntryPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('journal:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  return (
    <PageContainer title="Entry">
      <JournalEntryScreen entryId={id} />
    </PageContainer>
  );
}

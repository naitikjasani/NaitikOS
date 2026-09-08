/** `/life/documents/:id` — the document, and the results it proposes (§4.11). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { DocumentReviewScreen } from '@/features/documents';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadDocument } from '@/lib/platform/documents';

export const metadata = { title: 'Document · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function DocumentPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadDocument(getDb(), id);

  return (
    <PageContainer
      title="Document"
      description="Check each value against the report. Nothing is recorded until you confirm it."
    >
      {!detail.ok ? (
        <p>Could not load it: {detail.error.message}</p>
      ) : detail.value === null ? (
        <p>No such document.</p>
      ) : (
        <DocumentReviewScreen detail={detail.value} zone={DEFAULT_PROFILE_ZONE} />
      )}
    </PageContainer>
  );
}

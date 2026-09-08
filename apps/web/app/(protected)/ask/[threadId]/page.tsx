/** `/ask/:threadId` — §3.2's "a saved line of enquiry". */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { ThreadScreen } from '@/features/ask';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadThread } from '@/lib/platform/enquiry';

export const metadata = { title: 'Enquiry · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ThreadPage({
  params,
}: {
  readonly params: Promise<{ readonly threadId: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { threadId } = await params;
  const detail = await loadThread(getDb(), threadId);

  if (!detail.ok) {
    return (
      <PageContainer title="Enquiry">
        <ErrorState title="Could not read the thread" description={detail.error.message} />
      </PageContainer>
    );
  }

  /* A deleted or unknown thread is a 404, not an empty page. §8.9's rule about
   * showing missing data as missing does not extend to inventing a container
   * for something that is not there. */
  if (detail.value === null) notFound();

  return (
    <PageContainer
      title={detail.value.thread.title}
      description="Each question here is answered from your record alone. Nothing said earlier is sent back to the model."
    >
      <ThreadScreen detail={detail.value} />
    </PageContainer>
  );
}

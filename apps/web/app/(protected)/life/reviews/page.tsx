/** `/life/reviews` — §3.2, §4.12. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ReviewsScreen } from '@/features/reviews';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadReviews } from '@/lib/platform/reviews';

export const metadata = { title: 'Reviews · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ReviewsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadReviews(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Reviews"
      description="What actually happened, drafted from the record. The draft is the labour saved; the editing is the point."
    >
      {board.ok ? (
        <ReviewsScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load reviews: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

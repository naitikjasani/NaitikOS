/**
 * `/life/reviews/:id` — §3.2, §4.12.
 *
 * The draft is reassembled from the record on every load rather than read back
 * from `draft_content` alone. §4.12 makes the edit the valuable half, so the
 * two are shown against each other: a draft that has drifted from what the
 * record now says is exactly the thing worth noticing before a review is
 * marked complete.
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { PageContainer } from '@/components/shell';
import { ReviewDetailScreen } from '@/features/reviews';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadReview } from '@/lib/platform/reviews';

export const metadata = { title: 'Review · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadReview(getDb(), id, DEFAULT_PROFILE_ZONE);

  if (!detail.ok) {
    return (
      <PageContainer title="Review">
        <p>Could not load that review: {detail.error.message}</p>
      </PageContainer>
    );
  }

  if (detail.value === null) notFound();

  return (
    <PageContainer
      title={detail.value.period?.label ?? 'Review'}
      description="Edit it. A review you did not edit is a review you did not do."
    >
      <ReviewDetailScreen detail={detail.value} />
    </PageContainer>
  );
}

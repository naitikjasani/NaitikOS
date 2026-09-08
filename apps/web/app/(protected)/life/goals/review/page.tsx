/** `/life/goals/review` — the review ritual (§3.2, §4.10). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { GoalReviewScreen } from '@/features/goals';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadGoalReview } from '@/lib/platform/goals';

export const metadata = { title: 'Goal review · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function GoalReviewPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const review = await loadGoalReview(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer title="Review" description="What has changed since you last looked, and what that does not tell you.">
      {review.ok ? <GoalReviewScreen review={review.value} /> : <p>Could not load the review: {review.error.message}</p>}
    </PageContainer>
  );
}

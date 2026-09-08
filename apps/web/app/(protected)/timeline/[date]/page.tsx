/** `/timeline/:date` — §3.2's "a single day, fully expanded". */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { TimelineDayScreen } from '@/features/timeline';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadTimelineDay } from '@/lib/platform/timeline-day';

export const metadata = { title: 'Day · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TimelineDayPage({
  params,
}: {
  readonly params: Promise<{ readonly date: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { date } = await params;
  const day = await loadTimelineDay(getDb(), date, DEFAULT_PROFILE_ZONE);

  if (!day.ok) {
    return (
      <PageContainer title="Day">
        <ErrorState title="Could not read the day" description={day.error.message} />
      </PageContainer>
    );
  }

  /* An unreadable date is a 404, not an error page. `/timeline/yesterday` is a
   * thing a person types, and "that is not a date" is the honest answer where a
   * 500 would say the system broke. */
  if (day.value === null) notFound();

  return (
    <PageContainer
      title={date}
      description="Everything recorded on this day, including the detail the main timeline collapses."
    >
      <TimelineDayScreen day={day.value} />
    </PageContainer>
  );
}

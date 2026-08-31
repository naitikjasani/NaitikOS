/** `/timeline/medical` — §3.2, §10.7, §9.5. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadMedicalTimeline } from '@/lib/platform/medical-timeline';
import { MedicalTimelineScreen } from '@/features/timeline';

export const metadata = { title: 'Medical timeline · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function MedicalTimelinePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('medical:read');
  if (!authorized.ok) return null;

  const params = await searchParams;
  const raw = params['asOf'];
  const asOfIso = typeof raw === 'string' && raw !== '' ? raw : undefined;

  const timeline = await loadMedicalTimeline(getDb(), asOfIso === undefined ? {} : { asOfIso });

  return (
    <PageContainer
      title="Medical timeline"
      description="Every clinical fact on one axis, and a date control that shows what the record said at the time."
    >
      {timeline.ok ? (
        <MedicalTimelineScreen timeline={timeline.value} />
      ) : (
        <p>Could not load the timeline: {timeline.error.message}</p>
      )}
    </PageContainer>
  );
}

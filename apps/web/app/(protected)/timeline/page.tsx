/**
 * `/timeline` — the chronological record (§3.2).
 *
 * Read-only, and read-only is the design rather than a stage: §9.1's log is
 * append-only and the database trigger enforces it, so an editable timeline
 * would be a write path that cannot exist.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { TimelineList } from '@/features/timeline';

export const metadata = { title: 'Timeline · Ekayu' };
export const dynamic = 'force-dynamic';

export default function TimelinePage(): ReactNode {
  return (
    <PageContainer
      title="Timeline"
      description="Everything recorded, in order. Entries appear here as domains are added — no timeline code changes when they do."
    >
      <TimelineList />
    </PageContainer>
  );
}

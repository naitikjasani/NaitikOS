/**
 * `/timeline/life` — §3.2, §10.8.
 *
 * §3.2 writes the timeline as `/timeline?scale=day|week|month|year|life`. The
 * `life` end of that range reads different tables from the other four — three
 * hand-authored ones rather than the domain event projection — so it is its own
 * route rather than a branch inside the existing screen. The scale control here
 * covers the zoomed-out half of that parameter.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { LifeTimelineScreen } from '@/features/timeline';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadLifeTimeline } from '@/lib/platform/life-timeline';
import { isTimelineScale, type TimelineScale } from '@naitikos/core';

export const metadata = { title: 'Life timeline · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function LifeTimelinePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const params = await searchParams;
  const raw = params['scale'];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  /* `decade` rather than `life` by default. `life` is the honest whole-record
   * view and is almost empty for years; a decade is wide enough to be a shape
   * and narrow enough to have something in it. */
  const scale: TimelineScale =
    typeof candidate === 'string' && isTimelineScale(candidate) ? candidate : 'decade';

  const timeline = await loadLifeTimeline(getDb(), scale);

  return (
    <PageContainer
      title="Life timeline"
      description="Eras, chapters and the handful of things you would name if asked what happened."
    >
      {timeline.ok ? (
        <LifeTimelineScreen timeline={timeline.value} scale={scale} />
      ) : (
        <p>Could not load the timeline: {timeline.error.message}</p>
      )}
    </PageContainer>
  );
}

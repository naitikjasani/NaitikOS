/**
 * `/body/skin/photos/compare` — §3.2's side-by-side (§4.2, §9.8).
 *
 * `media:read` rather than `observation:read`. The rest of Skin reads the daily
 * log; this route reads the media table, and §5.4's matrix separates the two
 * because a scope that opens the record should not also open the photographs of
 * it.
 *
 * The zone is resolved here and passed to the loader, which uses it only as the
 * fallback for a photo that recorded no zone of its own. §5.3: the day a photo
 * belongs to is a question about where it was taken, not about where it is being
 * read.
 */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { PhotoCompareScreen } from '@/features/skin';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadPhotoComparison } from '@/lib/platform/skin';

export const metadata = { title: 'Compare photos · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function PhotoComparePage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('media:read');
  if (!authorized.ok) return null;

  const view = await loadPhotoComparison(getDb(), { zone: DEFAULT_PROFILE_ZONE });

  return (
    <PageContainer
      title="Compare"
      description="Two photos from one series, with how each was taken stated next to it. If they were taken differently, that is the finding — not whatever you think you can see."
    >
      {view.ok ?
        <PhotoCompareScreen view={view.value} />
      : <ErrorState title="Could not read the photo series" description={view.error.message} />}
    </PageContainer>
  );
}

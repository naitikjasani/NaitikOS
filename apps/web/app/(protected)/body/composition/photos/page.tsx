/**
 * `/body/composition/photos` — the physique progress gallery (§3.2, §4.6).
 *
 * Server-rendered, and the reason is not performance. §5.5 encrypts these
 * objects on the device, so there are no pixels for a client component to
 * fetch; everything this page can say is metadata, and metadata is best read
 * from the database on the server. The one control — §9.8's non-compliant
 * toggle — is a search parameter rather than state, which keeps it that way.
 *
 * The profile zone is passed as a *fallback* only. Each photograph is filed
 * under the day it was captured in, from its own `captured_zone` (§5.3); this
 * value is what a row with no recorded zone falls back to, and travelling
 * should not re-file six months of mornings.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { PhysiqueGalleryScreen } from '@/features/composition';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadPhysiqueGallery } from '@/lib/platform/physique';

export const metadata = { title: 'Physique photos · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function PhysiquePhotosPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('media:read');
  if (!authorized.ok) return null;

  const params = await searchParams;
  const raw = params['include'];
  const include = Array.isArray(raw) ? raw[0] : raw;

  const gallery = await loadPhysiqueGallery(getDb(), {
    zone: DEFAULT_PROFILE_ZONE,
    includeNonCompliant: include === 'all',
  });

  return (
    <PageContainer
      title="Physique photos"
      description="What the record knows about each photograph — and, honestly, what it cannot show you."
      width="wide"
    >
      {gallery.ok ? (
        <PhysiqueGalleryScreen gallery={gallery.value} />
      ) : (
        <p>Could not load the gallery: {gallery.error.message}</p>
      )}
    </PageContainer>
  );
}

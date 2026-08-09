/**
 * `/body/skin/photos` — the capture protocol (§3.2, §4.2, §9.8).
 *
 * The local *time* is resolved here, server-side, and passed down. The capture
 * screen needs it for the time-of-day bucket, and a browser clock in a different
 * zone would file an 08:00 photo as an evening one — the §5.3 bug arriving
 * through a protocol check.
 */

import type { ReactNode } from 'react';
import { systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { PhotoCaptureScreen } from '@/features/skin';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Photos · NaitikOS' };
export const dynamic = 'force-dynamic';

/**
 * Wall-clock `HH:MM` in a named zone.
 *
 * `Intl` rather than arithmetic on a `Date`. §11.3 bans a raw `Date` outside
 * `core/temporal` because hand-rolled zone maths is how an off-by-one-hour bug
 * gets into a record that outlives the code — and resolving a wall-clock time in
 * a named zone is exactly the case `Intl` exists for. The millisecond value
 * still comes from the sanctioned clock.
 */
function localTimeIn(zone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(systemClock.nowMillis());
}

export default function PhotosPage(): ReactNode {
  return (
    <PageContainer
      title="Progress photo"
      description="The overlay does more for consistency than any setting on this page."
    >
      <PhotoCaptureScreen localTime={localTimeIn(DEFAULT_PROFILE_ZONE)} />
    </PageContainer>
  );
}

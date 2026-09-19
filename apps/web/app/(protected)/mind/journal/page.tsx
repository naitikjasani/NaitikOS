/**
 * `/mind/journal` — the journal (§3.2, §4.7).
 *
 * `width="reading"` rather than the default page width. §8.3 gives long-form its
 * own family for a reason, and a serif textarea stretched to 64rem undoes the
 * cue it was set in: a 120-character line is hard to write into and harder to
 * read back. Capping the measure is the other half of the mode-switch.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { JournalScreen } from '@/features/mind';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Journal · Ekayu' };
export const dynamic = 'force-dynamic';

export default function JournalPage(): ReactNode {
  const now = isoFromMillis(systemClock.nowMillis());
  return (
    <PageContainer
      title="Journal"
      description="Nothing here is ever sent to a model."
      width="reading"
    >
      <JournalScreen
        dayKey={dayKeyInZone(now, DEFAULT_PROFILE_ZONE)}
        zone={DEFAULT_PROFILE_ZONE}
        nowIso={now}
      />
    </PageContainer>
  );
}

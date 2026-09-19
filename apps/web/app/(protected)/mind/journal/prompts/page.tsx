/** `/mind/journal/prompts` — §3.2's guided prompts. */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, shiftDayKey, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { PromptsScreen } from '@/features/mind';
import { requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Prompts · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function PromptsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const toDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Prompts"
      description="Ways in, when the page is blank. Nothing tracks which you have answered — an unanswered prompt is not owed."
      /* Long-form measure (§8.3): the prompts are set in the serif and read as
         sentences, not as rows. */
      width="reading"
    >
      <PromptsScreen
        zone={DEFAULT_PROFILE_ZONE}
        /* A short window: this page reads the prompt library, not the record,
         * and the overview's other work should be as small as it can be. */
        fromDayKey={shiftDayKey(toDayKey, -6) ?? toDayKey}
        toDayKey={toDayKey}
      />
    </PageContainer>
  );
}

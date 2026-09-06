/** `/insights` — §3.2's V2 inbox, §10.6's surface. */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadInsightInbox, loadInsights } from '@/lib/platform/insights';
import { InsightInboxScreen } from '@/features/insights';

export const metadata = { title: 'Insights · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function InsightInboxPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const db = getDb();
  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);

  /*
   * Two reads, and they answer different questions. The inbox is what was
   * surfaced and not yet dealt with; the battery run supplies the baseline
   * message and tonight's comparison count, both of which are context about the
   * *bar* rather than about any one finding.
   */
  const [inbox, outcome] = await Promise.all([
    loadInsightInbox(db),
    loadInsights(db, { toDayKey: todayDayKey, zone: DEFAULT_PROFILE_ZONE }),
  ]);

  return (
    <PageContainer
      title="Insights"
      description="Findings that survived a minimum sample size, a correction across the whole night's tests, a registered hypothesis, and a second independent window."
    >
      {inbox.ok && outcome.ok ? (
        <InsightInboxScreen
          insights={inbox.value}
          baselineMessage={outcome.value.baseline.message}
          comparisons={outcome.value.comparisons}
        />
      ) : (
        <p>Could not load insights.</p>
      )}
    </PageContainer>
  );
}

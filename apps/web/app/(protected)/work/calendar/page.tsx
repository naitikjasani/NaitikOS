/** `/work/calendar` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { CalendarScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadCalendar } from '@/lib/platform/learning';

export const metadata = { title: 'Calendar · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function CalendarPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadCalendar(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="Calendar"
      description="The load, travel and meeting density that explains a bad week in every other domain."
    >
      {board.ok ? (
        <CalendarScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the calendar: {board.error.message}</p>
      )}
    </PageContainer>
  );
}

/**
 * `/settings/notifications` — §3.2, §4.0.
 *
 * §3.2 writes this route as "Reminders — opt-in only", and the honest state of
 * it is that nothing is sent. The page says so rather than rendering controls
 * that change no behaviour: a toggle wired to nothing teaches the operator that
 * the interface lies, and that is a more expensive thing to lose than a feature.
 *
 * The stored preference block is shown because it is real — it is in `setting`
 * and it is what a delivery path will read on the day one exists.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadNotificationPreferences } from '@/lib/platform/settings';
import { NotificationsSettingsScreen } from '@/features/settings';

export const metadata = { title: 'Notifications · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function NotificationsSettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  const stored = await loadNotificationPreferences(getDb());

  return (
    <PageContainer
      title="Notifications"
      description="Opt-in only, and currently silent. What is stored, and what would have to exist before anything arrives."
    >
      {stored.ok ? (
        <NotificationsSettingsScreen stored={stored.value} />
      ) : (
        <p>Could not load notification preferences: {stored.error.message}</p>
      )}
    </PageContainer>
  );
}

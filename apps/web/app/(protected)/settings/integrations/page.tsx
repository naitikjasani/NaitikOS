/** `/settings/integrations` — §3.2. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';
import { IntegrationsSettingsScreen } from '@/features/settings';

export const metadata = { title: 'Integrations · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function IntegrationsSettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  return (
    <PageContainer title="Integrations" description="What can be imported, from where, and what still has to be typed.">
      <IntegrationsSettingsScreen />
    </PageContainer>
  );
}

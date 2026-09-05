/** `/settings/appearance` — §3.2. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';
import { AppearanceSettingsScreen } from '@/features/settings';

export const metadata = { title: 'Appearance · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AppearanceSettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  return (
    <PageContainer title="Appearance" description="Theme, density and motion — and an honest account of which of the three this application actually acts on.">
      <AppearanceSettingsScreen />
    </PageContainer>
  );
}

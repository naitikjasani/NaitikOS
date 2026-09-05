/** `/settings/capture` — §3.2. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';
import { CaptureSettingsScreen } from '@/features/settings';

export const metadata = { title: 'Capture · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function CaptureSettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  return (
    <PageContainer title="Capture" description="What the quick-capture rail offers, and the keyboard shortcuts that reach it.">
      <CaptureSettingsScreen />
    </PageContainer>
  );
}

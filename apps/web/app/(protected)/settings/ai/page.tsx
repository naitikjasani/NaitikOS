/**
 * `/settings/ai` — §3.2, §10.10, §7.
 *
 * The page §10.10 requires the consent scopes to be revocable from, and where
 * §7's kill switch lives: "a single flag in `/settings/ai`, and the acceptance
 * test for the flag is that the whole product still works with it off."
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadAiSettings } from '@/lib/platform/settings';
import { AiSettingsScreen } from '@/features/settings';

export const metadata = { title: 'AI · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function AiSettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:write');
  if (!authorized.ok) return null;

  const settings = await loadAiSettings(getDb(), DEFAULT_PROFILE_ZONE);

  return (
    <PageContainer
      title="AI"
      description="What may be sent, how much may be spent, and a switch that turns all of it off."
    >
      {settings.ok ? (
        <AiSettingsScreen settings={settings.value} />
      ) : (
        <p>Could not load AI settings: {settings.error.message}</p>
      )}
    </PageContainer>
  );
}

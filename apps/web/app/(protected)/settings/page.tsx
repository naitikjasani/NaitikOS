/**
 * `/settings` — the index.
 *
 * There is a settings *drawer* reachable from anywhere, and this page is not a
 * second copy of it. The drawer holds the three controls that take effect
 * instantly and are worth changing without leaving what you are doing — theme,
 * density, motion. This page is the map: every settings surface, with a line
 * saying what it decides.
 *
 * §3.3 R6's logic applied to a settings index: a surface that repeats a working
 * one is worse than a link to it. So nothing here is interactive.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Settings · Ekayu' };

const SECTIONS = [
  {
    href: '/settings/profile',
    title: 'Profile',
    description: 'Identity, time zone, clinical context. The zone is the one that decides where a day begins.',
  },
  {
    href: '/settings/appearance',
    title: 'Appearance',
    description: 'Theme, density, motion — and which of the three actually take effect.',
  },
  {
    href: '/settings/capture',
    title: 'Capture',
    description: 'The quick-capture rail and its keyboard shortcuts.',
  },
  {
    href: '/settings/notifications',
    title: 'Notifications',
    description: 'Opt-in only. Nothing here is on by default and nothing nags.',
  },
  {
    href: '/settings/integrations',
    title: 'Integrations',
    description: 'What can be imported, from where, and what still has to be typed.',
  },
  {
    href: '/settings/ai',
    title: 'AI',
    description: 'What may be sent, what it may cost, and a switch that turns the whole layer off.',
  },
  {
    href: '/settings/privacy',
    title: 'Privacy',
    description: 'Where the encryption boundary sits, which tier holds what, and what leaves this machine.',
  },
  {
    href: '/settings/data',
    title: 'Data',
    description: 'Export the whole record, and read the permanent audit log.',
  },
  {
    href: '/settings/developer',
    title: 'Developer',
    description: 'Feature flags, the nightly run, schema version, diagnostics.',
  },
] as const;

export default async function SettingsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:read');
  if (!authorized.ok) return null;

  return (
    <PageContainer title="Settings" description="What each surface decides, and where it is.">
      <Stack gap="2">
        {SECTIONS.map((section) => (
          <Card key={section.href} variant="interactive">
            <CardBody>
              <Link href={section.href} className="nos-card__link">
                <Inline justify="between" align="center">
                  <Stack gap="1">
                    <Text role="title-3" as="h2">
                      {section.title}
                    </Text>
                    <Text role="body-sm" tone="secondary">
                      {section.description}
                    </Text>
                  </Stack>
                </Inline>
              </Link>
            </CardBody>
          </Card>
        ))}
      </Stack>
    </PageContainer>
  );
}

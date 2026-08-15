/**
 * `/life` — the pillar overview.
 *
 * One module. §3.3 R6 keeps Goals and Reviews absent rather than listed and
 * empty: "A visible-but-empty module teaches the user that the system is a
 * graveyard." A pillar with one door is a pillar with one door.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';

export const metadata = { title: 'Life · NaitikOS' };

const MODULES = [
  {
    href: '/life/documents',
    title: 'Documents',
    description: 'Where the paperwork is, what it says, and what it adds to your record.',
  },
] as const;

export default function LifePage(): ReactNode {
  return (
    <PageContainer title="Life" description="Where the paperwork is, and what it says.">
      <Stack gap="2">
        {MODULES.map((module) => (
          <Card key={module.href} variant="interactive">
            <CardBody>
              <Link href={module.href} className="nos-card__link">
                <Inline justify="between" align="center">
                  <Stack gap="1">
                    <Text role="title-3" as="h2">
                      {module.title}
                    </Text>
                    <Text role="body-sm" tone="secondary">
                      {module.description}
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

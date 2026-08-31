/**
 * `/life` — the pillar overview.
 *
 * Four modules. §3.3 R6 keeps People and Places absent rather than listed and
 * empty: "A visible-but-empty module teaches the user that the system is a
 * graveyard." Reviews joined the list when it acquired a surface.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';

export const metadata = { title: 'Life · NaitikOS' };

const MODULES = [
  {
    href: '/life/goals',
    title: 'Goals',
    description: 'A target over numbers you already record, and an honest projection of where the line goes.',
  },
  {
    href: '/life/insights',
    title: 'Insights',
    description: 'The few findings that survived the statistics, each with what it does not prove. Usually empty, which is the system working.',
  },
  {
    href: '/life/reviews',
    title: 'Reviews',
    description: 'What actually happened, drafted from the record. The draft is the labour saved; the editing is the point.',
  },
  {
    href: '/life/documents',
    title: 'Documents',
    description: 'Where the paperwork is, what it says, and what it adds to your record.',
  },
] as const;

export default function LifePage(): ReactNode {
  return (
    <PageContainer title="Life" description="What you said mattered, and where the paperwork is.">
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

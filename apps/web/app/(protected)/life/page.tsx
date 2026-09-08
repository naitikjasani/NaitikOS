/**
 * `/life` — the pillar overview.
 *
 * Five modules and one pointer. §3.3 R6 keeps a route absent until it has a
 * surface — "A visible-but-empty module teaches the user that the system is a
 * graveyard" — so each of these joined the list on the commit that gave it one.
 * People and Places were the last two to arrive.
 *
 * **Insights is not a Life module.** §3.2 puts it at the top level beside
 * `/ask`, because a finding is a lens over the whole record rather than
 * something Life owns — an adherence finding is about Body. It is listed here
 * anyway, and deliberately: the primary nav has no entry for it, so without
 * this card the only route to the inbox is the command palette, which is a
 * surface you have to already know about. Its sibling `/ask` has exactly that
 * problem today.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';

export const metadata = { title: 'Life · Ekayu' };

const MODULES = [
  {
    href: '/life/goals',
    title: 'Goals',
    description: 'A target over numbers you already record, and an honest projection of where the line goes.',
  },
  {
    href: '/insights',
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
  {
    href: '/life/people',
    title: 'People',
    description: 'Who you have not spoken to, measured against a rhythm you set. Nothing is stored about them that they could not read over your shoulder.',
  },
  {
    href: '/life/places',
    title: 'Places',
    description: 'Where you were and for how long — the record that stops a fortnight abroad reading as a finding.',
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

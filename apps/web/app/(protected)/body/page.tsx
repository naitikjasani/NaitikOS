/**
 * `/body` — the pillar overview.
 *
 * §7.5: "`/body` is served by a thin composition in `apps/web/components` that
 * renders summaries the pillar features export." Thin is the operative word —
 * this page owns no data and no logic; it is a set of doors.
 *
 * Only the modules that exist are listed. §3.3 R6: "`[V2]` and `[V3]` routes do
 * not exist in the shipped MVP. Not hidden, not disabled, not greyed out —
 * **absent**. A visible-but-empty module teaches the user that the system is a
 * graveyard."
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';

export const metadata = { title: 'Body · NaitikOS' };

const MODULES = [
  {
    href: '/body/gym',
    title: 'Gym',
    description: 'Sessions, exercises, progression, volume.',
  },
  {
    href: '/body/skin',
    title: 'Skin',
    description: 'Daily state per region, routine adherence, the product register, photography.',
  },
  {
    href: '/body/composition',
    title: 'Composition',
    description: 'Bodyweight and the seven-day trend.',
  },
  {
    href: '/body/health',
    title: 'Health',
    description: 'Vitals, labs, conditions, symptoms, appointments — and the questions worth taking to one.',
  },
  {
    href: '/body/teeth',
    title: 'Teeth',
    description: 'Per-tooth history, the hygiene routine, and how long since the last appointment.',
  },
] as const;

export default function BodyPage(): ReactNode {
  return (
    <PageContainer title="Body" description="Am I getting stronger, and is what I am doing working?">
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

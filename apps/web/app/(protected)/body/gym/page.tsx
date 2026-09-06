/**
 * `/body/gym` — the module overview (§3.2).
 *
 * Four doors, and the first one is the only one that matters mid-session. The
 * logger is a full-width primary action rather than a card in a list, because
 * §4.1's exit criterion is about what happens when the operator opens this on a
 * phone with a barbell waiting.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { ProgramCard } from '@/features/gym';

export const metadata = { title: 'Gym · NaitikOS' };

const VIEWS = [
  { href: '/body/gym/history', title: 'History', description: 'Past sessions and training days.' },
  { href: '/body/gym/exercises', title: 'Exercises', description: 'The library, and per-movement progression.' },
  { href: '/body/gym/volume', title: 'Volume', description: 'Work done, by muscle group.' },
  {
    href: '/body/gym/programs',
    title: 'Programs',
    description: 'The plan your training is measured against — and how the fortnight went against it.',
  },
] as const;

export default function GymPage(): ReactNode {
  return (
    <PageContainer title="Gym" description="Am I getting stronger, and is my training actually progressing?">
      <Stack gap="4">
        <Button asChild variant="primary" size="lg" fullWidth iconStart="nav.body">
          <Link href="/body/gym/log">Start logging</Link>
        </Button>

        {/* Renders nothing when no program is active — see the component. */}
        <ProgramCard />

        <Stack gap="2">
          {VIEWS.map((view) => (
            <Card key={view.href} variant="interactive">
              <CardBody>
                <Link href={view.href} className="nos-card__link">
                  <Inline justify="between" align="center">
                    <Stack gap="1">
                      <Text role="title-3" as="h2">
                        {view.title}
                      </Text>
                      <Text role="body-sm" tone="secondary">
                        {view.description}
                      </Text>
                    </Stack>
                  </Inline>
                </Link>
              </CardBody>
            </Card>
          ))}
        </Stack>
      </Stack>
    </PageContainer>
  );
}

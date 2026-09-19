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
 *
 * ## A hub page: the doors band, and nothing else
 *
 * `features/health/screens/HealthOverviewScreen.tsx` settles the five-band
 * shape every content-bearing overview follows — act, attend, state, record,
 * doors. This page is the doors band on its own, because it owns no data and
 * therefore has nothing to act on, attend to, or record. Four empty bands here
 * would buy a symmetry with four blank rectangles, which is the exact thing
 * §8.8 rules out.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';

export const metadata = { title: 'Body · Ekayu' };

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
    href: '/body/nutrition',
    title: 'Nutrition',
    description: 'Meals in ten seconds, macros against a target, and what the protein is made of.',
  },
  {
    href: '/body/sleep',
    title: 'Sleep',
    description: 'Duration, quality, timing and consistency — the variable §4.6 calls the highest-leverage one in the system.',
  },
  {
    href: '/body/composition',
    title: 'Composition',
    description: 'Bodyweight and the seven-day trend.',
  },
  {
    href: '/body/appearance',
    title: 'Appearance',
    description: 'Skin and physique over the same window — two figures next to each other, and no number combining them.',
  },
  {
    href: '/body/devices',
    title: 'Devices',
    description:
      'What a wearable has put in the record — heart rate, steps, energy, HRV — and where to import more of it.',
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
                {/* A `Stack`, not the `Inline justify="between"` that wrapped a
                    single child here: a flex row with one item distributes
                    nothing, and at 360px it added a wrap opportunity the title
                    and description do not want. §8.4's primitives are the
                    layout, so the layout should be the one that is meant. */}
                <Stack gap="1">
                  <Text role="title-3" as="h2">
                    {module.title}
                  </Text>
                  <Text role="body-sm" tone="secondary">
                    {module.description}
                  </Text>
                </Stack>
              </Link>
            </CardBody>
          </Card>
        ))}
      </Stack>
    </PageContainer>
  );
}

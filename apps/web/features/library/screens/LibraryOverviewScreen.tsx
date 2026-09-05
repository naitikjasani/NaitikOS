import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import type { LibraryOverviewBoard } from '@/lib/platform/library';

/**
 * `/library` — the pillar overview (§3.2).
 *
 * **A Server Component.** A set of doors and six numbers; there is nothing on
 * it to interact with, so shipping a hydration bundle for it would buy nothing.
 *
 * The doors pattern is `/body`'s, deliberately — this page owns no data and no
 * logic beyond turning a count into a sentence.
 *
 * ## What this pillar is
 *
 * Almost nothing here is new. Every registry below is written by the module
 * that owns it — Gym writes exercises, Nutrition writes foods, Skin writes the
 * product register, the routine engine writes protocols, the seed writes
 * metrics. What had no home until now was *looking at them*: this is the
 * vocabulary the record is written in, finally given a place to be read.
 *
 * Which is also why nothing here is editable. §2.1's "no manual database
 * intervention" is satisfied by the register editors those modules already
 * ship, and a second editor over the same rows would be the second source of
 * truth §9.3(4) exists to prevent.
 */

type Door = {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly count: number | null;
  readonly unit: string;
};

export function LibraryOverviewScreen({ board }: { readonly board: LibraryOverviewBoard }): ReactNode {
  const counts = board.counts;

  const doors: readonly Door[] = [
    {
      href: '/library/metrics',
      title: 'Metrics',
      description:
        'Every registered metric with its unit, range, aggregation and what it actually means. §9.2 calls this the most important table in the system.',
      count: counts.metrics,
      unit: 'registered',
    },
    {
      href: '/library/exercises',
      title: 'Exercises',
      description: 'Canonical movement definitions — muscles, equipment, mechanic, and your own form cues.',
      count: counts.exercises,
      unit: 'movements',
    },
    {
      href: '/library/foods',
      title: 'Foods',
      description: 'Canonical food definitions and the basis their nutrition is stated per.',
      count: counts.foods,
      unit: 'entries',
    },
    {
      href: '/library/products',
      title: 'Products',
      description: 'The skincare and supplement register — brand, category, key actives, lifecycle events.',
      count: counts.products,
      unit: 'products',
    },
    {
      href: '/library/protocols',
      title: 'Protocols',
      description: 'Personal protocols and SOPs: the routines skincare, dental hygiene and supplements all run on.',
      count: counts.protocols,
      unit: 'active',
    },
    {
      href: '/library/tags',
      title: 'Tags',
      description: 'The controlled vocabulary applied across every domain.',
      count: counts.tags,
      unit: 'tags',
    },
  ];

  return (
    <Stack gap="4">
      <Text role="body" tone="secondary">
        A read surface, not a new domain. Every registry here is written by the module that owns it — this is where
        the vocabulary the record is written in can be looked at.
      </Text>

      <Stack gap="2">
        {doors.map((door) => (
          <Card key={door.href} variant="interactive">
            <CardBody>
              <Link href={door.href} className="nos-card__link">
                <Inline justify="between" align="center" gap="3">
                  <Stack gap="1">
                    <Text role="title-3" as="h2">
                      {door.title}
                    </Text>
                    <Text role="body-sm" tone="secondary">
                      {door.description}
                    </Text>
                  </Stack>
                  {/* A count, or the reason there is none. §10.9: "insufficient
                      data" rather than a confident zero. */}
                  <Badge tone={door.count === null ? 'caution' : 'neutral'}>
                    {door.count === null ? 'not readable' : `${String(door.count)} ${door.unit}`}
                  </Badge>
                </Inline>
              </Link>
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

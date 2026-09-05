import type { ReactNode } from 'react';
import Link from 'next/link';
import { ROUTINE_PERIOD_LABELS, type RoutineKind } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { ProtocolEntry, ProtocolLibraryBoard } from '@/lib/platform/library';

/**
 * `/library/protocols` — personal protocols and SOPs (§3.2, §9.2).
 *
 * **A Server Component.** An ordered list of ordered lists. Nothing on it
 * changes without a deliberate edit somewhere else.
 *
 * ## A protocol is a routine
 *
 * §3.2 asks for "personal protocols & SOPs" and §9.2 already built the thing:
 * "a generic routine engine reused by skincare, dental hygiene, and supplements.
 * One implementation, three consumers — the alternative is three near-identical
 * adherence systems." A protocol is an ordered list of steps expected at a time
 * of day and logged against, which is `routine` exactly. This page is the
 * engine's definitions read as documents rather than as checklists.
 *
 * Adherence is not shown. That is the checklist's job on `/body/skin/routine`
 * and `/body/teeth`; a library page that scored you on the protocol it is
 * describing would be two screens' worth of meaning in one.
 *
 * **Gap: retired protocols are absent.** `RoutineRepository.activeRoutines`
 * filters on `is_active` and there is no method that returns inactive ones, so
 * a protocol that was run for a year and stopped cannot be read here. Said on
 * the page rather than left as a silent omission — an incomplete list that
 * looks complete is worse than a short one that admits it.
 */

/** No `ROUTINE_KIND_LABELS` exists in `core`; this is the local rendering. */
const KIND_LABELS: Readonly<Record<RoutineKind, string>> = {
  skincare: 'Skincare',
  dental: 'Dental',
  supplement: 'Supplements',
  other: 'Other',
};

export function ProtocolLibraryScreen({ board }: { readonly board: ProtocolLibraryBoard }): ReactNode {
  if (board.protocols.length === 0) {
    return (
      <EmptyState
        title="No active protocols"
        description="Routines are defined from the register editors on the skin and mind screens. Only active ones are readable here."
      />
    );
  }

  return (
    <Stack gap="6">
      <Text role="body-sm" tone="secondary">
        Read-only. Protocols are the routine engine&rsquo;s definitions — edited from{' '}
        <Link href="/body/skin/routine">the skin routine editor</Link> and{' '}
        <Link href="/mind/meds">the medication register</Link>, and ticked off there rather than here.
      </Text>

      {board.protocols.map((entry) => (
        <ProtocolCard key={entry.routine.id} entry={entry} productNames={board.productNames} />
      ))}

      {/* The gap, stated. See the file header. */}
      <Text role="caption" tone="tertiary">
        Only active protocols appear. `activeRoutines` filters on `is_active` and no repository method returns
        retired ones, so a protocol that has been stopped is not readable from this page.
      </Text>
    </Stack>
  );
}

function ProtocolCard({
  entry,
  productNames,
}: {
  readonly entry: ProtocolEntry;
  readonly productNames: Readonly<Record<string, string>>;
}): ReactNode {
  const routine = entry.routine;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" align="start" justify="between" wrap>
            <Stack gap="1">
              <Text role="title-3" as="h2">
                {routine.name}
              </Text>
              <Text role="caption" tone="tertiary">
                {`${KIND_LABELS[routine.kind]} · ${ROUTINE_PERIOD_LABELS[routine.period]}${
                  routine.expectedAt === null ? '' : ` · expected ${routine.expectedAt}`
                }`}
              </Text>
            </Stack>
            <Badge tone="neutral">{`${String(entry.steps.length)} steps`}</Badge>
          </Inline>

          {entry.steps.length === 0 ? (
            <Text role="body-sm" tone="tertiary">
              No steps defined. A routine with no steps has nothing to adhere to.
            </Text>
          ) : (
            <Stack gap="2" as="ol">
              {entry.steps.map((step) => {
                const product = step.productId === null ? undefined : productNames[step.productId];
                return (
                  <Stack key={step.id} gap="1" as="li">
                    <Inline gap="2" align="center" wrap>
                      <Text role="body-sm" as="span">
                        {`${String(step.orderIndex + 1)}. ${step.label}`}
                      </Text>
                      {/* §9.2's optional steps do not count against adherence,
                          so the reader is told which ones they are. */}
                      {step.isOptional && <Badge tone="neutral">optional</Badge>}
                      {product !== undefined && <Badge tone="accent">{product}</Badge>}
                    </Inline>
                    {step.instructions !== null && (
                      <Text role="caption" tone="tertiary">
                        {step.instructions}
                      </Text>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

import type { ReactNode } from 'react';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';
import type { MetricDefinition, MetricDomain } from '@naitikos/core';

import type { MetricRegistryBoard } from '@/lib/platform/library';

/**
 * `/library/metrics` — the metric registry (§3.2, §9.2).
 *
 * **A Server Component, and deliberately not a filtered one.** This is the page
 * where "what does `body.skin.state` actually mean" gets answered, and the
 * answer has to be *present* — a JavaScript filter box that hides rows also
 * hides them from the browser's own find, from Reader mode, and from printing.
 * The whole registry is forty-odd rows; rendering all of it is both cheaper and
 * more searchable than filtering some of it.
 *
 * ## Why this is the most valuable page in the pillar
 *
 * §9.2: "Every measurable thing is registered before it can be observed... This
 * registry is what makes P3 real. Skin can query training volume without
 * knowing Gym exists, because both speak the metric vocabulary."
 *
 * The consequence is that the registry is where a bare number gets its meaning.
 * `74.2` in an export in 2046 is nothing without the row that says it is
 * kilograms, that it is a `last` and not a `sum`, and that it is bounded to a
 * plausible human weight. The description column is data rather than
 * documentation for exactly that reason, and it is the reason this page prints
 * the description in full rather than truncating it.
 *
 * Keys are `role="mono"` because they are identifiers that get typed into
 * queries, and a proportional font makes `body.skin.state` and `body.skin.slate`
 * look alike.
 */

/** §3.2's pillars, as the registry names them. */
const DOMAIN_LABELS: Readonly<Record<MetricDomain, string>> = {
  body: 'Body',
  mind: 'Mind',
  work: 'Work',
  money: 'Money',
  life: 'Life',
  system: 'System',
};

export function MetricRegistryScreen({ board }: { readonly board: MetricRegistryBoard }): ReactNode {
  if (board.total === 0) {
    return (
      <EmptyState
        title="No metrics registered"
        description="The registry is seeded on deploy. An empty one means `pnpm db:seed` has not run against this database."
      />
    );
  }

  return (
    <Stack gap="6">
      <Inline gap="2" wrap>
        <Badge tone="neutral">{`${String(board.total)} registered`}</Badge>
        <Badge tone="accent">{`${String(board.inDailyClose)} in the Daily Close`}</Badge>
      </Inline>

      <Text role="body-sm" tone="secondary">
        Every number this system holds is an observation of one of these keys. A metric that is not here cannot be
        written — §9.2 rejects unregistered keys on write, which is what keeps the vocabulary from drifting.
      </Text>

      {board.groups.map((group) => (
        <Stack key={group.domain} gap="2">
          <Text role="title-3" as="h2">
            {DOMAIN_LABELS[group.domain]}
          </Text>
          {group.metrics.map((definition) => (
            <MetricCard key={definition.key} definition={definition} />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function MetricCard({ definition }: { readonly definition: MetricDefinition }): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline gap="3" align="start" justify="between" wrap>
            <Stack gap="1">
              <Text role="body" as="h3">
                {definition.displayName}
              </Text>
              <Text role="mono" tone="tertiary" as="code">
                {definition.key}
              </Text>
            </Stack>
            <Inline gap="1" wrap>
              <Badge tone="neutral">{definition.valueType}</Badge>
              <Badge tone="neutral">{definition.aggregation}</Badge>
              {definition.inDailyClose && <Badge tone="accent">Daily Close</Badge>}
            </Inline>
          </Inline>

          {/* The description in full, never truncated. It is the column that
              makes a bare number legible twenty years from now (§9.10). */}
          <Text role="body-sm" tone="secondary">
            {definition.description}
          </Text>

          <Inline gap="3" wrap>
            <Fact label="Unit" value={definition.canonicalUnit === '' ? 'none — a bare number' : definition.canonicalUnit} />
            <Fact label="Range" value={rangeOf(definition)} />
            {definition.allowedValues !== null && (
              <Fact label="Values" value={definition.allowedValues.join(' · ')} />
            )}
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="body-sm" as="span">
        {value}
      </Text>
    </Stack>
  );
}

/**
 * The bounds as one phrase.
 *
 * "Unbounded" is said rather than left blank: a missing range and a deliberate
 * absence of one read identically in an empty cell, and only one of them is a
 * fact about the metric.
 */
function rangeOf(definition: MetricDefinition): string {
  const { minValue, maxValue } = definition;
  if (minValue === null && maxValue === null) return 'Unbounded';
  if (minValue === null) return `up to ${maxValue ?? ''}`;
  if (maxValue === null) return `from ${minValue}`;
  return `${minValue} – ${maxValue}`;
}

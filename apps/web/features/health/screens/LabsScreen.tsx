'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { LAB_FLAG_LABELS, RANGE_CAVEAT, formatDay, isOutOfRange } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { HealthOverview } from '@/lib/platform/health';

/**
 * `/body/health/labs` — every analyte with at least one result.
 *
 * Ordered by whether it needs attention and then alphabetically, not by how
 * recently it was drawn. A panel taken last week puts eleven analytes at the
 * top of this list on the same day; the one that is out of range is the one
 * worth finding, and recency would bury it among ten normal results from the
 * same report.
 */
export function LabsScreen({ analytes }: { readonly analytes: HealthOverview['analytes'] }): ReactNode {
  if (analytes.length === 0) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.clinical"
          title="No lab results yet"
          description="File a lab report in the document vault, confirm the values it found, and each analyte gets a trend here."
        />
        <Text role="body-sm" tone="secondary" align="center">
          <Link className="nos-inline-link" href="/life/documents">
            Open the document vault
          </Link>
        </Text>
      </Stack>
    );
  }

  const ordered = [...analytes].sort((a, b) => {
    const attention = Number(isOutOfRange(b.flag)) - Number(isOutOfRange(a.flag));
    return attention !== 0 ? attention : a.displayName.localeCompare(b.displayName);
  });

  return (
    <Stack gap="4">
      <Stack gap="2">
        {ordered.map((analyte) => (
          <Card key={analyte.slug} variant="outlined">
            <CardBody>
              <Inline justify="between" align="center" wrap>
                <Stack gap="1">
                  <Link className="nos-inline-link" href={`/body/health/labs/${analyte.slug}`}>
                    {analyte.displayName}
                  </Link>
                  <Text role="caption" tone="tertiary">
                    {analyte.latestValue ?? '—'}
                    {analyte.unit === null || analyte.unit === '' ? '' : ` ${analyte.unit}`}
                    {analyte.collectedAt === null ? '' : ` · ${formatDay(analyte.collectedAt) ?? ''}`} ·{' '}
                    {analyte.resultCount === 1 ? '1 result' : `${String(analyte.resultCount)} results`}
                  </Text>
                </Stack>
                {analyte.flag !== null && (
                  <Badge tone={isOutOfRange(analyte.flag) ? 'caution' : 'neutral'}>
                    {LAB_FLAG_LABELS[analyte.flag]}
                  </Badge>
                )}
              </Inline>
            </CardBody>
          </Card>
        ))}
      </Stack>

      {/* P5, once per surface that shows a range or a flag. */}
      <Text role="caption" tone="tertiary">
        {RANGE_CAVEAT}
      </Text>
    </Stack>
  );
}

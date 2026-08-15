'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { LAB_FLAG_LABELS, RANGE_CAVEAT, formatDay, isOutOfRange } from '@naitikos/core';
import type { ChartData } from '@naitikos/design-system';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text, TrendChart } from '@naitikos/design-system';

import type { AnalyteHistory } from '@/lib/platform/health';

/**
 * `/body/health/labs/:analyte` — one analyte, over time.
 *
 * The end of §12's vitamin D loop: a PDF became results, the results became
 * observations, and this is the trend. Everything below the chart is there to
 * stop the trend from lying.
 *
 * ## The reference band is not drawn
 *
 * It was designed and dropped. A shaded band implies one range across the whole
 * series, and §9.2 is explicit that there is no such thing: "ranges vary by
 * laboratory and change over time, and a 2027 result compared against a 2035
 * range is a clinical error." Drawing the latest report's range across four
 * years of points would apply a 2029 assay's thresholds to a 2026 draw, in the
 * most persuasive form available — a shaded region.
 *
 * So each point carries its own printed range in the table beneath, and
 * {@link AnalyteHistory.shifts} says so out loud when the range actually moved.
 *
 * ## The axis does not start at zero, and says so
 *
 * §8.9(1) permits a truncated axis and requires the break to be marked, which
 * `TrendChart` does. For a lab value the truncation is not cosmetic: vitamin D
 * moving 14 → 32 is the whole story, and a zero-based axis renders it as two
 * dots near the floor.
 */
export function AnalyteScreen({ history }: { readonly history: AnalyteHistory }): ReactNode {
  if (history.points.length === 0) {
    return (
      <EmptyState
        icon="domain.clinical"
        title="No results for this analyte"
        description="Results appear here once a lab report has been filed and its values confirmed."
      />
    );
  }

  const numeric = history.points.filter(
    (point): point is typeof point & { readonly value: string; readonly collectedAt: string } =>
      point.value !== null && point.collectedAt !== null,
  );

  const latest = history.points.at(-1);
  const unit = latest?.unit ?? history.definition?.canonicalUnit ?? '';

  const data: ChartData = {
    series: [
      {
        id: history.slug,
        label: history.displayName,
        slot: 1,
        ...(unit === '' ? {} : { unit }),
        points: numeric.map((point) => ({
          at: point.collectedAt.slice(0, 10),
          value: Number(point.value),
        })),
      },
    ],
    yAxis: {
      label: history.displayName,
      ...(unit === '' ? {} : { unit }),
      /* Marked by the renderer. See the header for why zero is wrong here. */
      zeroBaseline: false,
      min: Math.min(...numeric.map((point) => Number(point.value))) * 0.9,
    },
  };

  return (
    <Stack gap="5">
      {numeric.length >= 2 ? (
        <TrendChart
          title={history.displayName}
          description={`${String(numeric.length)} results.`}
          data={data}
          caveat={RANGE_CAVEAT}
        />
      ) : (
        <Card variant="flat">
          <CardBody>
            <Text role="body-sm" tone="secondary">
              One result. A line needs two points, and a line through one point is a shape, not a trend.
            </Text>
          </CardBody>
        </Card>
      )}

      {history.shifts.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                The printed range changed
              </Text>
              <Text role="body-sm" tone="secondary">
                These results were not all measured against the same reference range. A value that looks
                different may be the same value against a different laboratory&rsquo;s scale.
              </Text>
              <Stack gap="1">
                {history.shifts.map((shift) => (
                  <Text role="caption" tone="tertiary" key={shift.firstPanelId}>
                    {shift.firstSeenAt === null ? 'From an undated report' : `From ${formatDay(shift.firstSeenAt) ?? ''}`}
                    : {shift.range}
                  </Text>
                ))}
              </Stack>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Every result
        </Text>
        {[...history.points].reverse().map((point) => (
          <Card key={point.resultId} variant="outlined">
            <CardBody>
              <Inline justify="between" align="center" wrap>
                <Stack gap="1">
                  <Text role="body" as="span">
                    {point.value ?? '—'}
                    {point.unit === null || point.unit === '' ? '' : ` ${point.unit}`}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {point.collectedAt === null ? 'Collection date not recorded' : formatDay(point.collectedAt)} ·
                    range as printed: {point.rangeText}
                  </Text>
                </Stack>
                {point.flag !== null && (
                  <Inline gap="2" align="center">
                    <Badge tone={isOutOfRange(point.flag) ? 'caution' : 'neutral'}>
                      {LAB_FLAG_LABELS[point.flag]}
                    </Badge>
                    {point.flagSource === 'derived' && (
                      <Text role="caption" tone="tertiary">
                        computed here
                      </Text>
                    )}
                  </Inline>
                )}
              </Inline>
            </CardBody>
          </Card>
        ))}
      </Stack>

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/body/health/labs">
          All analytes
        </Link>
      </Text>
    </Stack>
  );
}

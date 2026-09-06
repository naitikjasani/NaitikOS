'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { REGION_LABELS, SKIN_STATE_LABELS, shiftDayKey } from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TrendChart,
} from '@naitikos/design-system';

import { fetchProducts, fetchSkinOverview } from '../services/skinClient';

/**
 * `/body/skin` — the module overview.
 *
 * ## Three lines, not one
 *
 * The chart draws face, chest and back as three series rather than the overall
 * score, because §4.2's whole argument for per-region tracking is that "an
 * aggregate score hides a chest flare during a good face week" — and a chart of
 * the aggregate would do precisely that.
 *
 * ## A flare shows what changed, and calls it nothing
 *
 * §4.2's payoff question is "my chest acne worsened three weeks after starting
 * that moisturiser". The answer here is a *list of what changed* in the three
 * weeks before the flare, with the number of days, and no ranking, score, or
 * word resembling "cause". §14.2's Finding 9 is why: a suspected-trigger
 * ranking over n=1 with a fortnight of lag would be wrong far more often than
 * the twenty percent that destroys a warning's credibility.
 */

const WINDOW_DAYS = 90;

export function SkinOverviewScreen({ dayKey }: { readonly dayKey: string }): ReactNode {
  const fromDayKey = shiftDayKey(dayKey, -(WINDOW_DAYS - 1)) ?? dayKey;

  const overview = useQuery({
    queryKey: ['skin', 'overview', fromDayKey, dayKey],
    queryFn: () => fetchSkinOverview(fromDayKey, dayKey),
  });

  const products = useQuery({
    queryKey: ['skin', 'products', dayKey],
    queryFn: () => fetchProducts(dayKey),
  });

  if (overview.isLoading) return <LoadingState label="Loading" />;
  if (overview.error !== null) {
    return <ErrorState title="Could not load this view" description="The record is intact; this view is not." />;
  }

  const data = overview.data;
  if (data === undefined) return null;

  const productName = (id: string): string =>
    products.data?.products.find((item) => item.product.id === id)?.product.name ?? 'a product';

  return (
    <Stack gap="5">
      <Inline gap="2" wrap>
        <Link className="nos-inline-link" href="/body/skin/state">
          <Text role="body-sm" as="span">
            Log today
          </Text>
        </Link>
        <Link className="nos-inline-link" href="/body/skin/routine">
          <Text role="body-sm" as="span">
            Routine
          </Text>
        </Link>
        <Link className="nos-inline-link" href="/body/skin/products">
          <Text role="body-sm" as="span">
            Products
          </Text>
        </Link>
        <Link className="nos-inline-link" href="/body/skin/photos">
          <Text role="body-sm" as="span">
            Photos
          </Text>
        </Link>
        <Link className="nos-inline-link" href="/body/skin/regions">
          <Text role="body-sm" as="span">
            Regions
          </Text>
        </Link>
        <Link className="nos-inline-link" href="/body/skin/treatments">
          <Text role="body-sm" as="span">
            Treatments
          </Text>
        </Link>
      </Inline>

      {data.states.length === 0 ? (
        <EmptyState
          icon="domain.skin"
          title="Nothing logged yet"
          description="A skin log is one scale per region and takes about ten seconds. The chart appears once there are a few days."
        />
      ) : (
        <>
          <TrendChart
            title="State by region"
            description="1 very poor · 5 clear"
            data={{
              series: data.regions.slice(0, 3).map((region, index) => ({
                id: region.region,
                label: REGION_LABELS[region.region as keyof typeof REGION_LABELS] ?? region.region,
                /* Fixed per region, so a week with no chest reading does not
                   repaint face and back (§8.9(5)). */
                slot: (index + 1) as 1 | 2 | 3,
                points: data.states.map((state) => ({
                  at: state.observedOn,
                  value: state.regions.find((item) => item.region === region.region)?.state ?? null,
                })),
              })),
              /* Full 1–5. Truncating a five-point self-report turns a one-point
                 answering difference into a cliff (§8.9(1)). */
              yAxis: { zeroBaseline: true, min: 0, max: 5, unit: '' },
            }}
          />

          <Card variant="outlined">
            <CardBody>
              <Stack gap="3">
                <Text role="title-3" as="h2">
                  Latest by region
                </Text>
                {data.regions.map((region) => (
                  <Inline key={region.region} justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {REGION_LABELS[region.region as keyof typeof REGION_LABELS] ?? region.region}
                    </Text>
                    <Text role="mono" as="span">
                      {region.latestState === null
                        ? '—'
                        : `${String(region.latestState)} · ${SKIN_STATE_LABELS[region.latestState - 1] ?? ''}`}
                      {region.latestLesionCount === null
                        ? ''
                        : ` · ${String(region.latestLesionCount)} lesions`}
                      {` · ${String(region.recordedDays)} days`}
                    </Text>
                  </Inline>
                ))}
              </Stack>
            </CardBody>
          </Card>
        </>
      )}

      {data.flares.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="3">
              <Text role="title-3" as="h2">
                Flares
              </Text>
              {data.flares.map((flare) => (
                <Stack gap="1" key={flare.dayKey}>
                  <Inline justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {flare.dayKey}
                    </Text>
                    {flare.suspectedTrigger !== null && (
                      <Badge tone="neutral">You suspected: {flare.suspectedTrigger}</Badge>
                    )}
                  </Inline>
                  {flare.changes.length === 0 ? (
                    <Text role="caption" tone="tertiary">
                      Nothing changed in the product register in the three weeks before.
                    </Text>
                  ) : (
                    <Text role="caption" tone="tertiary">
                      {/* A list of facts, in date order. No ranking. No suspicion. */}
                      What changed first:{' '}
                      {flare.changes
                        .map(
                          (change) =>
                            `${productName(change.productId)} ${change.kind}, ${String(change.daysBefore)} days before`,
                        )
                        .join('; ')}
                      .
                    </Text>
                  )}
                </Stack>
              ))}
              <Text role="caption" tone="tertiary">
                What changed, not what caused it. The system does not have the evidence to say which.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

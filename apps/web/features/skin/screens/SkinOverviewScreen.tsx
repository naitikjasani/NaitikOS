'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { REGION_LABELS, SKIN_STATE_LABELS, shiftDayKey } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
 * Laid out in the five bands settled in `HealthOverviewScreen` — act, attend,
 * state, record, doors — for the reason argued there: §8.4's layout consistency
 * is what stops sixteen domains reading as sixteen products. Skin has no
 * *attend* band, because nothing in this module is a thing to raise with
 * somebody; a flare is history and belongs in *record*.
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
 *
 * ## Nothing on this screen is coloured by how the skin is
 *
 * A state of 1 is not red and a state of 5 is not green. §8.2's rule holds
 * hardest in the module the operator is most likely to open on a bad day: the
 * region rows carry the number *and* the word for it, which is what §8.13's
 * colour-alone prohibition asks for and what a scale needs anyway.
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
    return (
      <ErrorState
        title="Could not load this view"
        description="The record is intact; this view is not."
      />
    );
  }

  const data = overview.data;
  if (data === undefined) return null;

  const productName = (id: string): string =>
    products.data?.products.find((item) => item.product.id === id)?.product.name ?? 'a product';

  return (
    <Stack gap="6">
      {/* 1 — Act. §4.2 measures this module by whether the log happens daily,
          so the log is the first thing on the page and not a link in a row of
          six. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/body/skin/state">Log today</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/body/skin/photos">Take a photo</Link>
        </Button>
      </Inline>

      {/* 3 — State. */}
      {data.states.length === 0 ? (
        <Card variant="outlined">
          <CardHeader as="h2" title="State by region" />
          <CardBody>
            <EmptyState
              size="sm"
              icon="domain.skin"
              title="Nothing logged yet"
              description="A skin log is one scale per region and takes about ten seconds. The chart draws itself once there are a few days of them — until then there is nothing to plot, and a line through one point would be a shape the data has not earned."
            />
          </CardBody>
        </Card>
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
            <CardHeader
              as="h2"
              title="Latest by region"
              actions={
                <Button asChild variant="ghost" size="sm">
                  <Link href="/body/skin/regions">Per region</Link>
                </Button>
              }
            />
            <CardBody
              empty={{
                title: 'No regions recorded',
                description:
                  'Each log records face, chest and back separately, because an aggregate hides a chest flare during a good face week.',
              }}
            >
              {data.regions.length === 0 ? null : (
                <Stack gap="3">
                  {data.regions.map((region) => (
                    <Inline key={region.region} justify="between" align="center" gap="3" wrap>
                      <Text role="body-sm" as="span">
                        {REGION_LABELS[region.region as keyof typeof REGION_LABELS] ?? region.region}
                      </Text>
                      {/*
                        The number and the word for it, never one without the
                        other, and never a colour instead of either. §8.2: the
                        scale is reported, not judged.
                      */}
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
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* 4 — Record. The card renders whether or not there are flares: a
          section that disappears when empty makes the module look smaller than
          it is, and this one's empty state is the clearest place to say what
          the system will and will not claim (§8.8). */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Flares"
          description="What changed, not what caused it. The system does not have the evidence to say which."
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/skin/products">Products</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'No flares in the last 90 days',
            description:
              'When one is recorded, this lists every product change in the three weeks before it, in date order — a list of facts, with nothing ranked and nothing named as a cause.',
          }}
        >
          {data.flares.length === 0 ? null : (
            <Stack gap="3">
              {data.flares.map((flare) => (
                <Stack gap="1" key={flare.dayKey}>
                  <Inline justify="between" align="center" gap="3" wrap>
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
            </Stack>
          )}
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <Card variant="flat">
        <CardHeader as="h2" title="Everything in Skin" />
        <CardBody>
          {/*
            Buttons, not the row of 13px inline links this used to be. §8.13
            wants ≥44×44px with ≥8px separation; `size="sm"` carries a full-size
            hit area behind a small box, and the gap is `3` because two of them
            any closer would overlap each other's targets.
          */}
          <Inline gap="3" wrap>
            {[
              { href: '/body/skin/state', label: 'Daily log' },
              { href: '/body/skin/routine', label: 'Routine' },
              { href: '/body/skin/products', label: 'Products' },
              { href: '/body/skin/photos', label: 'Photos' },
              { href: '/body/skin/regions', label: 'Regions' },
              { href: '/body/skin/treatments', label: 'Treatments' },
            ].map((door) => (
              <Button key={door.href} asChild variant="ghost" size="sm">
                <Link href={door.href}>{door.label}</Link>
              </Button>
            ))}
          </Inline>
        </CardBody>
      </Card>
    </Stack>
  );
}

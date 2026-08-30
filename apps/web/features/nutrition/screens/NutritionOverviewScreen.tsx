'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  PROTEIN_SOURCE_LABELS,
  TARGET_STATUS_LABELS,
  formatMeasured,
  nutrientForMetricKey,
  toQuantityString,
} from '@naitikos/core';
import type { ProteinSource } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Grid, Inline, Stack, Text } from '@naitikos/design-system';

import type { NutritionOverview } from '@/lib/platform/nutrition';

/**
 * `/body/nutrition` — the module's front page, and deliberately not its home.
 *
 * The primary route is `/body/nutrition/log`. This page answers "how is the day
 * going" for someone who came to look, which happens once a day at most; the
 * log answers "what did I eat", which happens five times. Navigation is
 * arranged around that ratio, not around the usual dashboard-first habit.
 *
 * ## Protein by source is here rather than on the log
 *
 * §4.3 wants the split — how much protein came from dairy, egg, legume,
 * supplement — because it is the number that changes what gets bought, not what
 * gets eaten in the next ten seconds. On the log screen it would be one more
 * thing between a thumb and a tile.
 *
 * `unclassified` is shown as its own row rather than folded into "other". A
 * food nobody has classified is not a grain, and attributing it to one would
 * quietly make the split wrong in a direction nobody could see.
 */

export type NutritionOverviewScreenProps = {
  readonly overview: NutritionOverview;
};

export function NutritionOverviewScreen({ overview }: NutritionOverviewScreenProps): ReactNode {
  const hasTargets = overview.evaluations.length > 0;

  return (
    <Stack gap="5">
      <Inline gap="3" wrap>
        <Link className="nos-inline-link" href="/body/nutrition/log">
          Log a meal
        </Link>
        <Link className="nos-inline-link" href="/body/nutrition/trends">
          Trends
        </Link>
        <Link className="nos-inline-link" href="/body/nutrition/foods">
          Foods
        </Link>
        <Link className="nos-inline-link" href="/body/nutrition/meals">
          Saved meals
        </Link>
        <Link className="nos-inline-link" href="/body/nutrition/targets">
          Targets
        </Link>
      </Inline>

      {overview.phase !== null && (
        <Inline gap="2" align="center">
          <Badge tone="neutral">{overview.phase}</Badge>
          <Text role="caption" tone="tertiary">
            Targets in force today.
          </Text>
        </Inline>
      )}

      {hasTargets ? (
        <Card variant="outlined">
          <CardBody>
            <Grid gap="4" minColumnWidth="10rem">
              {overview.evaluations.map((evaluation) => {
                const nutrient = nutrientForMetricKey(evaluation.metricKey);
                return (
                  <Stack key={evaluation.metricKey} gap="1">
                    <Text role="caption" tone="tertiary">
                      {nutrient?.displayName ?? evaluation.metricKey}
                    </Text>
                    <Text role="title-3" as="span">
                      {evaluation.actual === null
                        ? '—'
                        : `${formatMeasured(toQuantityString(evaluation.actual))} ${evaluation.unit}`}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {TARGET_STATUS_LABELS[evaluation.status]} of {formatMeasured(toQuantityString(evaluation.target))}{' '}
                      {evaluation.unit}
                      {evaluation.hasBand ? '' : ' · no band set'}
                    </Text>
                  </Stack>
                );
              })}
            </Grid>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon="nav.body"
          title="No targets set"
          description="Meals are still recorded without them — a target only changes whether the day is measured against something. Set one under Targets when there is a reason to."
        />
      )}

      <Card variant="flat">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              Protein by source
            </Text>
            {overview.proteinBySource.length === 0 ? (
              <Text role="body-sm" tone="tertiary">
                Nothing logged today, or none of today&apos;s foods carry a protein source.
              </Text>
            ) : (
              <Stack gap="1">
                {overview.proteinBySource.map((entry) => (
                  <Inline key={entry.metricKey} justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {sourceLabel(entry.metricKey)}
                    </Text>
                    <Text role="body-sm" tone="secondary">
                      {entry.grams.toFixed(1)} g
                    </Text>
                  </Inline>
                ))}
              </Stack>
            )}
            {/* P5. The split is only as good as the classification behind it. */}
            <Text role="caption" tone="tertiary">
              Only foods with a protein source recorded appear here. Anything unclassified is left out
              rather than guessed at.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="flat">
        <CardBody>
          <Inline justify="between" align="center">
            <Text role="body-sm" as="span">
              Water
            </Text>
            <Text role="body-sm" tone="secondary">
              {overview.waterMl.toFixed(0)} ml
            </Text>
          </Inline>
        </CardBody>
      </Card>

      <Text role="caption" tone="tertiary">
        {overview.mealsToday === 0
          ? 'Nothing logged today.'
          : `${String(overview.mealsToday)} ${overview.mealsToday === 1 ? 'meal' : 'meals'} logged today.`}
      </Text>
    </Stack>
  );
}

function sourceLabel(metricKey: string): string {
  const slug = metricKey.replace('nutrition.protein.from_', '') as ProteinSource;
  return PROTEIN_SOURCE_LABELS[slug] ?? slug;
}


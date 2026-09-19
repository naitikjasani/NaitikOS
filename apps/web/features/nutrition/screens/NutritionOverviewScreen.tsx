import 'server-only';

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
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Grid,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { NutritionOverview } from '@/lib/platform/nutrition';

/**
 * `/body/nutrition` — the module's front page, and deliberately not its home.
 *
 * The primary route is `/body/nutrition/log`. This page answers "how is the day
 * going" for someone who came to look, which happens once a day at most; the
 * log answers "what did I eat", which happens five times. Navigation is
 * arranged around that ratio, not around the usual dashboard-first habit —
 * which is why the log is a button in the act band rather than the first of six
 * identical inline links, as it was.
 *
 * Laid out in the five bands settled in `HealthOverviewScreen`. Nutrition has
 * no *attend* band: nothing here is a thing to raise with anybody, and a
 * macro short of target is not an alert (§8.2).
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
 *
 * ## Nothing on this page is coloured by whether the day went well
 *
 * `TARGET_STATUS_LABELS` renders "over", "under", "within" as words in the
 * default tone. §8.2 rules `--color-caution` out for "'concerning' readings",
 * and a protein figure 20g short at 4pm is the most ordinary reading in the
 * system. It is a fact about a day that is not finished.
 *
 * ## A Server Component
 *
 * Every control on the page is a link and the data arrives as props from an
 * `async` page. It carried `'use client'`, which shipped a hydration bundle to
 * render two lists and a grid.
 */

export type NutritionOverviewScreenProps = {
  readonly overview: NutritionOverview;
};

export function NutritionOverviewScreen({ overview }: NutritionOverviewScreenProps): ReactNode {
  return (
    <Stack gap="6">
      {/* 1 — Act. §2.2 gates a meal write at ten seconds; a page that puts the
          door to it fifth in a row of small links spends three of them. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/body/nutrition/log">Log a meal</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/body/nutrition/meals">Repeat a saved meal</Link>
        </Button>
      </Inline>

      {/* 3 — State. Today, in two cards: what was eaten against what was
          planned, and the two counts that need no target to mean something. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Today against targets"
          {...(overview.phase === null
            ? {}
            : { description: `${overview.phase} — the targets in force today.` })}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/nutrition/targets">Targets</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'No targets set',
            description:
              'Meals are still recorded without them — a target only changes whether the day is measured against something. Set one when there is a reason to.',
          }}
        >
          {overview.evaluations.length === 0 ? null : (
            <Grid gap="4" minColumnWidth="10rem">
              {overview.evaluations.map((evaluation) => {
                const nutrient = nutrientForMetricKey(evaluation.metricKey);
                return (
                  <Stack key={evaluation.metricKey} gap="1">
                    <Text role="caption" tone="tertiary">
                      {nutrient?.displayName ?? evaluation.metricKey}
                    </Text>
                    {/* `metric-m` rather than `title-3`: §8.3 assigns that role
                        to "secondary metric value" and carries tabular figures
                        with it, so a column of macros does not jitter as the
                        day fills in. */}
                    <Text role="metric-m" as="span">
                      {evaluation.actual === null
                        ? '—'
                        : `${formatMeasured(toQuantityString(evaluation.actual))} ${evaluation.unit}`}
                    </Text>
                    {/* The status is a word, in the default tone. See the
                        header: a macro short of target is not an alert. */}
                    <Text role="caption" tone="tertiary">
                      {TARGET_STATUS_LABELS[evaluation.status]} of{' '}
                      {formatMeasured(toQuantityString(evaluation.target))} {evaluation.unit}
                      {evaluation.hasBand ? '' : ' · no band set'}
                    </Text>
                  </Stack>
                );
              })}
            </Grid>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader as="h2" title="Today" />
        <CardBody>
          <Grid gap="4" minColumnWidth="10rem">
            <Figure
              label="Meals logged"
              value={String(overview.mealsToday)}
              detail={
                overview.mealsToday === 0
                  ? 'Nothing logged today. A day with no meals in it is a day nobody typed into, not a day nobody ate on.'
                  : null
              }
            />
            <Figure label="Water" value={`${overview.waterMl.toFixed(0)} ml`} detail={null} />
          </Grid>
        </CardBody>
      </Card>

      {/* 4 — Record. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Protein by source"
          /* P5. The split is only as good as the classification behind it. */
          description="Only foods with a protein source recorded appear here. Anything unclassified is left out rather than guessed at."
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/nutrition/foods">Foods</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing to split yet',
            description:
              'Either nothing was logged today, or none of today’s foods carry a protein source. This is the number that changes what gets bought rather than what gets eaten next.',
          }}
        >
          {overview.proteinBySource.length === 0 ? null : (
            <Stack gap="2">
              {overview.proteinBySource.map((entry) => (
                <Inline key={entry.metricKey} justify="between" align="center" gap="3" wrap>
                  <Text role="body-sm" as="span">
                    {sourceLabel(entry.metricKey)}
                  </Text>
                  <Text role="mono" as="span">
                    {entry.grams.toFixed(1)} g
                  </Text>
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <Card variant="flat">
        <CardHeader as="h2" title="Everything in Nutrition" />
        <CardBody>
          <Inline gap="3" wrap>
            {[
              { href: '/body/nutrition/log', label: 'Today’s intake' },
              { href: '/body/nutrition/trends', label: 'Trends' },
              { href: '/body/nutrition/foods', label: 'Foods' },
              { href: '/body/nutrition/meals', label: 'Saved meals' },
              { href: '/body/nutrition/targets', label: 'Targets' },
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

/** One figure and, where the number needs one, the sentence that reads it. */
function Figure({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
}): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
      {detail !== null && (
        <Text role="caption" tone="tertiary">
          {detail}
        </Text>
      )}
    </Stack>
  );
}

function sourceLabel(metricKey: string): string {
  const slug = metricKey.replace('nutrition.protein.from_', '') as ProteinSource;
  return PROTEIN_SOURCE_LABELS[slug] ?? slug;
}

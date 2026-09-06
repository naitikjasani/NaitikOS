import type { ReactNode } from 'react';
import { AdherenceGrid, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import { SKIN_STATE_LABELS } from '@naitikos/core';
import type { RegionHistory, SkinRegionsView } from '@/lib/platform/skin';

/**
 * `/body/skin/regions` — each tracked region as its own series.
 *
 * ## Why this is not the overview
 *
 * `/body/skin` reports one figure per region: a ninety-day mean. The question
 * this page exists for — *is my face clearing while my back is not* — is
 * invisible in a mean. Two regions with the same average can be moving in
 * opposite directions, and §4.2's whole reason for recording per region rather
 * than one "skin: 3" is that they do.
 *
 * ## Every tracked region appears, recorded or not
 *
 * §4.2 fixes the list at face, chest and back. A region silently absent because
 * it has never been logged would read as a region with nothing wrong, which is
 * the §8.9 failure in its most misleading form — an empty row says "no data",
 * an absent row says "fine".
 *
 * ## A day with no record is empty, never a zero
 *
 * `AdherenceGrid` already draws the distinction and its header states the
 * reasoning: "absence of evidence, not evidence of absence." A skipped Tuesday
 * is not a Tuesday with clear skin.
 *
 * A Server Component. Nothing here is interactive — logging happens on
 * `/body/skin/state`, where the form is.
 */
export function SkinRegionsScreen({ view }: { readonly view: SkinRegionsView }): ReactNode {
  return (
    <Stack gap="5">
      <Text role="body-sm" tone="secondary">
        {view.recordedDays === 0 ?
          `Nothing recorded in the last ${String(view.windowDays)} days.`
        : `${String(view.recordedDays)} of the last ${String(view.windowDays)} days have a record.`}
      </Text>

      {view.recordedDays === 0 ?
        <EmptyState
          title="No skin record in this window"
          description="Log a day on the skin page and each region gets its own line here. The point of three regions rather than one number is that they move independently."
        />
      : <Stack gap="4">
          {view.regions.map((region) => (
            <RegionCard key={region.region} region={region} view={view} />
          ))}
        </Stack>
      }
    </Stack>
  );
}

function RegionCard({
  region,
  view,
}: {
  readonly region: RegionHistory;
  readonly view: SkinRegionsView;
}): ReactNode {
  const recorded = region.series.filter((point) => point.state !== null);

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" justify="between" align="baseline">
            <Text role="title-3" as="h2">
              {region.label}
            </Text>
            <RegionReading region={region} />
          </Inline>

          {recorded.length === 0 ?
            /* Present and empty, not absent. See the screen header. */
            <Text role="caption" tone="tertiary">
              Never recorded in this window. That is a gap in the log, not a clear region.
            </Text>
          : <AdherenceGrid
              title={`${region.label} state`}
              description={`Daily state for ${region.label.toLowerCase()}, darker meaning worse. Blank days were not logged.`}
              fromDayKey={view.fromDayKey}
              toDayKey={view.toDayKey}
              data={{
                yAxis: { label: 'State', zeroBaseline: true, min: 0, max: 5 },
                series: [
                  {
                    id: region.region,
                    label: region.label,
                    slot: 1,
                    points: recorded.map((point) => ({ at: point.dayKey, value: point.state })),
                  },
                ],
              }}
            />
          }
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * The latest state and the mean, with the count that makes the mean readable.
 *
 * `recordedDays` travels with the mean for the reason `regionTrends` gives: a
 * mean of 4.0 from two days is not a mean of 4.0 from thirty, and a figure
 * without its denominator invites exactly that reading.
 */
function RegionReading({ region }: { readonly region: RegionHistory }): ReactNode {
  const trend = region.trend;
  if (trend === null || trend.recordedDays === 0) {
    return (
      <Text role="caption" tone="tertiary">
        no readings
      </Text>
    );
  }

  return (
    <Stack gap="0" align="end">
      <Text role="body-sm">{describeState(trend.latestState)}</Text>
      <Text role="caption" tone="tertiary">
        {trend.meanState === null ? '' : `mean ${trend.meanState.toFixed(1)} over ${String(trend.recordedDays)} days`}
        {trend.latestLesionCount === null ? '' : ` · ${String(trend.latestLesionCount)} lesions`}
      </Text>
    </Stack>
  );
}

/** The scale's own word, not a number. `SKIN_STATE_LABELS` is 1-indexed by state. */
function describeState(state: number | null): string {
  if (state === null) return '—';
  return SKIN_STATE_LABELS[state - 1] ?? String(state);
}

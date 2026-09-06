import type { ReactNode } from 'react';
import Link from 'next/link';
import { REGION_LABELS, SKIN_STATE_LABELS } from '@naitikos/core';
import type { BodyRegion, RegionTrend } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { AppearanceBoard } from '@/lib/platform/appearance';

/**
 * `/body/appearance` — §2.3's aggregate lens over skin, physique, grooming and
 * hair.
 *
 * ## There is no appearance score, and there will not be one
 *
 * This is the single most important decision on this page, so it is the first
 * thing in the file.
 *
 * A page called Appearance is the one surface in this system most likely to
 * become a self-esteem scoreboard. A composite number over skin state, weight
 * trend and photo compliance would be trivial to compute, would look
 * authoritative, and would be a value judgement about a person's body dressed
 * as a measurement — with weights nobody could justify, changing daily, for a
 * quantity that does not exist.
 *
 * §10.0 forbids the model asserting; the same reasoning applies with more force
 * to the application, because a deterministic score is *more* convincing and no
 * more entitled. So this page lays figures next to each other and says nothing
 * about how they combine.
 *
 * ## Nothing here is computed
 *
 * P3: a lens is "a query with a UI attached". Every figure on this page is
 * produced by the same code that produces it on `/body/skin` and
 * `/body/composition`, and the loader calls those services rather than querying
 * for itself. If that ever stops being true, this has become a sixth pillar
 * with a private opinion, and the two surfaces will disagree the first time one
 * is changed.
 *
 * ## The two missing elements are named
 *
 * §2.3 lists four. Grooming and hair have no table and no capture path. Showing
 * two of four silently would imply the record was empty for the other two
 * because nothing had happened — the §8.9 failure applied to a whole domain,
 * and on the one page where a person might read a gap in the system as a gap in
 * themselves.
 *
 * A Server Component. Nothing here is interactive: this is a set of doors and
 * the figures behind them are recorded elsewhere.
 */
export function AppearanceScreen({ board }: { readonly board: AppearanceBoard }): ReactNode {
  const covered = board.elements.filter((element) => element.href !== null);
  const missing = board.elements.filter((element) => element.href === null);

  return (
    <Stack gap="5">
      <Text role="body-sm" tone="secondary">
        {board.fromDayKey} to {board.toDayKey}. Every element is read over the same {String(board.windowDays)}{' '}
        days, so nothing here is being compared across two different windows.
      </Text>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h2">
                Skin
              </Text>
              <Inline gap="2" align="center">
                {board.skinFlares > 0 && (
                  <Badge tone="neutral">
                    {String(board.skinFlares)} {board.skinFlares === 1 ? 'flare' : 'flares'}
                  </Badge>
                )}
                <Link className="nos-inline-link" href="/body/skin">
                  <Text role="caption" as="span">
                    Open
                  </Text>
                </Link>
              </Inline>
            </Inline>

            {board.skinRecordedDays === 0 ?
              <Text role="caption" tone="tertiary">
                Nothing recorded in this window. A gap in the log, not a clear ninety days.
              </Text>
            : <Stack gap="2">
                {board.skinRegions.map((trend) => (
                  <RegionLine key={trend.region} trend={trend} />
                ))}
                <Text role="caption" tone="tertiary">
                  {String(board.skinRecordedDays)} of {String(board.windowDays)} days have a record. The mean is
                  over recorded days only.
                </Text>
              </Stack>
            }
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h2">
                Physique
              </Text>
              <Link className="nos-inline-link" href="/body/composition">
                <Text role="caption" as="span">
                  Open
                </Text>
              </Link>
            </Inline>
            <Text role="body-sm" tone="secondary">
              {/*
                Deliberately a door rather than a figure. §4.6 makes the honest
                bodyweight number the seven-day moving average, and reproducing
                a headline weight here would mean a second place that decides
                which number to lead with — the drift a lens exists to avoid.
              */}
              Bodyweight and its seven-day trend live on the composition page, where the trend is the headline
              and the raw reading is the faint line behind it. Repeating a single number here would be a second
              opinion about which one matters.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Not tracked
            </Text>
            {missing.map((element) => (
              <Stack key={element.id} gap="0">
                <Text role="body">{element.label}</Text>
                <Text role="body-sm" tone="secondary">
                  {element.absence}
                </Text>
              </Stack>
            ))}
            <Text role="caption" tone="tertiary">
              Named rather than omitted. A gap here is a gap in this system, not in your attention.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              There is no overall figure
            </Text>
            <Text role="body-sm" tone="secondary">
              Skin state and a weight trend do not combine into a number, and any weighting that made them
              would be an opinion about your body wearing the clothes of a measurement. The two are shown next
              to each other because that is genuinely useful; what it means is yours to read.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {covered.length === 0 && (
        <EmptyState
          title="Nothing to show yet"
          description="This page reads from Skin and Composition. Record a day in either and it appears here."
        />
      )}
    </Stack>
  );
}

function RegionLine({ trend }: { readonly trend: RegionTrend }): ReactNode {
  return (
    <Inline gap="3" justify="between" align="baseline">
      <Text role="body-sm">{REGION_LABELS[trend.region as BodyRegion] ?? trend.region}</Text>
      <Stack gap="0" align="end">
        <Text role="body-sm">{describeState(trend.latestState)}</Text>
        <Text role="caption" tone="tertiary">
          {trend.meanState === null ?
            'no readings'
          : `mean ${trend.meanState.toFixed(1)} over ${String(trend.recordedDays)} days`}
        </Text>
      </Stack>
    </Inline>
  );
}

/** The scale's own word, not a number. `SKIN_STATE_LABELS` is 1-indexed by state. */
function describeState(state: number | null): string {
  if (state === null) return '—';
  return SKIN_STATE_LABELS[state - 1] ?? String(state);
}

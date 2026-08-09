import type { ReactNode } from 'react';
import type { BudgetedMetric } from '@naitikos/core';
import {
  AdherenceGrid,
  Badge,
  Card,
  CardBody,
  Divider,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { ValidationReport } from '@/lib/platform/validation';

/**
 * `/settings/developer` — §5.11's "single internal dashboard".
 *
 * ## This screen is for the maintainer, not the operator
 *
 * They are the same person, which is exactly why the separation has to be
 * deliberate. §14.1's second finding forbids guilt copy about gaps, and §1.5
 * refused a streak because "miss day 34 and the incentive collapses, which is
 * precisely the anxiety-amplifying dynamic P6 prohibits."
 *
 * A gate countdown on `/today` would be that streak, rebuilt. So it lives here,
 * behind a route nobody opens by accident, framed as a fact about the *project*:
 * "22 closed, 3 needed, 4 days remaining" is a statement about whether October
 * is V2 or capture friction. It is not a statement about the operator.
 *
 * ## A metric with no data says so
 *
 * Every §1.4 figure renders `unknown` rather than a passing zero when nothing
 * was measured. A dashboard that showed "0.0 s ✓" for capture latency on a day
 * nothing was captured would report the health metric as passing precisely when
 * the system was not being used — which is the failure the thirty days exist to
 * detect.
 */

const VERDICT_LABEL: Readonly<Record<ValidationReport['gate']['verdict'], string>> = Object.freeze({
  passed: 'Met',
  missed: 'Missed',
  on_track: 'On track',
  at_risk: 'No margin left',
  unreachable: 'Out of reach',
});

export function DeveloperScreen({ report }: { readonly report: ValidationReport }): ReactNode {
  return (
    <Stack gap="5">
      {/* --- The gate ------------------------------------------------- */}
      <Card variant="raised">
        <CardBody>
          <Stack gap="3">
            <Inline justify="between" align="center">
              <Text role="title-3" as="h2">
                V1 gate
              </Text>
              <Badge tone={report.gate.verdict === 'passed' ? 'accent' : 'neutral'}>
                {VERDICT_LABEL[report.gate.verdict]}
              </Badge>
            </Inline>

            <Text role="metric-l" as="p">
              {String(report.gate.closes)} / {String(report.gate.required)}
            </Text>

            <Text role="body-sm" tone="secondary">
              {report.gate.sentence}
            </Text>

            {/*
              The consequence, on every verdict rather than only on failure.
              §12: "the discipline to honour it is the difference between a
              system that lasts and a graveyard of half-built modules." Naming
              what October is for is what makes the gate a decision rather than
              a number.
            */}
            <Text role="caption" tone="tertiary">
              {report.gate.consequence}
            </Text>

            <AdherenceGrid
              title="Days closed in the validation window"
              description="30 August – 29 September"
              fromDayKey={report.gateWindowDays[0] ?? report.todayDayKey}
              toDayKey={report.gateWindowDays.at(-1) ?? report.todayDayKey}
              data={{
                series: [
                  {
                    id: 'closes',
                    label: 'Daily Close',
                    slot: 1,
                    points: report.gateWindowDays.map((dayKey) => ({
                      at: dayKey,
                      /*
                       * A day in the window with no Close is a recorded zero,
                       * not a gap: the window is known, so "did not happen" is
                       * a fact rather than an absence. Future days are gaps.
                       */
                      value:
                        dayKey > report.todayDayKey ? null : report.closedDays.includes(dayKey) ? 1 : 0,
                    })),
                  },
                ],
                yAxis: { zeroBaseline: true, unit: '' },
              }}
            />
          </Stack>
        </CardBody>
      </Card>

      {/* --- §1.4 ----------------------------------------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="4">
            <Stack gap="1">
              <Text role="title-3" as="h2">
                Health metrics
              </Text>
              <Text role="caption" tone="tertiary">
                Trailing {String(report.windowDays)} days, ending {report.todayDayKey}.
              </Text>
            </Stack>

            <MetricRow label="Median capture latency" metric={report.captureLatency} />
            <Divider />
            <MetricRow label="Time in app (counter-metric)" metric={report.timeInApp} />
            <Divider />
            <MetricRow label="Correction rate" metric={report.correctionRate} />
            <Divider />
            <MetricRow label="Derived-fact ratio" metric={report.derivedFacts} />
          </Stack>
        </CardBody>
      </Card>

      {/* --- §1.5's anti-goal ----------------------------------------- */}
      {report.gaming.gamed && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="1">
              <Text role="title-3" as="h2">
                The North Star is eating the counter-metric
              </Text>
              <Text role="body-sm" tone="secondary">
                {report.gaming.sentence}
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {/* --- Drop-off and sync ---------------------------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              The ritual
            </Text>
            <Text role="body-sm" tone="secondary">
              {report.closeFunnel.sentence}
            </Text>
            <Inline justify="between" align="center">
              <Text role="body-sm" as="span">
                Sync failures
              </Text>
              <Text role="mono" as="span">
                {String(report.syncFailures)}
              </Text>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {/* --- What is actually being emitted --------------------------- */}
      <Card variant="flat">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              Events recorded
            </Text>
            {/*
              The raw counts, deliberately. A metric that reads zero because
              nothing emits it looks identical to one that reads zero because
              nothing happened — and the first is a defect. This list is how the
              two are told apart, and it is the check that would have caught
              `capture.latency` having no writer for three milestones.
            */}
            {Object.keys(report.eventCounts).length === 0 ? (
              <Text role="body-sm" tone="secondary">
                Nothing recorded in this window.
              </Text>
            ) : (
              Object.entries(report.eventCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, total]) => (
                  <Inline key={name} justify="between" align="center">
                    <Text role="mono" as="span">
                      {name}
                    </Text>
                    <Text role="mono" as="span">
                      {String(total)}
                    </Text>
                  </Inline>
                ))
            )}
            <Text role="caption" tone="tertiary">
              Names and numbers only. §5.11: the schema cannot represent user content, which makes
              leakage impossible rather than prohibited. Ninety-day retention, swept nightly.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

function MetricRow({
  label,
  metric,
}: {
  readonly label: string;
  readonly metric: BudgetedMetric;
}): ReactNode {
  return (
    <Stack gap="1">
      <Inline justify="between" align="center">
        <Text role="body-sm" as="span">
          {label}
        </Text>
        {/*
          The status is a word, not a colour. §8.13: no information conveyed by
          colour alone — and on a dashboard read at a glance that is the rule
          most easily broken.
        */}
        <Badge tone={metric.status === 'over' ? 'caution' : metric.status === 'within' ? 'accent' : 'neutral'}>
          {metric.status === 'unknown' ? 'no data' : metric.status === 'within' ? 'within budget' : 'over budget'}
        </Badge>
      </Inline>
      <Text role="caption" tone="tertiary">
        {metric.sentence}
      </Text>
    </Stack>
  );
}

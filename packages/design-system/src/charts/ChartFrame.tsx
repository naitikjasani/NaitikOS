'use client';

import { useId, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import { IconButton } from '../components/Button';
import { Badge } from '../components/Display';
import { Text } from '../primitives/Text';
import { Inline, Stack } from '../primitives/Layout';
import {
  seriesColorVar,
  validateChartData,
  type ChartData,
  type ChartForm,
} from './types';

/**
 * The frame every chart renders inside.
 *
 * §8.9: "Exactly one package imports the charting library. Features import
 * `<TrendChart>`, `<DistributionChart>`, `<AdherenceGrid>`,
 * `<ComparisonChart>` — never Recharts."
 *
 * **No charting library is imported yet, and that is deliberate.** Charts are
 * V2 (§2.1 defers all analysis beyond adherence), so importing Recharts now
 * would add a bundle dependency to a PWA with a performance budget (§11.5) for
 * a feature that cannot ship. What exists here is the part that has to be right
 * *before* the first chart: the frame, the legend, the mandatory data table,
 * and the invariant checks.
 *
 * When the plot layer lands, it slots into `children`. Nothing above it changes.
 *
 * ## What the frame guarantees on behalf of every chart
 *
 * | Guarantee | §8.9 |
 * |---|---|
 * | A data table toggle is always present | (6) "Every chart has a table." |
 * | The legend is text, never colour alone | (5), §8.13 |
 * | A truncated y-axis is visibly marked | (1) |
 * | Interventions are listed as annotations | (2) |
 * | Readable at 360px | (7) |
 */

export type ChartFrameProps = {
  readonly form: ChartForm;
  /** The question this chart answers. §8.9 prescribes form by question. */
  readonly title: string;
  readonly description?: string;
  readonly data: ChartData;
  /** The plot. Absent until the chart layer is built. */
  readonly children?: ReactNode;
  /** Height of the plot area. Charts are never taller than they are wide on mobile. */
  readonly height?: number;
  readonly className?: string;
};

export function ChartFrame({
  form,
  title,
  description,
  data,
  children,
  height = 240,
  className,
}: ChartFrameProps): ReactNode {
  const titleId = useId();
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);

  const problems = validateChartData(form, data);
  const isTruncated = !data.yAxis.zeroBaseline;

  return (
    <figure
      className={cn('nos-chart', className)}
      // A figure with an accessible name, so a screen reader can navigate to
      // "Bodyweight over 90 days" rather than "graphic".
      aria-labelledby={titleId}
      role="group"
    >
      <div className="nos-chart__header">
        <Stack gap="1">
          <Text role="title-3" as="h3" id={titleId}>
            {title}
          </Text>
          {description !== undefined && (
            <Text role="body-sm" tone="secondary">
              {description}
            </Text>
          )}
        </Stack>

        <IconButton
          icon={showTable ? 'data.chart' : 'data.table'}
          label={showTable ? 'Show chart' : 'Show data table'}
          size="sm"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => {
            setShowTable((current) => !current);
          }}
        />
      </div>

      {/*
        The truncation notice.
        §8.9(1): "An unlabelled truncated axis is a lie told in a health
        application." Rendered as text rather than a subtle axis glyph, because
        the glyph is what everyone misses.
      */}
      {isTruncated && (
        <Inline gap="1">
          <Badge tone="neutral" icon="status.info">
            Axis starts at {String(data.yAxis.min ?? '—')}
            {data.yAxis.unit ?? ''}, not zero
          </Badge>
        </Inline>
      )}

      {/* Legend. Present whenever there are two or more series, and it carries
          the label as text — colour is never the only identifier (§8.13). */}
      {data.series.length > 1 && (
        <ul className="nos-chart__legend" role="list">
          {data.series.map((series) => (
            <li key={series.id} className="nos-chart__legend-item">
              <span
                className="nos-chart__swatch"
                style={{ background: seriesColorVar(series.slot) }}
                aria-hidden="true"
              />
              <Text role="caption" tone="secondary" as="span">
                {series.label}
              </Text>
            </li>
          ))}
        </ul>
      )}

      {showTable ? (
        <ChartDataTable id={tableId} data={data} />
      ) : (
        <div className="nos-chart__plot" style={{ height: `${String(height)}px` }}>
          {children ?? (
            <div className="nos-chart__placeholder">
              <Icon name="data.chart" label={null} size="lg" />
              <Text role="caption" tone="tertiary" align="center">
                The plot layer arrives in V2. The table below already holds the data.
              </Text>
            </div>
          )}
        </div>
      )}

      {/* Annotations listed in text, not only drawn.
          §8.9(2) requires the markers; listing them also makes them available
          to a screen reader, which cannot see a vertical line. */}
      {data.annotations !== undefined && data.annotations.length > 0 && (
        <Stack gap="1">
          <Text role="caption" tone="tertiary">
            Interventions shown
          </Text>
          <ul className="nos-chart__annotations" role="list">
            {data.annotations.map((annotation) => (
              <li key={annotation.id}>
                <Text role="caption" tone="secondary" as="span">
                  {annotation.label}
                </Text>
              </li>
            ))}
          </ul>
        </Stack>
      )}

      {/*
        Invariant violations, surfaced in development rather than thrown.
        A chart that refuses to render teaches nothing; a chart with its own
        complaint underneath teaches the rule.
      */}
      {problems.length > 0 && process.env['NODE_ENV'] !== 'production' && (
        <ul className="nos-chart__problems" role="list">
          {problems.map((problem) => (
            <li key={problem}>
              <Text role="caption" tone="critical" as="span">
                §8.9: {problem}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/**
 * The data table behind every chart.
 *
 * §8.9(6) gives three reasons and the third is the one people forget: "This
 * serves screen-reader users, satisfies 'what exactly was that number,' and —
 * usefully — **forces the data to be correct before the visual is trusted.**"
 *
 * A gap renders as an em dash, never as 0 — consistent with §8.9(3).
 */
function ChartDataTable({ id, data }: { readonly id: string; readonly data: ChartData }): ReactNode {
  // Union of every timestamp across series, so a point missing from one series
  // still gets a row and reads as a gap rather than vanishing.
  const timestamps = [...new Set(data.series.flatMap((s) => s.points.map((p) => p.at)))].sort();

  return (
    <div className="nos-chart__table-wrap" id={id}>
      <table className="nos-table">
        <caption className="nos-visually-hidden">Underlying values</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            {data.series.map((series) => (
              <th key={series.id} scope="col" className="nos-table__num">
                {series.label}
                {series.unit !== undefined && ` (${series.unit})`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {timestamps.map((at) => (
            <tr key={at}>
              <th scope="row">{at}</th>
              {data.series.map((series) => {
                const point = series.points.find((p) => p.at === at);
                return (
                  <td key={series.id} className="nos-table__num">
                    {point?.value ?? '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

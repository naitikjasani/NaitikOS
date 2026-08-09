'use client';

import { useMemo, useRef, type ReactNode } from 'react';

import { ChartFrame } from './ChartFrame';
import { formatTick, resolveYDomain } from './scales';
import { seriesColorVar, type ChartData } from './types';
import { useElementWidth } from './useElementWidth';

/**
 * Bars — §8.9's answer to "how much of something, per period?"
 *
 * Used for volume by muscle group, which is a *categorical* bar rather than a
 * time bar: the x axis is a list of muscles, not a range of days. That is why
 * this component takes categories explicitly instead of reusing the day-keyed
 * series shape — a chart whose x axis pretends to be time when it is not is the
 * quiet start of a chart that gets read as a trend.
 *
 * ## Two rules from §8.9 that bars specifically
 *
 * **Bars start at zero. Always.** A truncated bar chart is a different and
 * worse lie than a truncated line chart, because a bar's *length* is the
 * encoding — halving the axis doubles the apparent difference. `zeroBaseline`
 * is therefore not honoured as `false` here; the axis is forced to zero and the
 * frame's truncation badge never fires.
 *
 * **Never a pie.** §8.9's selection table says composition is a stacked bar,
 * and there is no pie in this package to reach for.
 */

export type BarDatum = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** Fixed per entity, so a filter cannot repaint the survivors. */
  readonly slot: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** A second line under the label — "12 sets", "3 sessions". */
  readonly detail?: string;
};

export type BarChartProps = {
  readonly title: string;
  readonly description?: string;
  readonly data: readonly BarDatum[];
  readonly unit?: string;
  /** Height per bar row. Horizontal bars: category labels need the width. */
  readonly rowHeight?: number;
  readonly className?: string;
};

/**
 * Horizontal, not vertical.
 *
 * Twelve muscle groups with vertical bars at 360px gives each label 28 pixels,
 * which forces 45° rotated text — the single most common unreadable thing in a
 * dashboard. Horizontal bars give every label a full line at the body size and
 * cost only vertical space, which a phone has.
 */
const DEFAULT_ROW_HEIGHT = 30;
const LABEL_WIDTH = 96;

export function BarChart({
  title,
  description,
  data,
  unit,
  rowHeight = DEFAULT_ROW_HEIGHT,
  className,
}: BarChartProps): ReactNode {
  /*
   * The frame wants a `ChartData`, and it is what powers the mandatory table
   * (§8.9(6)). Each category becomes a one-point series so the table reads as
   * one row per category with its value — which is exactly the table a reader
   * wants for a bar chart.
   */
  const asChartData: ChartData = useMemo(
    () => ({
      series: data.slice(0, 8).map((datum) => ({
        id: datum.id,
        label: datum.label,
        slot: datum.slot,
        ...(unit === undefined ? {} : { unit }),
        points: [{ at: 'total', value: datum.value }],
      })),
      yAxis: { zeroBaseline: true, ...(unit === undefined ? {} : { unit }) },
    }),
    [data, unit],
  );

  return (
    <ChartFrame
      form="bar"
      title={title}
      {...(description === undefined ? {} : { description })}
      data={asChartData}
      height={Math.max(rowHeight, data.length * rowHeight + 24)}
      {...(className === undefined ? {} : { className })}
    >
      <BarPlot data={data} unit={unit} rowHeight={rowHeight} />
    </ChartFrame>
  );
}

function BarPlot({
  data,
  unit,
  rowHeight,
}: {
  readonly data: readonly BarDatum[];
  readonly unit: string | undefined;
  readonly rowHeight: number;
}): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const width = useElementWidth(container);

  const height = Math.max(rowHeight, data.length * rowHeight + 24);

  // Forced to zero — see the header. The `max` is over the data, so a single
  // dominant category does not flatten the rest into invisibility.
  const domain = resolveYDomain(
    [{ id: 'all', label: 'all', slot: 1, points: data.map((datum) => ({ at: 'total', value: datum.value })) }],
    { zeroBaseline: true },
    3,
  );

  const plotLeft = LABEL_WIDTH;
  const plotWidth = Math.max(1, width - plotLeft - 8);
  const scale = (value: number): number =>
    domain.max === 0 ? 0 : (Math.max(0, value) / domain.max) * plotWidth;

  return (
    <div className="nos-plot" ref={container}>
      <svg
        className="nos-plot__svg"
        width={width}
        height={height}
        role="img"
        aria-label="Bar chart. The data table below carries the values."
      >
        {domain.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={plotLeft + scale(tick)}
              x2={plotLeft + scale(tick)}
              y1={0}
              y2={data.length * rowHeight}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={plotLeft + scale(tick)}
              y={data.length * rowHeight + 14}
              textAnchor="middle"
              className="nos-plot__tick"
            >
              {formatTick(tick, domain.step)}
            </text>
          </g>
        ))}

        {data.map((datum, index) => {
          const y = index * rowHeight;
          const barHeight = Math.max(6, rowHeight - 12);
          const length = scale(datum.value);

          return (
            <g key={datum.id}>
              <text x={0} y={y + rowHeight / 2} dominantBaseline="middle" className="nos-plot__label">
                {datum.label}
              </text>
              <rect
                x={plotLeft}
                y={y + (rowHeight - barHeight) / 2}
                width={Math.max(0, length)}
                height={barHeight}
                // 4px rounded ends on the data end only: the baseline end stays
                // square so bars remain visually anchored to zero.
                rx={4}
                fill={seriesColorVar(datum.slot)}
              />
              {/*
                Selective direct labels, not a number on every mark. The value
                sits at the end of its own bar, which is where the eye already
                is — and it is omitted when the bar is too short to hold it
                without colliding with the next category.
              */}
              {length > 40 && (
                <text
                  x={plotLeft + length - 6}
                  y={y + rowHeight / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="nos-plot__value"
                >
                  {formatTick(datum.value, domain.step)}
                  {unit === undefined ? '' : ` ${unit}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

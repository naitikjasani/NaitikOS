'use client';

import { useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';

import { Text } from '../primitives/Text';
import { ChartFrame } from './ChartFrame';
import { axisLabel, dayIndex, dayKeyOf } from './calendar';
import {
  bandPath,
  formatTick,
  linePath,
  linearScale,
  placePoints,
  plotBox,
  resolveXDomain,
  resolveYDomain,
} from './scales';
import { seriesColorVar, type ChartData, type Series } from './types';
import { useElementWidth } from './useElementWidth';

/**
 * The line chart — §8.9's answer to "how has one metric moved over time?"
 *
 * ## No charting library, and the reasoning is C2
 *
 * §8.9 says "exactly one package imports the charting library", and the
 * invariant it protects is that *features* never import one. Importing none at
 * all satisfies it strictly, and buys the thing C2 actually asks for: a plot
 * layer that is four hundred lines of SVG and integer arithmetic will still
 * build in 2046. Recharts, at the version pinned today, will not — and the
 * migration off it lands exactly when the charts have twenty years of data in
 * them and nobody remembers how the axis logic worked.
 *
 * What the library would have bought is animation, a legend implementation, and
 * a tooltip. The frame already has a legend; the readout below is the tooltip;
 * §8.6 wants restraint in motion anyway.
 *
 * ## Every §8.9 invariant, and where it lives
 *
 * | Invariant | Implementation |
 * |---|---|
 * | (1) truncation is marked | `resolveYDomain().isTruncated` → the badge in `ChartFrame`, and the break glyph below |
 * | (2) interventions are drawn | `annotations` → vertical rules and shaded ranges |
 * | (3) gaps are gaps | `linePath` starts a new subpath at every `null` |
 * | (4) confidence is visible | `bandPath`, plus a dashed stroke for projected points |
 * | (5) colour never encodes valence | every stroke is `--color-data-N`, chosen by the series' fixed slot |
 * | (6) every chart has a table | `ChartFrame` |
 * | (7) readable at 360px | measured width, real pixels, margins budgeted at the narrow case |
 */

export type TrendChartProps = {
  readonly title: string;
  readonly description?: string;
  readonly data: ChartData;
  readonly height?: number;
  /** Rendered under the plot. Use it for `TREND_CAVEAT` (§P5). */
  readonly caveat?: string;
  readonly className?: string;
};

export function TrendChart({
  title,
  description,
  data,
  height = 220,
  caveat,
  className,
}: TrendChartProps): ReactNode {
  return (
    <ChartFrame
      form="trend"
      title={title}
      {...(description === undefined ? {} : { description })}
      data={data}
      height={height}
      {...(className === undefined ? {} : { className })}
    >
      <TrendPlot data={data} height={height} {...(caveat === undefined ? {} : { caveat })} />
    </ChartFrame>
  );
}

/** Points before dots become clutter rather than information. */
const MAX_DOTS = 24;

function TrendPlot({
  data,
  height,
  caveat,
}: {
  readonly data: ChartData;
  readonly height: number;
  readonly caveat?: string;
}): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const width = useElementWidth(container);
  const [activeDay, setActiveDay] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const box = plotBox(width, height);
    const yDomain = resolveYDomain(data.series, data.yAxis);
    const xDomain = resolveXDomain(data.series);
    const x = linearScale(xDomain, box.left, box.left + box.width);
    // Inverted: SVG's y grows downward and the axis does not.
    const y = linearScale(yDomain, box.top + box.height, box.top);

    const days = [
      ...new Set(
        data.series.flatMap((series) =>
          series.points.flatMap((point) => {
            const index = dayIndex(point.at);
            return index === null ? [] : [index];
          }),
        ),
      ),
    ].sort((a, b) => a - b);

    return { box, yDomain, xDomain, x, y, days };
  }, [data, width, height]);

  const { box, yDomain, xDomain, x, y, days } = geometry;

  /*
   * Annotations that fall inside the plotted window, numbered in date order.
   *
   * Filtered *before* numbering so the flag on the plot and the entry in the
   * key below always carry the same number. Numbering the full list and then
   * filtering would leave the chart showing "2" with no "1" anywhere.
   */
  const visibleAnnotations = (data.annotations ?? [])
    .filter((annotation) => {
      const start = dayIndex(annotation.at);
      if (start === null) return false;
      if (annotation.kind === 'range') return true;
      return start >= xDomain.min && start <= xDomain.max;
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const onPointer = (event: PointerEvent<SVGSVGElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;

    let nearest: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const day of days) {
      const distance = Math.abs(x(day) - pointerX);
      if (distance < best) {
        best = distance;
        nearest = day;
      }
    }
    setActiveDay(nearest);
  };

  return (
    <div className="nos-plot" ref={container}>
      <svg
        className="nos-plot__svg"
        width={width}
        height={height}
        role="img"
        // The plot is a picture of the table below it. Screen readers get the
        // table (§8.9(6)); duplicating every point here would be worse, not
        // better — a hundred unlabelled numbers in reading order.
        aria-label={`${String(data.series.length)} series. The data table below carries the values.`}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => {
          setActiveDay(null);
        }}
      >
        {/* Grid and y ticks. Recessive: the data is the foreground. */}
        {yDomain.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={box.left}
              x2={box.left + box.width}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={box.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="nos-plot__tick"
            >
              {formatTick(tick, yDomain.step)}
            </text>
          </g>
        ))}

        {/* x ticks */}
        {xDomain.ticks.map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={box.top + box.height + 14}
            textAnchor={tick === xDomain.min ? 'start' : tick === xDomain.max ? 'end' : 'middle'}
            className="nos-plot__tick"
          >
            {axisLabel(tick, xDomain.spansYears)}
          </text>
        ))}

        {/*
          §8.9(2). Interventions are drawn, not merely listed: "a mood chart
          without the 'started Escitalopram' marker is actively misleading."
          A range renders as a shaded span, an instant as a rule.
        */}
        {visibleAnnotations.map((annotation, index) => {
          const start = dayIndex(annotation.at) ?? 0;
          const end = annotation.until === undefined ? null : dayIndex(annotation.until);

          if (annotation.kind === 'range' && end !== null) {
            const from = Math.max(x(Math.max(start, xDomain.min)), box.left);
            const to = Math.min(x(Math.min(end, xDomain.max)), box.left + box.width);
            return (
              <rect
                key={annotation.id}
                x={from}
                y={box.top}
                width={Math.max(0, to - from)}
                height={box.height}
                fill="var(--chart-annotation)"
                opacity={0.12}
              />
            );
          }

          return (
            <g key={annotation.id}>
              <line
                x1={x(start)}
                x2={x(start)}
                y1={box.top}
                y2={box.top + box.height}
                stroke="var(--chart-annotation)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {/*
                A numbered flag rather than the label itself.
                §4.7 requires the marker to *say* what it is — "a mood trend
                without a 'started Escitalopram' marker is a misleading chart" —
                and an unlabelled dashed line says nothing. But at 360px (§8.9(7))
                two labels a fortnight apart overlap into illegibility, so the
                number goes on the plot and the words go in the key below it,
                where they can wrap.
              */}
              <circle cx={x(start)} cy={box.top + 6} r={7} fill="var(--chart-annotation)" />
              <text
                x={x(start)}
                y={box.top + 6}
                textAnchor="middle"
                dominantBaseline="central"
                className="nos-plot__marker-number"
              >
                {String(index + 1)}
              </text>
            </g>
          );
        })}

        {/* Bands first, so a line is never hidden by its own confidence. */}
        {data.series.map((series) => {
          const path = bandPath(series.points, x, y);
          if (path === '') return null;
          return (
            <path
              key={`band-${series.id}`}
              d={path}
              fill={seriesColorVar(series.slot)}
              opacity={0.15}
              stroke="none"
            />
          );
        })}

        {data.series.map((series) => (
          <SeriesLine key={series.id} series={series} x={x} y={y} />
        ))}

        {/* The crosshair. Drawn last, so it is never behind a band. */}
        {activeDay !== null && (
          <line
            x1={x(activeDay)}
            x2={x(activeDay)}
            y1={box.top}
            y2={box.top + box.height}
            stroke="var(--chart-axis)"
            strokeWidth={1}
          />
        )}

        {/*
          The axis-break glyph (§8.9(1)).
          The badge above the plot is the primary signal — a glyph is what
          everyone misses — but a truncated axis should also *look* truncated at
          the point it is truncated.
        */}
        {yDomain.isTruncated && (
          <path
            d={`M${String(box.left - 4)} ${String(box.top + box.height - 2)} l4 -4 l-4 -4`}
            fill="none"
            stroke="var(--chart-axis)"
            strokeWidth={1.5}
          />
        )}
      </svg>

      {activeDay !== null && <Readout day={activeDay} series={data.series} unit={data.yAxis.unit} />}

      {visibleAnnotations.length > 0 && (
        <ol className="nos-plot__markers">
          {visibleAnnotations.map((annotation, index) => (
            <li key={annotation.id} className="nos-plot__marker">
              <span className="nos-plot__marker-badge" aria-hidden="true">
                {String(index + 1)}
              </span>
              <Text role="caption" tone="secondary" as="span">
                {annotation.label} · {annotation.at}
              </Text>
            </li>
          ))}
        </ol>
      )}

      {caveat !== undefined && (
        <Text role="caption" tone="tertiary" className="nos-plot__caveat">
          {caveat}
        </Text>
      )}
    </div>
  );
}

function SeriesLine({
  series,
  x,
  y,
}: {
  readonly series: Series;
  readonly x: (value: number) => number;
  readonly y: (value: number) => number;
}): ReactNode {
  const colour = seriesColorVar(series.slot);
  const placed = placePoints(series.points, x, y);

  /*
   * Measured and projected points are drawn as separate paths.
   *
   * §8.9(4): "A projection is rendered dashed with an interval." Splitting at
   * the boundary — and repeating the last measured point at the head of the
   * dashed run — makes the two meet without a visible seam, while keeping the
   * dash pattern strictly on the invented half.
   */
  const measured = placed.map((item) => (item?.point.isProjection === true ? null : item));
  const firstProjection = placed.findIndex((item) => item?.point.isProjection === true);
  const projected = placed.map((item, index) =>
    item?.point.isProjection === true || (firstProjection > 0 && index === firstProjection - 1) ? item : null,
  );

  const dots = placed.filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <g>
      <path d={linePath(measured)} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" />
      {firstProjection !== -1 && (
        <path
          d={linePath(projected)}
          fill="none"
          stroke={colour}
          strokeWidth={2}
          strokeDasharray="4 4"
          strokeLinejoin="round"
        />
      )}
      {dots.length <= MAX_DOTS &&
        dots.map((item) => (
          <circle
            key={`${series.id}-${item.point.at}`}
            cx={item.x}
            cy={item.y}
            r={4}
            fill={colour}
            // A 2px ring in the surface colour, so overlapping marks stay
            // countable rather than merging into a blob.
            stroke="var(--color-surface-raised)"
            strokeWidth={2}
          />
        ))}
    </g>
  );
}

/**
 * The value readout for the scrubbed day.
 *
 * A fixed strip rather than a floating tooltip, and that is a mobile decision:
 * a tooltip anchored to the touch point is under the finger that summoned it.
 * The strip sits above the plot, stays put, and is legible while scrubbing.
 */
function Readout({
  day,
  series,
  unit,
}: {
  readonly day: number;
  readonly series: readonly Series[];
  readonly unit: string | undefined;
}): ReactNode {
  const dayKey = dayKeyOf(day);

  return (
    <div className="nos-plot__readout" aria-live="off">
      <Text role="caption" tone="secondary" as="span">
        {axisLabel(day, true)}
      </Text>
      {series.map((one) => {
        const point = one.points.find((candidate) => candidate.at === dayKey);
        return (
          <span key={one.id} className="nos-plot__readout-item">
            <span
              className="nos-chart__swatch"
              style={{ background: seriesColorVar(one.slot) }}
              aria-hidden="true"
            />
            <Text role="caption" as="span">
              {/* An em dash for a gap, never a zero (§8.9(3)). */}
              {point?.value ?? '—'}
              {point?.value !== null && point?.value !== undefined ? ` ${one.unit ?? unit ?? ''}` : ''}
            </Text>
          </span>
        );
      })}
    </div>
  );
}

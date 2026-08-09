'use client';

import { type ReactNode } from 'react';

import { ChartFrame } from './ChartFrame';
import { dayIndex, dayKeyOf, monthLabel, weekStartIndex } from './calendar';
import type { ChartData } from './types';

/**
 * The calendar heatmap — §8.9's answer to "did I do the thing, on which days?"
 *
 * ## Why this is the one chart that must be exactly right about absence
 *
 * Every other chart in the system can show a gap by breaking a line. This one's
 * entire subject *is* the gaps, so it has to distinguish three states that a
 * naive implementation collapses into two:
 *
 * | State | Rendered as | Why it matters |
 * |---|---|---|
 * | Recorded, with a value | a filled cell, shaded by magnitude | the thing happened |
 * | Recorded, value zero | a filled cell at the lowest step | a session of zero volume is not a rest day |
 * | Not recorded | an empty cell | absence of evidence, not evidence of absence |
 * | Outside the range | nothing at all | a future Tuesday is not a missed Tuesday |
 *
 * The third and fourth are the ones that get conflated, and the consequence is
 * a grid that shows a wall of failure for the days before the operator started
 * using the system. §9.2 makes the same point about medication adherence: "a
 * day with no record is not counted as a missed dose — absence of data is not
 * evidence of non-adherence, and conflating them makes every figure quietly
 * wrong."
 *
 * ## The sequential ramp
 *
 * §8.9(5) and the dataviz rule: magnitude takes a *sequential* palette — one
 * hue, light to dark — never a categorical one and never a rainbow. There is no
 * sequential ramp in the token set, so the steps are mixed from the single
 * categorical hue toward the chart surface in OKLab (`components.css`). Mixing
 * toward the surface makes lightness monotone **by construction**, which is the
 * property a sequential scale has to have and the one an eyeballed ramp usually
 * lacks. It also inverts correctly in dark mode with no second palette, because
 * the surface it mixes toward is the one in force.
 */

export type AdherenceGridProps = {
  readonly title: string;
  readonly description?: string;
  /**
   * One series. Its points are the recorded days; `value` drives the shade.
   *
   * A binary "did it happen" grid passes `1` for every recorded day and gets a
   * single shade, which is correct: there is no magnitude to encode.
   */
  readonly data: ChartData;
  /** Inclusive range. Days outside it are not drawn at all. */
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly className?: string;
};

/** Steps in the sequential ramp, excluding "recorded but zero". */
const LEVELS = 4;

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function AdherenceGrid({
  title,
  description,
  data,
  fromDayKey,
  toDayKey,
  className,
}: AdherenceGridProps): ReactNode {
  return (
    <ChartFrame
      form="adherence-grid"
      title={title}
      {...(description === undefined ? {} : { description })}
      data={data}
      {...(className === undefined ? {} : { className })}
    >
      <Grid data={data} fromDayKey={fromDayKey} toDayKey={toDayKey} />
    </ChartFrame>
  );
}

function Grid({
  data,
  fromDayKey,
  toDayKey,
}: {
  readonly data: ChartData;
  readonly fromDayKey: string;
  readonly toDayKey: string;
}): ReactNode {
  const from = dayIndex(fromDayKey);
  const to = dayIndex(toDayKey);
  if (from === null || to === null || to < from) return null;

  const series = data.series[0];
  const values = new Map<number, number>();
  let max = 0;

  for (const point of series?.points ?? []) {
    const index = dayIndex(point.at);
    if (index === null || point.value === null) continue;
    values.set(index, point.value);
    if (point.value > max) max = point.value;
  }

  /*
   * Weeks run as columns and weekdays as rows, so a "Tuesdays are the problem"
   * pattern reads along a row. The alternative — days flowing left to right —
   * hides weekday patterns entirely, and weekday patterns are most of what
   * training adherence actually has.
   */
  const firstColumn = weekStartIndex(from);
  const lastColumn = weekStartIndex(to);
  const columns = Math.floor((lastColumn - firstColumn) / 7) + 1;

  const months: { column: number; label: string }[] = [];
  for (let column = 0; column < columns; column += 1) {
    const monday = firstColumn + column * 7;
    const label = monthLabel(monday);
    // Label a month once, at the first column that contains it.
    if (months.at(-1)?.label !== label) months.push({ column, label });
  }

  return (
    <div className="nos-grid" role="group" aria-label="Adherence calendar">
      <div className="nos-grid__months">
        {months.map((month) => (
          <span
            key={month.label}
            className="nos-grid__month"
            style={{ gridColumnStart: month.column + 2 }}
          >
            {month.label.slice(0, 3)}
          </span>
        ))}
      </div>

      <div className="nos-grid__body" style={{ gridTemplateColumns: `auto repeat(${String(columns)}, 1fr)` }}>
        {WEEKDAY_INITIALS.map((initial, weekday) => (
          <Row
            key={weekday}
            initial={initial}
            weekday={weekday + 1}
            firstColumn={firstColumn}
            columns={columns}
            from={from}
            to={to}
            values={values}
            max={max}
            unit={series?.unit}
          />
        ))}
      </div>

      <Legend max={max} unit={series?.unit} />
    </div>
  );
}

function Row({
  initial,
  weekday,
  firstColumn,
  columns,
  from,
  to,
  values,
  max,
  unit,
}: {
  readonly initial: string;
  readonly weekday: number;
  readonly firstColumn: number;
  readonly columns: number;
  readonly from: number;
  readonly to: number;
  readonly values: ReadonlyMap<number, number>;
  readonly max: number;
  readonly unit: string | undefined;
}): ReactNode {
  return (
    <>
      {/* Only alternate rows are labelled — seven initials at 360px is a wall
          of letters, and M/W/F is enough to orient by. */}
      <span className="nos-grid__weekday" aria-hidden="true">
        {weekday % 2 === 1 ? initial : ''}
      </span>

      {Array.from({ length: columns }, (_, column) => {
        const day = firstColumn + column * 7 + (weekday - 1);

        // Outside the requested range. Drawn as nothing, not as a missed day:
        // a future Tuesday has not been missed.
        if (day < from || day > to) {
          return <span key={column} className="nos-grid__cell nos-grid__cell--out" aria-hidden="true" />;
        }

        const value = values.get(day);
        const level = levelFor(value, max);
        const dayKey = dayKeyOf(day);

        return (
          <span
            key={column}
            className={`nos-grid__cell nos-grid__cell--${String(level)}`}
            // The accessible name is the whole of this cell's information, and
            // it says "no record" rather than "0" for an absent day.
            title={`${dayKey}: ${value === undefined ? 'no record' : `${String(value)}${unit === undefined ? '' : ` ${unit}`}`}`}
          >
            <span className="nos-visually-hidden">
              {dayKey}: {value === undefined ? 'no record' : String(value)}
            </span>
          </span>
        );
      })}
    </>
  );
}

/**
 * Map a value to a shade.
 *
 * `undefined` — no record — is level 0. A *recorded* zero is level 1, the
 * palest filled step, because it happened. That one-line distinction is the
 * whole reason this function exists rather than an inline ternary.
 */
export function levelFor(value: number | undefined, max: number): number {
  if (value === undefined) return 0;
  if (max <= 0 || value <= 0) return 1;
  return Math.min(LEVELS, Math.max(1, Math.ceil((value / max) * LEVELS)));
}

function Legend({ max, unit }: { readonly max: number; readonly unit: string | undefined }): ReactNode {
  return (
    <div className="nos-grid__legend">
      <span className="nos-grid__legend-label">None</span>
      {Array.from({ length: LEVELS + 1 }, (_, level) => (
        <span key={level} className={`nos-grid__cell nos-grid__cell--${String(level)}`} aria-hidden="true" />
      ))}
      <span className="nos-grid__legend-label">
        {max > 0 ? `${String(Math.round(max))}${unit === undefined ? '' : ` ${unit}`}` : 'Logged'}
      </span>
    </div>
  );
}

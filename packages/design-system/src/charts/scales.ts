/**
 * Scales, ticks and path geometry — the arithmetic behind every plot.
 *
 * Separated from the components so it can be tested without a DOM, which is
 * what makes §8.9's invariants checkable rather than merely intended. The
 * riskiest one lives here:
 *
 *   §8.9(1) "A weight chart from 74–76 kg is legitimate and useful, and it is
 *   also visually dramatic. The axis break is explicitly marked. **An
 *   unlabelled truncated axis is a lie told in a health application.**"
 *
 * {@link resolveYDomain} is where that is decided, and it cannot truncate
 * without saying so: the returned domain carries `isTruncated`, and every
 * renderer draws the break from that flag rather than from a prop somebody
 * might forget to pass.
 */

import { dayIndex } from './calendar';
import type { AxisConfig, Series, SeriesPoint } from './types';

export type Extent = { readonly min: number; readonly max: number };

/** The plot area, once margins are removed. */
export type PlotBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Margins, in pixels, at the smallest supported width.
 *
 * §8.9(7): "Charts are readable at 360px wide. Mobile is not a degraded case;
 * it is the common case." Forty-two pixels of gutter is enough for `1,250` in
 * the caption size and no more than that — every pixel here is taken from the
 * plot.
 */
export const PLOT_MARGIN = Object.freeze({ left: 42, right: 10, top: 10, bottom: 22 });

export function plotBox(width: number, height: number): PlotBox {
  return {
    left: PLOT_MARGIN.left,
    top: PLOT_MARGIN.top,
    width: Math.max(1, width - PLOT_MARGIN.left - PLOT_MARGIN.right),
    height: Math.max(1, height - PLOT_MARGIN.top - PLOT_MARGIN.bottom),
  };
}

/* -------------------------------------------------------------------------
 * Extents
 * ---------------------------------------------------------------------- */

/**
 * The numeric range the data actually occupies.
 *
 * Includes band bounds, because a confidence band drawn outside the axis is a
 * band the reader will believe is narrower than it is.
 */
export function dataExtent(series: readonly Series[]): Extent | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const one of series) {
    for (const point of one.points) {
      for (const value of [point.value, point.lower, point.upper]) {
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
  }

  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export type YDomain = Extent & {
  /** True when the axis does not start at zero. The renderer must mark it. */
  readonly isTruncated: boolean;
  readonly ticks: readonly number[];
  readonly step: number;
};

/**
 * The y domain, its ticks, and whether it lies about starting at zero.
 *
 * `zeroBaseline: true` extends the domain to include zero. `false` fits the
 * data and sets `isTruncated`, which is the only way to get a truncated axis
 * out of this function — there is deliberately no third option that truncates
 * quietly.
 */
export function resolveYDomain(series: readonly Series[], axis: AxisConfig, tickCount = 4): YDomain {
  const extent = dataExtent(series) ?? { min: 0, max: 1 };

  let min = axis.min ?? extent.min;
  let max = axis.max ?? extent.max;

  if (axis.zeroBaseline) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  // A flat series has no range, and dividing by it produces a chart of NaN.
  // Padding by a unit puts the line in the middle of a legible axis.
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const step = niceStep((max - min) / Math.max(1, tickCount));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  return {
    min: niceMin,
    max: niceMax,
    // Truncated when the axis genuinely excludes zero. A domain that happens to
    // contain zero is not a truncation however it was configured, and badging it
    // as one would make the warning meaningless through repetition.
    isTruncated: niceMin > 0 || niceMax < 0,
    ticks: ticksBetween(niceMin, niceMax, step),
    step,
  };
}

/**
 * Round a raw step up to something a person reads without effort.
 *
 * 1, 2, 2.5, 5 or 10 times a power of ten. `2.5` is included because weight in
 * kilograms and plate maths both land on it constantly, and without it a 74–76
 * axis gets steps of 2 and shows two labels.
 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;

  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function ticksBetween(min: number, max: number, step: number): readonly number[] {
  const ticks: number[] = [];
  // Integer counting rather than repeated addition: `0.1 + 0.1 + 0.1` drifts,
  // and a drifted tick renders as `0.30000000000000004`.
  const count = Math.round((max - min) / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(round(min + index * step, step));
  }
  return ticks;
}

/** Round to the step's own precision, so a tick never shows float noise. */
function round(value: number, step: number): number {
  const places = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(Math.min(places, 10)));
}

/**
 * Decimal places the step itself carries.
 *
 * Derived from the step's digits rather than from its magnitude, and the
 * difference is a real defect rather than a nicety: a step of `2.5` is `>= 1`,
 * so a magnitude test gives it zero decimal places — and the axis then labels
 * 72.5, 75, 77.5 as **73, 75, 78**. Three ticks, two of them wrong, on a
 * bodyweight chart. `2.5` is the step a 74–79 kg axis actually picks.
 */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;

  let text = step.toPrecision(12);
  // Exponential form only happens far outside any axis this system draws;
  // falling back to zero places is safer than parsing it.
  if (text.includes('e')) return 0;
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');

  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

/** A tick label at the axis's own precision, with thousands separated. */
export function formatTick(value: number, step: number): string {
  const places = stepDecimals(step);
  return value.toLocaleString('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places });
}

/* -------------------------------------------------------------------------
 * The x axis — day keys, never instants
 * ---------------------------------------------------------------------- */

export type XDomain = {
  readonly min: number;
  readonly max: number;
  /** Day indices to label. */
  readonly ticks: readonly number[];
  /** True when the range crosses a year, so labels must carry one. */
  readonly spansYears: boolean;
};

/**
 * The day range the series occupy.
 *
 * Every `at` is a day key resolved in the observer's zone by `core` — see
 * `calendar.ts` for why the renderer must never do that resolution itself.
 * Points whose key is not a real date are ignored rather than placed at zero,
 * which would drag the axis back to 1970.
 */
export function resolveXDomain(series: readonly Series[], maxTicks = 4): XDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const one of series) {
    for (const point of one.points) {
      const index = dayIndex(point.at);
      if (index === null) continue;
      if (index < min) min = index;
      if (index > max) max = index;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [], spansYears: false };
  if (min === max) max = min + 1;

  const span = max - min;
  const count = Math.max(1, Math.min(maxTicks, Math.floor(span / 7) + 1));
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Math.round(min + (span * index) / count));
  }

  return {
    min,
    max,
    ticks: [...new Set(ticks)],
    // Crossing a year is the one case where `17 Aug` is genuinely ambiguous.
    spansYears: Math.floor(min / 365) !== Math.floor(max / 365),
  };
}

/* -------------------------------------------------------------------------
 * Scales and paths
 * ---------------------------------------------------------------------- */

export type Scale = (value: number) => number;

export function linearScale(domain: Extent, from: number, to: number): Scale {
  const span = domain.max - domain.min;
  if (span === 0) return () => (from + to) / 2;
  return (value) => from + ((value - domain.min) / span) * (to - from);
}

/** One resolved point, ready to draw. */
export type PlacedPoint = {
  readonly x: number;
  readonly y: number;
  readonly point: SeriesPoint;
};

export function placePoints(
  points: readonly SeriesPoint[],
  x: Scale,
  y: Scale,
): readonly (PlacedPoint | null)[] {
  return points.map((point) => {
    const index = dayIndex(point.at);
    if (index === null || point.value === null || !Number.isFinite(point.value)) return null;
    return { x: x(index), y: y(point.value), point };
  });
}

/**
 * An SVG path for a line, **broken at every gap**.
 *
 * §8.9(3): "Missing data is shown as missing. Gaps are gaps. Lines break.
 * Interpolation across a week of no data is fabrication." A `null` value starts
 * a new subpath rather than being skipped over, which is the difference between
 * a line that stops and a line that quietly draws through a fortnight nobody
 * weighed themselves in.
 */
export function linePath(placed: readonly (PlacedPoint | null)[]): string {
  let path = '';
  let pen: 'up' | 'down' = 'up';

  for (const item of placed) {
    if (item === null) {
      pen = 'up';
      continue;
    }
    path += `${pen === 'up' ? 'M' : 'L'}${item.x.toFixed(2)} ${item.y.toFixed(2)} `;
    pen = 'down';
  }

  return path.trim();
}

/**
 * A filled band between `lower` and `upper`, also broken at every gap.
 *
 * Each contiguous run becomes its own closed shape. One polygon spanning a gap
 * would render as a solid block across the missing fortnight — the same lie as
 * an interpolated line, drawn larger.
 */
export function bandPath(
  points: readonly SeriesPoint[],
  x: Scale,
  y: Scale,
): string {
  const runs: { readonly x: number; readonly lower: number; readonly upper: number }[][] = [];
  let current: { x: number; lower: number; upper: number }[] = [];

  for (const point of points) {
    const index = dayIndex(point.at);
    const hasBand =
      index !== null &&
      point.lower !== undefined &&
      point.upper !== undefined &&
      Number.isFinite(point.lower) &&
      Number.isFinite(point.upper);

    if (!hasBand) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }

    current.push({ x: x(index), lower: y(point.lower ?? 0), upper: y(point.upper ?? 0) });
  }
  if (current.length > 0) runs.push(current);

  return runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const top = run.map((item, position) => `${position === 0 ? 'M' : 'L'}${item.x.toFixed(2)} ${item.upper.toFixed(2)}`);
      const bottom = [...run]
        .reverse()
        .map((item) => `L${item.x.toFixed(2)} ${item.lower.toFixed(2)}`);
      return `${top.join(' ')} ${bottom.join(' ')} Z`;
    })
    .join(' ');
}

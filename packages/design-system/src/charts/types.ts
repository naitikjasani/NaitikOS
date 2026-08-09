/**
 * The normalised series shape every chart accepts.
 *
 * ## A recorded conflict between §8.9 and §6.2
 *
 * §8.9 says the chart components "accept a normalised series shape defined in
 * `core`". That is not possible under the layering rules: §6.2 and the
 * boundary lint config restrict this package to `shared` and forbid it from
 * importing `core` at all, precisely so the design system "renders values; it
 * does not know what a medication is".
 *
 * Resolved in favour of the boundary. The shape lives here, and it is defined
 * in terms a renderer understands — points, units, gaps — with no domain
 * vocabulary. A feature maps its observations into it. If it lived in `core`,
 * `core` would acquire a presentation type and the durable layer would start
 * knowing about axes.
 *
 * The practical difference is nil: one type in one place, imported by both
 * sides. The architectural difference is that `core` stays clean.
 */

/**
 * One observation in a series.
 *
 * `value: null` is a **gap, not a zero.** §8.9(3): "Missing data is shown as
 * missing. Gaps are gaps. Lines break. Interpolation across a week of no data
 * is fabrication." The renderer must break the line here.
 */
export type SeriesPoint = {
  /**
   * A day key, `YYYY-MM-DD`, **already resolved in the observer's zone**.
   *
   * Not an instant, and the difference is load-bearing. §5.3 requires a day to
   * be the day in the zone the observation was captured in; a renderer handed
   * an instant would re-derive that in the *runtime's* zone, which files every
   * Indian evening under the following date. `core`'s `dailyRollup` does the
   * resolution, and the chart layer then contains no temporal logic at all —
   * only integer arithmetic on calendar days (`charts/calendar.ts`).
   */
  readonly at: string;
  readonly value: number | null;
  /**
   * Optional band around the value.
   *
   * §8.9(4): "Confidence must be visible where it exists. Trend lines carry a
   * band. A projection is rendered dashed with an interval." A point with a
   * band renders the band; the renderer never invents one.
   */
  readonly lower?: number;
  readonly upper?: number;
  /** True for projected points, which render dashed (§8.9(4)). */
  readonly isProjection?: boolean;
};

/**
 * A named series.
 *
 * `slot` fixes the colour. §8.9(5) and the dataviz rule both require colour to
 * follow the *entity*, never its rank — so a filter that removes one series
 * must not repaint the others. Assigning by array index would do exactly that.
 */
export type Series = {
  readonly id: string;
  readonly label: string;
  /** Categorical slot, 1–8. Fixed per entity for the life of the chart. */
  readonly slot: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly unit?: string;
  readonly points: readonly SeriesPoint[];
};

/**
 * A vertical marker on a time axis.
 *
 * §8.9(2) makes these mandatory rather than optional: "Every time-series chart
 * renders medication starts and stops, treatment courses, and travel as
 * vertical markers. **A mood chart without the 'started Escitalopram' marker is
 * actively misleading.**"
 */
export type Annotation = {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  /** `point` for an instant, `range` for a course with an end. */
  readonly kind: 'point' | 'range';
  readonly until?: string;
};

/**
 * Axis configuration.
 *
 * `zeroBaseline: false` is legitimate and dangerous, so it is explicit.
 * §8.9(1): "A weight chart from 74–76 kg is legitimate and useful, and it is
 * also visually dramatic. The axis break is explicitly marked. **An unlabelled
 * truncated axis is a lie told in a health application.**"
 *
 * The renderer must draw the break indicator whenever this is false. It is not
 * a styling preference.
 */
export type AxisConfig = {
  readonly label?: string;
  readonly unit?: string;
  /** When false, the renderer MUST mark the truncation. */
  readonly zeroBaseline: boolean;
  readonly min?: number;
  readonly max?: number;
};

/** Everything a chart needs, independent of which chart it is. */
export type ChartData = {
  readonly series: readonly Series[];
  readonly annotations?: readonly Annotation[];
  readonly xAxis?: AxisConfig;
  readonly yAxis: AxisConfig;
};

/**
 * The prescribed chart forms.
 *
 * §8.9: "Chart selection is prescribed, not chosen per-instance." The union is
 * the enforcement — there is no `pie`, because §8.9 says composition is "Stacked
 * bar — **never a pie**".
 */
export type ChartForm =
  | 'trend'
  | 'bar'
  | 'adherence-grid'
  | 'scatter'
  | 'stacked-bar'
  | 'small-multiples';

/** Which question each form answers, per §8.9's selection table. */
export const CHART_FORM_QUESTION: Readonly<Record<ChartForm, string>> = Object.freeze({
  trend: 'How has one metric moved over time?',
  bar: 'How much of something, per period?',
  'adherence-grid': 'Did I do the thing, on which days?',
  scatter: 'How do two metrics relate?',
  'stacked-bar': 'What is the composition of a total?',
  'small-multiples': 'How does now compare to then?',
});

/** Maximum series before folding to "Other" or faceting (dataviz rule). */
export const MAX_CATEGORICAL_SERIES = 8;

/**
 * Series cap for all-pairs forms.
 *
 * The dataviz validator's finding, recorded because it is not intuitive: only
 * the first three slots clear the separation floors when *every* pair can
 * appear adjacent, which is the case for scatter, bubble, and small multiples.
 * Past three, fold to "Other" or facet.
 */
export const MAX_ALL_PAIRS_SERIES = 3;

/** Forms where any two series can appear adjacent. */
export const ALL_PAIRS_FORMS: readonly ChartForm[] = Object.freeze(['scatter', 'small-multiples']);

/** The CSS variable for a categorical slot. Theme-aware by construction. */
export function seriesColorVar(slot: Series['slot']): string {
  return `var(--color-data-${String(slot)})`;
}

/**
 * Validate a chart's configuration against §8.9's invariants.
 *
 * Returns human-readable violations rather than throwing, so a development
 * build can render the chart *and* the complaint — a chart that fails to render
 * teaches nothing, while a chart with "y-axis is truncated without a marker"
 * beneath it teaches the rule.
 */
export function validateChartData(form: ChartForm, data: ChartData): readonly string[] {
  const problems: string[] = [];

  if (data.series.length > MAX_CATEGORICAL_SERIES) {
    problems.push(
      `${String(data.series.length)} series exceeds the ${String(MAX_CATEGORICAL_SERIES)}-slot palette. Fold the tail into "Other" or facet.`,
    );
  }

  if (ALL_PAIRS_FORMS.includes(form) && data.series.length > MAX_ALL_PAIRS_SERIES) {
    problems.push(
      `${form} lets any two series sit adjacent, so it caps at ${String(MAX_ALL_PAIRS_SERIES)} series for colour separation. Facet instead.`,
    );
  }

  const slots = data.series.map((s) => s.slot);
  if (new Set(slots).size !== slots.length) {
    problems.push('Two series share a categorical slot; they will render in the same colour.');
  }

  // §8.9(1). The renderer marks the break; this catches a caller who truncated
  // without saying so.
  if (!data.yAxis.zeroBaseline && data.yAxis.min === undefined) {
    problems.push(
      'yAxis.zeroBaseline is false but no explicit min is set — the truncation cannot be marked accurately.',
    );
  }

  return problems;
}

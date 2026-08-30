/**
 * §10.4's "structured summaries beat raw rows".
 *
 *   "Ninety days of mood observations should reach the model as *'mean 3.4, sd
 *    0.8, trend −0.02/day, 6 days missing, 3 values below 2 clustered in week
 *    7'* — not as ninety rows. It is more informative, an order of magnitude
 *    cheaper, and **it prevents the model from doing arithmetic**, which is
 *    exactly what §10.0 forbids."
 *
 * That third reason is the one that matters. The first two are economics; the
 * third is the governing constraint. Ninety rows in a prompt is ninety rows a
 * model can average, and a model that averages has computed — which it must
 * never do, because nothing downstream can tell a computed number from a
 * retrieved one once it is prose.
 *
 * ## The arithmetic happens here, in TypeScript, over exact inputs
 *
 * Every figure in a {@link SeriesSummary} was computed by this file from rows
 * the database returned. The model receives the result and the reference; it
 * never receives the operands.
 *
 * ## Missing days are counted, not filled
 *
 * §8.9(3) is a charting rule that is really an epistemics rule. "6 days
 * missing" is information — it says the operator did not log — and a summary
 * that interpolated them would report a mean over days that never happened.
 */

/** A daily value, already rolled up in the observer's zone (§5.3). */
export type DailyPoint = { readonly dayKey: string; readonly value: number };

export type SeriesSummary = {
  readonly metricKey: string;
  readonly label: string;
  readonly unit: string;

  readonly n: number;
  /** Days in the window with no value. Counted, never filled. */
  readonly missingDays: number;
  readonly windowDays: number;

  readonly mean: number;
  readonly sd: number;
  readonly min: number;
  readonly max: number;
  readonly latest: number;
  readonly latestDayKey: string;

  /** Units per day, from an ordinary least-squares fit. `null` below four points. */
  readonly trendPerDay: number | null;

  /**
   * One sentence, ready to drop into the volatile block.
   *
   * Assembled here rather than in the prompt template so the numbers and the
   * words that describe them cannot drift apart — a template that said "rising"
   * beside a negative slope is the exact failure this avoids.
   */
  readonly sentence: string;
};

/**
 * Summarise a daily series over a window.
 *
 * `windowDays` is passed in rather than inferred from the data, because the
 * interesting figure is how many days are *missing*, and a series that only
 * contains the days it has cannot know that.
 */
export function summariseSeries(input: {
  readonly metricKey: string;
  readonly label: string;
  readonly unit: string;
  readonly points: readonly DailyPoint[];
  readonly windowDays: number;
}): SeriesSummary | null {
  const points = [...input.points]
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const n = points.length;
  if (n === 0) return null;

  const values = points.map((point) => point.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;

  /* Sample standard deviation. `n − 1`, not `n`: this is a sample of days from
   * an ongoing life, not the population of them. At n = 1 it is 0 by
   * convention, which the sentence handles by not claiming a spread. */
  const variance = n < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  const last = points[n - 1];
  const trendPerDay = ordinaryLeastSquaresSlope(points);

  const summary: Omit<SeriesSummary, 'sentence'> = {
    metricKey: input.metricKey,
    label: input.label,
    unit: input.unit,
    n,
    missingDays: Math.max(0, input.windowDays - n),
    windowDays: input.windowDays,
    mean,
    sd,
    min: Math.min(...values),
    max: Math.max(...values),
    latest: last?.value ?? mean,
    latestDayKey: last?.dayKey ?? '',
    trendPerDay,
  };

  return { ...summary, sentence: sentenceFor(summary) };
}

/**
 * The slope, in units per day, over day *index* rather than calendar distance.
 *
 * Index, deliberately. Regressing on calendar distance would let a three-week
 * gap dominate the fit through leverage alone — one point far out on the x-axis
 * moves a line more than twenty clustered ones do, and in a series full of
 * unlogged stretches that is most of them. Index treats each recorded day as
 * one observation, which is what it is.
 *
 * `null` below four points, matching `core`'s `MIN_TREND_POINTS`. A line
 * through three points is a line through three points.
 */
function ordinaryLeastSquaresSlope(points: readonly DailyPoint[]): number | null {
  const n = points.length;
  if (n < 4) return null;

  const meanX = (n - 1) / 2;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const [index, point] of points.entries()) {
    const dx = index - meanX;
    covariance += dx * (point.value - meanY);
    variance += dx * dx;
  }

  return variance === 0 ? null : covariance / variance;
}

/**
 * The sentence.
 *
 * Neutral register throughout (§4.7): it reports a direction and a spread and
 * never a verdict. "Falling" is a fact about a slope; "worse" would be a
 * judgement about a life, and this system does not make those.
 */
function sentenceFor(summary: Omit<SeriesSummary, 'sentence'>): string {
  const parts: string[] = [
    `${summary.label}: mean ${round(summary.mean)} ${summary.unit} over ${String(summary.n)} recorded days`,
  ];

  if (summary.n >= 2) parts.push(`sd ${round(summary.sd)}`);
  if (summary.trendPerDay !== null) {
    const direction = summary.trendPerDay > 0 ? 'rising' : summary.trendPerDay < 0 ? 'falling' : 'flat';
    parts.push(`${direction} ${round(Math.abs(summary.trendPerDay))} ${summary.unit}/day`);
  }

  parts.push(`range ${round(summary.min)}–${round(summary.max)}`);
  parts.push(`latest ${round(summary.latest)} on ${summary.latestDayKey}`);

  /* Stated even when zero. "0 days missing" is a claim about completeness that
   * the reader would otherwise have to infer from an absence. */
  parts.push(`${String(summary.missingDays)} of ${String(summary.windowDays)} days not recorded`);

  return `${parts.join(', ')}.`;
}

function round(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  /* Two significant-ish decimals for small numbers, one for large. A slope of
   * −0.02/day is meaningless at zero decimals, and a mean of 2,847 kcal is
   * noise at three. */
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return value.toFixed(decimals);
}

/**
 * Roughly how many tokens a string costs.
 *
 * Four characters per token, which is the widely-used English approximation and
 * is close enough for a *budget* — the budget's job is to prevent a pack from
 * being twice the size it should be, not to predict billing to the token.
 *
 * Deliberately an over-estimate for prose with numbers in it, since digits
 * tokenise worse than letters. Over-estimating is the safe direction: the
 * failure mode of under-estimating is a truncated prompt, and §10.4 forbids
 * silent truncation specifically.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

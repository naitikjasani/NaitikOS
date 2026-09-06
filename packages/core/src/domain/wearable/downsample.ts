/**
 * The retention policy — §9.7's "full resolution for 90 days, then downsampled
 * to hourly aggregates and the raw rows dropped".
 *
 * This file owns the *decisions*: how long raw resolution is kept, where an
 * hour begins, and which aggregate each metric collapses to. It does not own
 * the arithmetic, and the reason is worth stating plainly, because a pure
 * `aggregate(values[])` function here would be the obvious thing to write.
 *
 * §9.7 sizes this table at "tens of millions" of rows. Streaming ninety-plus
 * days of those through Node in order to average them would move gigabytes
 * across the wire to compute a number Postgres computes in place, during a
 * nightly job that §5.2 requires stay boring. So `sampleRepository.downsample`
 * runs the `GROUP BY` in the database and only the aggregates come back; this
 * file tells it which aggregate to name.
 *
 * ## Why the loss is acceptable, and where it is not
 *
 * Dropping raw rows is irreversible, which sits uneasily beside P2's permanent
 * record. §9.7 makes the trade explicitly — device data's "value beyond 90 days
 * is entirely in its aggregates anyway" — and the honest reading is that a
 * heart-rate reading from a Tuesday afternoon three years ago carries no
 * information that its hourly mean does not.
 *
 * Two things keep that from becoming a quiet lie:
 *
 *   1. The aggregated row is marked {@link SAMPLE_DOWNSAMPLED_FLAG}, so a chart
 *      can say "hourly average" rather than implying a reading.
 *   2. §9.10's export runs before any of this matters, and it exports raw rows
 *      while they exist. The archive is where "forever" lives; this table is a
 *      working set.
 */

import type { MetricAggregation } from '../../observations/metric';
import { isoFromMillis, parseInstant } from '../../temporal/instant';

/** §9.7's ninety days, as a number so the nightly step and its test agree. */
export const SAMPLE_RETENTION_DAYS = 90;

/** The column that marks an aggregate, so nothing renders one as a reading. */
export const SAMPLE_DOWNSAMPLED_FLAG = 'isDownsampled';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/**
 * The instant before which raw rows are collapsed.
 *
 * Truncated to the hour, and that is load-bearing rather than tidy: the cutoff
 * is also a bucket boundary, so a run at 03:00 and a re-run at 03:47 collapse
 * exactly the same set. §5.2 requires the nightly job be "idempotent, safe to
 * re-run", and a cutoff carrying minutes would split one hour across two runs —
 * the second producing an aggregate over the handful of rows the first left
 * behind, and overwriting a correct number with a partial one.
 */
export function downsampleCutoff(nowIso: string, retentionDays: number = SAMPLE_RETENTION_DAYS): string {
  const now = parseInstant(nowIso);
  if (now === null) throw new Error(`downsampleCutoff needs an instant, got "${nowIso}"`);
  const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
  return isoFromMillis(Math.floor(cutoff / MS_PER_HOUR) * MS_PER_HOUR);
}

/**
 * UTC hours, not local ones.
 *
 * Everywhere else in this system a bucket is computed in the operator's zone,
 * because §5.3 insists a day is a local thing. An hour is not: it is the same
 * sixty minutes in every zone, and the offsets that make local days awkward —
 * including the thirty-minute ones this operator lives in — divide hours
 * evenly or shift them wholesale. Bucketing in UTC therefore loses nothing and
 * lets Postgres use `date_trunc('hour', ...)`, which is IMMUTABLE and indexable
 * where its local-day equivalent is neither. (The reasoning is the mirror of
 * the note on `observation_observed_at_idx`, which reaches the opposite
 * conclusion for days, for the same reason.)
 */
export function hourBucket(instantIso: string): string {
  const at = parseInstant(instantIso);
  if (at === null) throw new Error(`hourBucket needs an instant, got "${instantIso}"`);
  return isoFromMillis(Math.floor(at.getTime() / MS_PER_HOUR) * MS_PER_HOUR);
}

/**
 * A standard SQL aggregate name per domain aggregation.
 *
 * The two vocabularies are nearly the same and deliberately not identical.
 * `mean` becomes `avg` because that is what SQL calls it, and the three that do
 * not survive an hourly collapse are handled below rather than pretended into
 * existence.
 */
export type SampleAggregate = 'avg' | 'sum' | 'min' | 'max' | 'count';

/**
 * How a metric's samples collapse into one hourly row, or `null` if they must
 * not be collapsed at all.
 *
 * The three nulls are the interesting entries:
 *
 *   - `median` has no `GROUP BY`-friendly form that is cheap over tens of
 *     millions of rows, and no wearable metric is registered with it.
 *   - `last` would keep one arbitrary reading per hour and throw the rest away.
 *     That is not an aggregate, it is sampling, and it would make a chart look
 *     like full resolution while being a sixtieth of it.
 *   - `count` of a stream counts how often the *device chose to report*, which
 *     is a property of the firmware rather than of the body.
 *
 * A metric whose aggregation maps to `null` keeps its raw rows past ninety
 * days. That is the safe direction — the table grows, and growth is visible,
 * whereas a wrong collapse is not.
 */
export const SAMPLE_AGGREGATES: Readonly<Record<MetricAggregation, SampleAggregate | null>> = Object.freeze({
  mean: 'avg',
  sum: 'sum',
  min: 'min',
  max: 'max',
  median: null,
  last: null,
  count: null,
});

/** `null` when the metric's aggregation has no honest hourly collapse. */
export function aggregateFor(aggregation: MetricAggregation): SampleAggregate | null {
  return SAMPLE_AGGREGATES[aggregation];
}

/** The aggregations that survive downsampling, for the job's own logging. */
export function downsampleableAggregations(): readonly MetricAggregation[] {
  return (Object.keys(SAMPLE_AGGREGATES) as MetricAggregation[]).filter(
    (name) => SAMPLE_AGGREGATES[name] !== null,
  );
}

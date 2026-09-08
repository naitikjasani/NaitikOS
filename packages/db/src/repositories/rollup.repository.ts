/**
 * Metric rollups — the nightly step that writes `metric_rollup`, and the read
 * that every trend chart goes through instead of the observation log.
 *
 * §5.6 states the purpose: a rollup "turns a five-year trend chart into an index
 * scan over a few thousand rows instead of an aggregation over millions of
 * observations". §9.7 sizes the alternative. This file is the only writer, and
 * `refresh-rollups` in `JOB_STEPS` is the only caller that should be writing.
 *
 * ## What a rollup *is* is not decided here
 *
 * `core/derivation/rollup.ts` owns that, and it owns it because §9.2 makes the
 * combining rule a property of the metric rather than of the caller:
 *
 *   "Summing bodyweight over a week is nonsense and averaging training volume
 *    hides a taper; the registry is what stops a chart from doing either."
 *
 * So this file computes nothing. It reads the log, hands the rows to
 * `dailyBuckets` with the metric's own definition, and persists what comes back.
 * There is deliberately no aggregation SQL below — a `GROUP BY` here would be a
 * second implementation of the rule, free to disagree with the first, and the
 * disagreement would surface as a chart that is quietly wrong rather than as a
 * failure. The one aggregate expressed here is the week, and it is expressed by
 * calling `core`'s `aggregate` (see {@link weekBuckets}).
 *
 * ## Supersession is the correctness property, and it fails silently
 *
 * §9.1 makes the log append-only: a correction is a **new** observation, and the
 * old row survives forever with `superseded_by_id` pointing at its replacement.
 * A rollup that summed both rows would double-count the corrected reading, and
 * — this is the whole problem — the result would look entirely plausible. A
 * bodyweight corrected from 84 to 74 would roll up to 79, which is a number a
 * person might well weigh. Nothing would ever flag it.
 *
 * Hence `isNull(observation.supersededById)` on the read below, which mirrors
 * the `currentOnly` default in `observation.repository.ts`. `core`'s
 * `dailyRollup` documents this as the caller's responsibility precisely so the
 * filter is stated once, at the layer that knows the column exists.
 *
 * ## Why delete-then-insert rather than upsert
 *
 * §5.2 requires every nightly step be "idempotent, safe to re-run". Two designs
 * satisfy the *arithmetic*:
 *
 *   - `ON CONFLICT (metric_key, grain, bucket_start) DO UPDATE`, which cannot
 *     express a bucket that should cease to exist. Supersede the only
 *     observation on a Tuesday and that Tuesday has no value any more; an upsert
 *     leaves yesterday's row in place, permanently, and the chart shows a
 *     reading that has been retracted. That failure is invisible and permanent,
 *     which is the worst combination available.
 *   - DELETE the window, then INSERT what it now contains, in a transaction.
 *     A retracted bucket disappears, a half-written period is impossible, and a
 *     re-run over unchanged inputs produces the same rows.
 *
 * The second, therefore — but **as two ordered statements**, never folded into
 * one data-modifying CTE. `sample.repository.ts` records what that costs at
 * length and it applies here almost exactly: every statement inside a `WITH`
 * sees one snapshot, and `ON CONFLICT` arbitrates against a dirty snapshot in
 * which a row *this same command* deleted is still visible. Here the collision
 * is not an edge case on a boundary — it is the normal case, because a re-run
 * writes the identical natural key it just deleted. A combined statement would
 * conflict with the doomed row on every bucket, do nothing, and leave the period
 * empty. Two ordered statements avoid it because the INSERT takes its own
 * command snapshot and sees the DELETE.
 *
 * Note also what the INSERT does *not* carry: an `ON CONFLICT` clause. That is
 * the point. If the reasoning above is ever wrong, a duplicate raises 23505 and
 * the nightly run fails loudly, rather than absorbing the conflict and leaving a
 * stale bucket behind. Idempotency comes from the DELETE, not from swallowing.
 *
 * The transaction is what stops a crash between the two from leaving a period
 * with no rows: a rollback restores the previous rollup, and the previous
 * rollup is at worst stale — which is recoverable, because it is re-derivable
 * from a log that is never destroyed. That is the direction §5.2's requirement
 * points in.
 *
 * ## Two refreshes of one window would collide, so they are serialised
 *
 * §5.2 permits exactly one scheduled entry point, but it also requires the
 * nightly run be "manually triggerable from `/settings/developer`" — so the
 * cron at 03:00 and an operator's button press can genuinely overlap. Under
 * READ COMMITTED that ends badly rather than harmlessly: the second
 * transaction's DELETE blocks on the first's locks, resumes to find the rows it
 * meant to delete already gone and the replacements outside its snapshot,
 * deletes nothing, and then raises 23505 on the INSERT. A transaction-scoped
 * advisory lock makes the second refresh wait and then do the same correct work
 * on a clean slate, and it is released by the commit or the rollback with no
 * cleanup path to get wrong.
 *
 * ## Aggregation happens in Node, and the window is what keeps that honest
 *
 * The rows come back to the application to be combined, because the combining
 * rule lives in `core` and must not be restated in SQL. That is affordable
 * because `refresh` is bounded by a window rather than by the table: the
 * nightly step recomputes a week, and a twenty-year backfill is the caller's
 * loop over months. It is not affordable as a single call spanning the whole
 * log, and it is not meant to be — that is what the rollup exists to avoid.
 *
 * ## The window is widened to whole ISO weeks
 *
 * A week bucket is the summary of that week's day buckets, so a week computed
 * from part of a week is not a week — and it would overwrite a complete one.
 * {@link RollupRepository.refresh} therefore expands the requested window
 * outwards to whole ISO weeks before doing anything, and reports the window it
 * actually recomputed. Recomputing six extra days costs nothing; publishing a
 * Monday-to-Wednesday figure labelled as a week costs the reader's trust in
 * every other number on the page.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DailyBucket, DomainError, MetricDefinition, RollupObservation } from '@naitikos/core';
import {
  aggregate,
  checkQuantityFit,
  dailyBuckets,
  isDomainError,
  isIanaZone,
  parseDecimal,
  periodContaining,
  shiftDayKey,
  toQuantityString,
  validationError,
  zonedDayStart,
} from '@naitikos/core';

import type { Database } from '../client';
import { metricRollup, observation } from '../schema/substrate';

/**
 * The grains this writer maintains, mirroring the `grain` column's documented
 * values (`substrate.ts`). A plain `text` column rather than a pgEnum, so the
 * vocabulary is asserted here instead of by the database.
 */
export const ROLLUP_GRAINS = Object.freeze(['day', 'week'] as const);

export type RollupGrain = (typeof ROLLUP_GRAINS)[number];

/** A closed day-key window, inclusive at both ends — the same shape §4.12's review periods use. */
export type RollupWindow = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
};

/** A stored rollup, as a chart sees it. */
export type MetricRollupRow = {
  readonly metricKey: string;
  readonly grain: RollupGrain;
  /** The bucket's first local midnight, as an instant. */
  readonly bucketStart: string;
  /** The aggregate named by `metric.aggregation`, at the column's scale. */
  readonly value: string;
  /** Observations behind the bucket — raw ones, at every grain. */
  readonly sampleCount: number;
  readonly minValue: string | null;
  readonly maxValue: string | null;
  readonly computedAt: string;
};

export type RollupRefreshOutcome = {
  readonly written: number;
  /** Rows the DELETE removed. Ordinarily ≈ `written`; a re-run of an unchanged period. */
  readonly removed: number;
  /** The window actually recomputed, widened to whole ISO weeks. */
  readonly window: RollupWindow;
  /** Metrics left un-rolled because their stored number is not a measurement. */
  readonly skipped: readonly string[];
};

/**
 * Carries a `DomainError` out through a rolled-back transaction.
 *
 * The same device `daily-close.repository.ts` uses, and for the same reason:
 * Drizzle rolls back when its callback throws and only when it throws, so
 * returning an `Err` from inside would commit the partial write *and* report a
 * failure. Written as a plain subclass with an explicit field assignment
 * because `erasableSyntaxOnly` (§11.3) rejects parameter properties.
 */
class RollupAbort extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'RollupAbort';
    this.domainError = domainError;
  }
}

/** The domain error a rollback was carrying, or `null` for a genuine bug. */
function abortedWith(error: unknown): DomainError | null {
  if (error instanceof RollupAbort) return error.domainError;
  return isDomainError(error) ? error : null;
}

/**
 * A derived float, back to the exact decimal the `quantity()` column stores.
 *
 * `core/derivation` crosses the decimal boundary deliberately — its header says
 * "everything downstream is drawn on a screen 360 pixels wide" — and this is
 * where the crossing is undone for storage. That is honest rather than
 * contradictory: a rollup is a *summary* for reading, the exact record is the
 * observation log, and §9.10's export ships both. Scale 6 is the column's, so
 * nothing is discarded that the column could have held.
 *
 * `null` for anything that will not fit, which is then reported rather than
 * truncated. A silently narrowed aggregate is a wrong number with a right shape.
 */
function storedQuantity(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  // `toFixed` emits exponential notation above 1e21, which `parseDecimal`
  // rejects — so an absurd aggregate fails here rather than at the column.
  const parsed = parseDecimal(value.toFixed(6));
  if (parsed === null) return null;
  return checkQuantityFit(parsed) === null ? toQuantityString(parsed) : null;
}

/**
 * The requested window, expanded outwards to whole ISO weeks.
 *
 * `periodContaining` is `core`'s single implementation of "the Monday of this
 * week", and it is called rather than restated for the reason its own header
 * gives: "a second implementation of ISO week numbering is a second chance to
 * get 29 December wrong."
 */
function wholeWeeks(window: RollupWindow): RollupWindow | null {
  const first = periodContaining('weekly', window.fromDayKey);
  const last = periodContaining('weekly', window.toDayKey);
  if (first === null || last === null) return null;
  // Day keys are `YYYY-MM-DD`, so lexicographic order is chronological order.
  if (window.fromDayKey > window.toDayKey) return null;
  return { fromDayKey: first.fromDayKey, toDayKey: last.toDayKey };
}

/**
 * Day buckets folded up into ISO weeks.
 *
 * The week's value is the metric's own rule applied to the *day* values — what
 * `core`'s `aggregate` is exported for: "the weekly and monthly rollups apply
 * the same rule one level up". Each grain therefore summarises the grain below
 * it, which is what makes a week row derivable from the day rows beside it and
 * is why the window is widened to whole weeks.
 *
 * The consequence worth knowing, because it is surprising exactly once: for a
 * `count` metric a week's `value` is the number of *days* that recorded
 * something, not the number of observations. The observation total is
 * `sampleCount`, which is summed from the raw counts at every grain — so
 * nothing is lost, and the two questions stay distinguishable.
 */
function weekBuckets(
  days: readonly DailyBucket[],
  aggregation: MetricDefinition['aggregation'],
): readonly DailyBucket[] {
  const byWeek = new Map<string, DailyBucket[]>();

  for (const day of days) {
    const week = periodContaining('weekly', day.dayKey);
    // Unreachable for a real day key: `dailyBuckets` derived it from a parsed
    // instant. Skipped rather than defaulted, because there is no honest week
    // to file a malformed day under.
    if (week === null) continue;
    const existing = byWeek.get(week.fromDayKey);
    if (existing === undefined) byWeek.set(week.fromDayKey, [day]);
    else existing.push(day);
  }

  return [...byWeek.entries()]
    .flatMap(([mondayKey, members]) => {
      const combined = aggregate(
        members.map((member) => member.value),
        aggregation,
      );
      if (combined === null) return [];
      return [
        {
          dayKey: mondayKey,
          value: combined,
          sampleCount: members.reduce((total, member) => total + member.sampleCount, 0),
          minValue: Math.min(...members.map((member) => member.minValue)),
          maxValue: Math.max(...members.map((member) => member.maxValue)),
        },
      ];
    })
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

/**
 * Whether a metric's stored number means anything when combined.
 *
 * `observation.value` is `numeric` for every metric including the ones that are
 * not numbers, and `docs/observations.md` records what a `text` metric puts
 * there: "`0` — a legible placeholder", constant by design. The mean of a column
 * of placeholders is zero and the sum is zero, and a chart would render both as
 * a measurement. `count` is the exception, because counting placeholder rows
 * counts the entries that produced them.
 *
 * `boolean` and `categorical` are deliberately *not* excluded. A boolean stores
 * `0.000000` or `1.000000`, so its mean is an adherence rate — which is the
 * figure §4.4 wants — and a categorical stores an index into an ordered
 * `allowed_values`, so what to do with it is the registry's call and not this
 * file's.
 */
function isRollable(definition: MetricDefinition): boolean {
  return definition.valueType !== 'text' || definition.aggregation === 'count';
}

export type RollupRepository = {
  /**
   * Recompute every bucket in a window, for a set of metrics, from the log.
   *
   * Idempotent: re-running over unchanged observations produces the same rows,
   * bar `id` and `computed_at` — see the note on {@link MetricRollupRow}. The
   * window is widened to whole ISO weeks and the widened window is returned.
   *
   * `metrics` carries definitions rather than keys because the definition *is*
   * the combining rule (§9.2). Pass `registry.all()` to refresh everything.
   */
  refresh(
    window: RollupWindow,
    metrics: readonly MetricDefinition[],
    zone: string,
  ): Promise<Result<RollupRefreshOutcome, DomainError>>;

  /**
   * One metric's buckets at one grain, in a half-open instant range.
   *
   * Half-open and instant-bounded to match `sample.repository.ts`'s `range` and
   * to hit `metric_rollup_lookup_idx` as it stands.
   */
  range(
    metricKey: string,
    grain: RollupGrain,
    from: string,
    to: string,
  ): Promise<Result<readonly MetricRollupRow[], DomainError>>;

  /** The most recent buckets first — what a dashboard tile reads. */
  latest(
    metricKey: string,
    grain: RollupGrain,
    limit: number,
  ): Promise<Result<readonly MetricRollupRow[], DomainError>>;

  /** How many rows the projection holds. Operational, and what `/settings/developer` shows. */
  count(): Promise<number>;
};

export function createRollupRepository(db: Database): RollupRepository {
  /**
   * Row → reader's shape.
   *
   * `grain` is passed in rather than read off the row: the column is plain
   * `text`, every read below filters on it, and narrowing a string to
   * {@link RollupGrain} with a cast would assert something the query already
   * guarantees.
   */
  function toRollup(row: typeof metricRollup.$inferSelect, grain: RollupGrain): MetricRollupRow {
    return {
      metricKey: row.metricKey,
      grain,
      bucketStart: row.bucketStart,
      value: row.value,
      sampleCount: row.sampleCount,
      minValue: row.minValue,
      maxValue: row.maxValue,
      computedAt: row.computedAt,
    };
  }

  return {
    async refresh(window, metrics, zone) {
      /*
       * The zone is validated first because it is the one input whose failure is
       * silent. §5.3 stores a zone *name* rather than an offset, and
       * `dayKeyInZone` falls back to the leading ten characters of the instant
       * for an unrecognised one — correct for a read, disastrous for a write
       * that will be read for twenty years.
       */
      if (!isIanaZone(zone)) {
        return err(
          validationError('rollup_zone_invalid', `${zone} is not an IANA time zone.`, [
            { path: ['zone'], message: 'Expected a name such as Asia/Kolkata.' },
          ]),
        );
      }

      const widened = wholeWeeks(window);
      if (widened === null) {
        return err(
          validationError(
            'rollup_window_invalid',
            'The rollup window must be two real dates, the first no later than the second.',
            [{ path: ['window'], message: `${window.fromDayKey}…${window.toDayKey} is not a usable window.` }],
          ),
        );
      }

      /*
       * Deduplicated by key, first definition winning. Two definitions of one
       * metric would compute the same natural key twice and collide inside a
       * single INSERT — which the deliberate absence of an `ON CONFLICT` clause
       * turns into a 23505. A caller assembling a list from two registries
       * should not have to know that.
       */
      const byKey = new Map<string, MetricDefinition>();
      for (const definition of metrics) {
        if (!byKey.has(definition.key)) byKey.set(definition.key, definition);
      }

      const eligible = [...byKey.values()].filter(isRollable);
      const skipped = [...byKey.values()]
        .filter((definition) => !isRollable(definition))
        .map((definition) => definition.key as string)
        .sort();

      if (eligible.length === 0) {
        return ok({ written: 0, removed: 0, window: widened, skipped });
      }

      /*
       * The scan is widened by a day at each end, and the reason is §5.3 rather
       * than paranoia. Day membership is decided in each observation's *own*
       * zone, so an observation captured in Pacific/Auckland can belong to a
       * local day whose profile-zone midnight is nearly a day away from its UTC
       * instant. Zone offsets span roughly −12 to +14 hours, so one day of slack
       * each side is strictly sufficient, and the day keys are filtered back to
       * the window afterwards.
       */
      const scanFromDay = shiftDayKey(widened.fromDayKey, -1);
      const scanUntilDay = shiftDayKey(widened.toDayKey, 2);
      const afterWindow = shiftDayKey(widened.toDayKey, 1);
      if (scanFromDay === null || scanUntilDay === null || afterWindow === null) {
        return err(validationError('rollup_window_invalid', 'Could not resolve the rollup window.'));
      }

      const scanFrom = zonedDayStart(scanFromDay, zone);
      const scanUntil = zonedDayStart(scanUntilDay, zone);
      const bucketFrom = zonedDayStart(widened.fromDayKey, zone);
      const bucketUntil = zonedDayStart(afterWindow, zone);
      if (scanFrom === null || scanUntil === null || bucketFrom === null || bucketUntil === null) {
        return err(
          validationError('rollup_window_unresolvable', `Could not resolve that window in ${zone}.`),
        );
      }

      const keys = eligible.map((definition) => definition.key as string);

      try {
        const outcome = await db.transaction(async (tx) => {
          /*
           * One refresh at a time, table-wide. §5.2's manual trigger can land
           * on top of the cron, and the header records what that costs without
           * this: the loser deletes nothing and then raises 23505. Keyed on the
           * table name rather than on the window, because two overlapping
           * windows would collide just as thoroughly and a rollup refresh is
           * seconds of work. `_xact_` so the lock is released by the commit or
           * the rollback — there is no unlock path to forget.
           */
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('metric_rollup'))`);

          /*
           * Read, compute, DELETE, INSERT — four steps in that order, sharing
           * one transaction and therefore one view of the log. The ordering
           * between the last two is the whole idempotency story; see the header.
           *
           * `isNull(supersededById)` is the correctness property this file
           * exists to get right (§9.1). Without it a corrected reading is
           * counted twice and the resulting chart is plausible and wrong.
           *
           * Four columns, not fifteen: `RollupObservation` in `core` exists so
           * a refresh over years of history does not materialise eleven columns
           * per row that the rollup discards.
           *
           * Ordered by `(observed_at, hlc)` because §5.7 makes the HLC the total
           * causal order and `core`'s sort is stable on `observed_at` alone —
           * so for a `last` metric with two readings at one instant, the HLC is
           * what decides which one is last. Not read through
           * `ObservationRepository.query`, whose limit is capped at 5000: that
           * cap is right for a screen and wrong for a backfill.
           */
          const rows = await tx
            .select({
              metricKey: observation.metricKey,
              value: observation.value,
              observedAt: observation.observedAt,
              observedZone: observation.observedZone,
            })
            .from(observation)
            .where(
              and(
                inArray(observation.metricKey, keys),
                gte(observation.observedAt, scanFrom),
                lt(observation.observedAt, scanUntil),
                isNull(observation.supersededById),
              ),
            )
            .orderBy(asc(observation.observedAt), asc(observation.hlc));

          /*
           * Grouped by metric once rather than filtered per metric inside
           * `dailyBuckets`. With a registry of seventy metrics and a decade of
           * log that is the difference between one pass and seventy.
           */
          const observed = new Map<string, RollupObservation[]>();
          for (const row of rows) {
            const input: RollupObservation = {
              metricKey: row.metricKey as RollupObservation['metricKey'],
              value: row.value,
              observedAt: row.observedAt,
              observedZone: row.observedZone,
            };
            const existing = observed.get(row.metricKey);
            if (existing === undefined) observed.set(row.metricKey, [input]);
            else existing.push(input);
          }

          const pending: (typeof metricRollup.$inferInsert)[] = [];

          for (const definition of eligible) {
            const days = dailyBuckets(observed.get(definition.key) ?? [], definition).filter(
              // Trimming the day of slack the scan added at each end.
              (day) => day.dayKey >= widened.fromDayKey && day.dayKey <= widened.toDayKey,
            );

            const grained: readonly (readonly [RollupGrain, readonly DailyBucket[]])[] = [
              ['day', days],
              ['week', weekBuckets(days, definition.aggregation)],
            ];

            for (const [grain, buckets] of grained) {
              for (const bucket of buckets) {
                const bucketStart = zonedDayStart(bucket.dayKey, zone);
                const value = storedQuantity(bucket.value);
                const minValue = storedQuantity(bucket.minValue);
                const maxValue = storedQuantity(bucket.maxValue);

                if (bucketStart === null || value === null || minValue === null || maxValue === null) {
                  /*
                   * Thrown rather than skipped. A bucket that cannot be stored
                   * is a metric whose values have outgrown `numeric(20,6)` or a
                   * zone that stopped resolving, and either is a fact about the
                   * data worth interrupting the nightly run for. Silently
                   * omitting the day would leave a gap in a chart that reads as
                   * "nothing recorded".
                   */
                  throw new RollupAbort(
                    validationError(
                      'rollup_value_unstorable',
                      `Could not store the ${grain} rollup of ${definition.key} for ${bucket.dayKey}.`,
                      [{ path: [definition.key, bucket.dayKey], message: `Out of range: ${String(bucket.value)}.` }],
                    ),
                  );
                }

                pending.push({
                  id: randomUUID(),
                  metricKey: definition.key,
                  grain,
                  bucketStart,
                  value,
                  sampleCount: bucket.sampleCount,
                  minValue,
                  maxValue,
                  /*
                   * `computed_at` left to the column's `now()` default, which is
                   * the transaction's timestamp — the instant this projection
                   * was true as of. Nothing here needs a clock injected, and
                   * §11.3's ban on reading wall time in application code is
                   * satisfied by not reading it.
                   */
                });
              }
            }
          }

          /*
           * The DELETE covers the whole widened window for every eligible
           * metric, including metrics that produced nothing. That is what makes
           * a retraction visible: supersede the only observation in a bucket and
           * the bucket is deleted and not rewritten, so it disappears rather
           * than persisting as a value nobody stands behind any more.
           *
           * Scoped by metric key and by bucket range, so refreshing one metric's
           * January cannot touch another metric or another month.
           */
          const removed = await tx
            .delete(metricRollup)
            .where(
              and(
                inArray(metricRollup.metricKey, keys),
                inArray(metricRollup.grain, [...ROLLUP_GRAINS]),
                gte(metricRollup.bucketStart, bucketFrom),
                lt(metricRollup.bucketStart, bucketUntil),
              ),
            )
            .returning({ id: metricRollup.id });

          if (pending.length === 0) return { written: 0, removed: removed.length };

          /*
           * No `ON CONFLICT`, deliberately. The DELETE above is visible to this
           * statement — separate statements, separate command snapshots — so a
           * conflict here would mean the scoping reasoning is wrong, and a loud
           * 23505 is the only way that ever gets found.
           */
          const written = await tx.insert(metricRollup).values(pending).returning({ id: metricRollup.id });

          return { written: written.length, removed: removed.length };
        });

        return ok({ ...outcome, window: widened, skipped });
      } catch (error) {
        const domainError = abortedWith(error);
        // A genuine bug — a lost connection, a constraint nobody expected — is
        // rethrown rather than dressed as a domain failure.
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async range(metricKey, grain, from, to) {
      const rows = await db
        .select()
        .from(metricRollup)
        .where(
          and(
            eq(metricRollup.metricKey, metricKey),
            eq(metricRollup.grain, grain),
            gte(metricRollup.bucketStart, from),
            lt(metricRollup.bucketStart, to),
          ),
        )
        .orderBy(asc(metricRollup.bucketStart));

      return ok(rows.map((row) => toRollup(row, grain)));
    },

    async latest(metricKey, grain, limit) {
      const rows = await db
        .select()
        .from(metricRollup)
        .where(and(eq(metricRollup.metricKey, metricKey), eq(metricRollup.grain, grain)))
        // Matches `metric_rollup_lookup_idx`, which is already ordered
        // `(metric_key, grain, bucket_start DESC)`.
        .orderBy(desc(metricRollup.bucketStart))
        .limit(Math.max(1, Math.min(limit, 5000)));

      return ok(rows.map((row) => toRollup(row, grain)));
    },

    async count() {
      const rows = await db.select({ total: sql<number>`count(*)::int` }).from(metricRollup);
      return rows[0]?.total ?? 0;
    },
  };
}

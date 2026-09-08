/**
 * Metric rollups — integration, against real Postgres.
 *
 * `core/derivation/rollup.test.ts` already covers what a rollup *is*: the
 * combining rule comes from the metric, a day is a day in its own zone, an
 * unparseable value is dropped. None of that is retested here. What is tested
 * here is everything the pure functions cannot know about, and there are four
 * things in that category:
 *
 *   1. **A re-run produces the same rows.** §5.2 makes the nightly job
 *      "idempotent, safe to re-run", and it will be — by the manual trigger in
 *      `/settings/developer`, by a retry, and by an operator at 11pm. A rollup
 *      that doubled on the second run would not announce itself; every trend
 *      chart in the application would simply be twice as steep.
 *   2. **A superseded observation is excluded.** §9.1 keeps the corrected row
 *      forever, so the log contains both the wrong number and the right one.
 *      This is the single failure in this file that would look correct: a
 *      bodyweight corrected from 84 to 74 averages to 79, and 79 is a number a
 *      person might weigh.
 *   3. **A retracted bucket disappears.** The case an upsert cannot express,
 *      and the reason `refresh` deletes before it inserts.
 *   4. **A boundary instant belongs to exactly one period.** Local midnight in
 *      Asia/Kolkata is 18:30 UTC the previous day, which is the exact arithmetic
 *      that makes an Indian evening file under the following date if anyone
 *      reaches for `date_trunc`.
 *
 * ## This suite cleans up after itself
 *
 * `testing/reset.ts` deliberately excludes `metric_rollup` from `RESET_ORDER`,
 * on the grounds that it is a derived projection whose stale rows are
 * overwritten rather than accumulated, and that "a projector test that needs a
 * clean slate should say so itself". This is that test saying so: the row count
 * is captured before anything runs and asserted back at the end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, uuidV7 } from '@naitikos/shared';
import type { MetricDefinition, Observation } from '@naitikos/core';
import { createMetricRegistry, hlcTick, initialHlcState, MVP_METRICS, zonedDayStart } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createObservationRepository } from './observation.repository';
import type { MetricRollupRow, RollupGrain } from './rollup.repository';
import { createRollupRepository } from './rollup.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

/** The profile's zone throughout. +05:30, so no local midnight is a UTC midnight. */
const ZONE = 'Asia/Kolkata';

/** ISO week 34 of 2026 runs Monday the 17th to Sunday the 23rd of August. */
const MONDAY = '2026-08-17';
const TUESDAY = '2026-08-18';
const WEDNESDAY = '2026-08-19';
const SUNDAY_BEFORE = '2026-08-16';

const registry = createMetricRegistry([...MVP_METRICS]);

function definition(key: string): MetricDefinition {
  const found = registry.get(key);
  if (found === null) throw new Error(`${key} is not a registered metric`);
  return found;
}

/** `mean` — the metric §9.2 uses to make its point about summing bodyweight. */
const WEIGHT = definition('body.weight');
/** `sum` — the same readings under a different rule must roll up differently. */
const PRACTICE = definition('mind.practice.duration');

const METRIC_KEYS = [WEIGHT.key as string, PRACTICE.key as string];

/**
 * A fixed epoch, so every id and every HLC in this file is deterministic —
 * §11.3's rule applied to identity as well as to time.
 */
const EPOCH = 1_755_000_000_000;
let sequence = 0;
const newId = (): string => uuidV7(EPOCH + (sequence += 1));
let hlcState = initialHlcState(newId(), EPOCH);

function nextHlc(): string {
  const tick = hlcTick(hlcState, EPOCH);
  hlcState = tick.state;
  return tick.hlc;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** The instant of a local midnight, which is what `bucket_start` stores. */
function midnight(dayKey: string): string {
  const start = zonedDayStart(dayKey, ZONE);
  if (start === null) throw new Error(`${dayKey} does not resolve in ${ZONE}`);
  return start;
}

/**
 * The bucket, minus the two columns a re-run is *expected* to change.
 *
 * `id` is a fresh UUID on every refresh because a delete-then-insert cannot
 * preserve one, and `computed_at` is the record that the projection was rebuilt.
 * Neither is the row's identity: `metric_rollup_unique` on
 * `(metric_key, grain, bucket_start)` is. §5.2's "safe to re-run" is a claim
 * about the facts, not about the surrogate key they arrived under — so this is
 * what "identical rows" is asserted over.
 */
function facts(row: MetricRollupRow): Omit<MetricRollupRow, 'computedAt'> {
  return {
    metricKey: row.metricKey,
    grain: row.grain,
    bucketStart: row.bucketStart,
    value: row.value,
    sampleCount: row.sampleCount,
    minValue: row.minValue,
    maxValue: row.maxValue,
  };
}

suite('rollup repository (§5.6, §9.7)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const rollups = createRollupRepository(database);
  const observations = createObservationRepository(database);

  let baseline = 0;
  let source = '';

  /** Only this suite's metrics, so a concurrent row of anyone else's survives. */
  async function clearRollups(): Promise<void> {
    await database.$client`delete from metric_rollup where metric_key = any(${database.$client.array(METRIC_KEYS)})`;
  }

  beforeAll(async () => {
    baseline = await rollups.count();
  });

  afterAll(async () => {
    // A net for a test that failed mid-way: the assertion at the foot of this
    // file is the contract, and this is what keeps a failure from leaking rows
    // into the next suite regardless.
    await clearRollups();
    await database.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await resetDomainTables(database.$client);
    await clearRollups();
    source = unwrap(await observations.manualSourceId());
  });

  function reading(metric: MetricDefinition, observedAt: string, value: string): Observation {
    return {
      id: newId() as Observation['id'],
      metricKey: metric.key,
      value,
      valueText: null,
      unit: metric.canonicalUnit,
      observedAt,
      observedZone: ZONE,
      recordedAt: observedAt,
      sourceId: source as Observation['sourceId'],
      confidence: null,
      subjectType: null,
      subjectId: null,
      context: null,
      supersededById: null,
      supersededAt: null,
      supersedeReason: null,
      hlc: nextHlc() as Observation['hlc'],
    };
  }

  /** 08:00 and 20:00 local on a given day, as instants. */
  function morning(dayKey: string): string {
    return `${dayKey}T02:30:00.000Z`;
  }
  function evening(dayKey: string): string {
    return `${dayKey}T14:30:00.000Z`;
  }

  async function refreshWeek(metrics: readonly MetricDefinition[] = [WEIGHT]): Promise<void> {
    const outcome = await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, metrics, ZONE);
    expect(isOk(outcome)).toBe(true);
  }

  async function daysOf(metric: MetricDefinition): Promise<readonly MetricRollupRow[]> {
    return read(metric, 'day');
  }

  async function read(metric: MetricDefinition, grain: RollupGrain): Promise<readonly MetricRollupRow[]> {
    return unwrap(
      await rollups.range(metric.key, grain, midnight('2026-08-01'), midnight('2026-09-01')),
    );
  }

  describe('refresh', () => {
    it('writes one day bucket per recorded day, aggregated by the metric’s rule', async () => {
      unwrap(
        await observations.append([
          reading(WEIGHT, morning(MONDAY), '74.000000'),
          reading(WEIGHT, evening(MONDAY), '76.000000'),
          reading(WEIGHT, morning(TUESDAY), '80.000000'),
        ]),
      );

      await refreshWeek();

      const days = await daysOf(WEIGHT);
      expect(days.map((day) => day.bucketStart)).toEqual([midnight(MONDAY), midnight(TUESDAY)]);
      // `mean`, from the registry. The same rows under `sum` are asserted below.
      expect(days[0]?.value).toBe('75.000000');
      expect(days[0]?.sampleCount).toBe(2);
      expect(days[0]?.minValue).toBe('74.000000');
      expect(days[0]?.maxValue).toBe('76.000000');
      expect(days[1]?.value).toBe('80.000000');
      expect(days[1]?.sampleCount).toBe(1);
    });

    /**
     * §9.2's claim, at the storage layer: "the registry is what stops a chart
     * from doing either." Identical readings, a different `aggregation` column,
     * a different stored number — with no parameter anywhere in this test
     * selecting the rule.
     */
    it('takes the rule from the metric and not from the caller', async () => {
      unwrap(
        await observations.append([
          reading(PRACTICE, morning(MONDAY), '20.000000'),
          reading(PRACTICE, evening(MONDAY), '10.000000'),
        ]),
      );

      await refreshWeek([PRACTICE]);

      const days = await daysOf(PRACTICE);
      expect(days[0]?.value).toBe('30.000000');
    });

    it('summarises the week from the days beneath it', async () => {
      unwrap(
        await observations.append([
          reading(WEIGHT, morning(MONDAY), '74.000000'),
          reading(WEIGHT, evening(MONDAY), '76.000000'),
          reading(WEIGHT, morning(TUESDAY), '80.000000'),
        ]),
      );

      await refreshWeek();

      const weeks = await read(WEIGHT, 'week');
      expect(weeks).toHaveLength(1);
      // The bucket starts on the Monday, and the value is the metric's rule
      // applied one level up — mean(75, 80), not mean(74, 76, 80).
      expect(weeks[0]?.bucketStart).toBe(midnight(MONDAY));
      expect(weeks[0]?.value).toBe('77.500000');
      // The raw total is carried at every grain, so "how many readings" and
      // "what was the number" stay separate questions.
      expect(weeks[0]?.sampleCount).toBe(3);
      expect(weeks[0]?.minValue).toBe('74.000000');
      expect(weeks[0]?.maxValue).toBe('80.000000');
    });

    /**
     * A week computed from part of a week is not a week, and would overwrite a
     * complete one. Asking for a single Wednesday must therefore recompute the
     * whole ISO week around it — and say so.
     */
    it('widens the requested window to whole ISO weeks', async () => {
      unwrap(await observations.append([reading(WEIGHT, morning(MONDAY), '74.000000')]));

      const outcome = unwrap(
        await rollups.refresh({ fromDayKey: WEDNESDAY, toDayKey: WEDNESDAY }, [WEIGHT], ZONE),
      );

      expect(outcome.window).toEqual({ fromDayKey: MONDAY, toDayKey: '2026-08-23' });
      // Monday's reading is inside the widened window, so the week exists even
      // though the caller asked about Wednesday.
      const weeks = await read(WEIGHT, 'week');
      expect(weeks).toHaveLength(1);
      expect(weeks[0]?.value).toBe('74.000000');
    });

    /**
     * §5.2: "idempotent, safe to re-run". Re-running is not an unusual event —
     * `/settings/developer` has a button for it.
     */
    it('is idempotent: a second run produces identical rows', async () => {
      unwrap(
        await observations.append([
          reading(WEIGHT, morning(MONDAY), '74.000000'),
          reading(WEIGHT, evening(MONDAY), '76.000000'),
          reading(WEIGHT, morning(TUESDAY), '80.000000'),
        ]),
      );

      const first = unwrap(await rollups.refresh({ fromDayKey: MONDAY, toDayKey: TUESDAY }, [WEIGHT], ZONE));
      const before = [...(await daysOf(WEIGHT)), ...(await read(WEIGHT, 'week'))].map(facts);

      const second = unwrap(await rollups.refresh({ fromDayKey: MONDAY, toDayKey: TUESDAY }, [WEIGHT], ZONE));
      const after = [...(await daysOf(WEIGHT)), ...(await read(WEIGHT, 'week'))].map(facts);

      expect(after).toEqual(before);
      expect(second.written).toBe(first.written);
      // The second run removed exactly what the first wrote — the proof that
      // idempotency comes from the DELETE and not from an absorbed conflict.
      expect(second.removed).toBe(first.written);
      // Three readings, two days, one week. Nothing doubled.
      expect(after).toHaveLength(3);
    });

    /**
     * The property this file exists for.
     *
     * §9.1: a correction is a new observation and the old row survives forever,
     * pointing at its replacement. Both rows are in the table when this refresh
     * runs. Rolling up both would give mean(84, 74) = 79 — plausible, wrong, and
     * permanent.
     */
    it('excludes a superseded observation', async () => {
      const wrong = reading(WEIGHT, morning(MONDAY), '84.000000');
      const corrected = reading(WEIGHT, morning(MONDAY), '74.000000');

      unwrap(await observations.append([wrong]));
      unwrap(
        await observations.append([corrected], [
          {
            observationId: wrong.id,
            supersededById: corrected.id,
            supersededAt: morning(TUESDAY),
            supersedeReason: 'Read the scale wrong.',
          },
        ]),
      );

      await refreshWeek();

      const days = await daysOf(WEIGHT);
      expect(days).toHaveLength(1);
      expect(days[0]?.value).toBe('74.000000');
      // Not 79.000000, and not a count of 2. Both halves matter: a rollup that
      // averaged the pair would also have claimed two readings.
      expect(days[0]?.sampleCount).toBe(1);
      expect(days[0]?.minValue).toBe('74.000000');
      expect(days[0]?.maxValue).toBe('74.000000');
    });

    /**
     * The case an `ON CONFLICT DO UPDATE` cannot express, and therefore the
     * reason `refresh` deletes the window before inserting into it.
     */
    it('removes a bucket whose only observation has been retracted', async () => {
      const monday = reading(WEIGHT, morning(MONDAY), '74.000000');
      unwrap(await observations.append([monday]));
      await refreshWeek();
      expect(await daysOf(WEIGHT)).toHaveLength(1);

      // The correction moves the reading to Tuesday: Monday now has nothing.
      const moved = reading(WEIGHT, morning(TUESDAY), '74.000000');
      unwrap(
        await observations.append([moved], [
          {
            observationId: monday.id,
            supersededById: moved.id,
            supersededAt: morning(TUESDAY),
            supersedeReason: 'Recorded against the wrong day.',
          },
        ]),
      );

      const outcome = unwrap(await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, [WEIGHT], ZONE));

      const days = await daysOf(WEIGHT);
      expect(days).toHaveLength(1);
      expect(days[0]?.bucketStart).toBe(midnight(TUESDAY));
      // Monday's stale row was deleted rather than left standing beside the new
      // one, which is what `removed` exceeding nothing here records.
      expect(outcome.removed).toBeGreaterThan(0);
    });

    /**
     * §5.3's arithmetic, which is where a `date_trunc` implementation goes
     * wrong: local midnight in Asia/Kolkata is 18:30 UTC on the *previous*
     * date. An instant exactly on that boundary must belong to the day that is
     * starting, to exactly one day bucket, and to exactly one week bucket.
     */
    it('files a boundary instant into exactly one period', async () => {
      const boundary = midnight(MONDAY);
      const justBefore = '2026-08-16T18:29:59.999Z';
      expect(boundary).toBe('2026-08-16T18:30:00.000Z');

      unwrap(
        await observations.append([
          reading(WEIGHT, justBefore, '70.000000'),
          reading(WEIGHT, boundary, '74.000000'),
        ]),
      );

      unwrap(await rollups.refresh({ fromDayKey: SUNDAY_BEFORE, toDayKey: MONDAY }, [WEIGHT], ZONE));

      const days = await daysOf(WEIGHT);
      expect(days.map((day) => day.bucketStart)).toEqual([midnight(SUNDAY_BEFORE), midnight(MONDAY)]);
      // One reading each: neither instant was counted twice, and neither was
      // dropped between the two days.
      expect(days.map((day) => day.sampleCount)).toEqual([1, 1]);
      expect(days.map((day) => day.value)).toEqual(['70.000000', '74.000000']);

      /*
       * And the same instant across a week boundary. 16 August is a Sunday in
       * ISO week 33; the boundary instant starts the Monday of week 34. Two
       * week buckets, one reading each — the Monday-midnight reading did not
       * land in the week that was ending.
       */
      const weeks = await read(WEIGHT, 'week');
      expect(weeks.map((week) => week.bucketStart)).toEqual([midnight('2026-08-10'), midnight(MONDAY)]);
      expect(weeks.map((week) => week.sampleCount)).toEqual([1, 1]);
    });

    it('leaves another metric’s buckets alone', async () => {
      unwrap(
        await observations.append([
          reading(WEIGHT, morning(MONDAY), '74.000000'),
          reading(PRACTICE, morning(MONDAY), '20.000000'),
        ]),
      );
      await refreshWeek([WEIGHT, PRACTICE]);

      // Refreshing only bodyweight must not delete practice's row, even though
      // both share the bucket range.
      await refreshWeek([WEIGHT]);

      expect(await daysOf(PRACTICE)).toHaveLength(1);
      expect(await daysOf(WEIGHT)).toHaveLength(1);
    });

    it('writes nothing for a window with no observations', async () => {
      const outcome = unwrap(await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, [WEIGHT], ZONE));

      expect(outcome.written).toBe(0);
      expect(outcome.removed).toBe(0);
      expect(await daysOf(WEIGHT)).toHaveLength(0);
    });

    /**
     * `docs/observations.md`: a `text` metric stores "`0` — a legible
     * placeholder" in `value`. The mean of a column of placeholders is zero, and
     * a chart would draw it as a measurement.
     */
    it('skips a metric whose stored number is a placeholder', async () => {
      const asText: MetricDefinition = { ...WEIGHT, valueType: 'text' };
      unwrap(await observations.append([reading(WEIGHT, morning(MONDAY), '74.000000')]));

      const outcome = unwrap(await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, [asText], ZONE));

      expect(outcome.skipped).toEqual([WEIGHT.key]);
      expect(outcome.written).toBe(0);
      expect(await daysOf(WEIGHT)).toHaveLength(0);
    });

    it('rejects a zone that is not an IANA name', async () => {
      // §5.3: `+05:30` is accepted by `Intl` as a time zone and is precisely the
      // confusion the blueprint was written to prevent. A bad zone here would
      // mis-file every bucket, silently, forever.
      const outcome = await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, [WEIGHT], '+05:30');

      expect(isErr(outcome) && outcome.error.code).toBe('rollup_zone_invalid');
    });

    it('rejects an inverted or unreal window', async () => {
      const inverted = await rollups.refresh({ fromDayKey: TUESDAY, toDayKey: MONDAY }, [WEIGHT], ZONE);
      const unreal = await rollups.refresh({ fromDayKey: 'yesterday', toDayKey: MONDAY }, [WEIGHT], ZONE);

      expect(isErr(inverted) && inverted.error.code).toBe('rollup_window_invalid');
      expect(isErr(unreal) && unreal.error.code).toBe('rollup_window_invalid');
    });

    it('tolerates the same metric named twice', async () => {
      // Two definitions of one metric would compute one natural key twice and
      // collide inside a single INSERT, which the deliberate absence of an
      // `ON CONFLICT` clause turns into a raised 23505.
      unwrap(await observations.append([reading(WEIGHT, morning(MONDAY), '74.000000')]));

      const outcome = unwrap(
        await rollups.refresh({ fromDayKey: MONDAY, toDayKey: MONDAY }, [WEIGHT, WEIGHT], ZONE),
      );

      expect(outcome.written).toBe(2);
      expect(await daysOf(WEIGHT)).toHaveLength(1);
    });
  });

  describe('reading back', () => {
    beforeEach(async () => {
      unwrap(
        await observations.append([
          reading(WEIGHT, morning(MONDAY), '74.000000'),
          reading(WEIGHT, morning(TUESDAY), '76.000000'),
          reading(WEIGHT, morning(WEDNESDAY), '78.000000'),
        ]),
      );
      await refreshWeek();
    });

    it('reads a half-open range, oldest first', async () => {
      const rows = unwrap(
        await rollups.range(WEIGHT.key, 'day', midnight(MONDAY), midnight(WEDNESDAY)),
      );

      // The upper bound is excluded, so Wednesday is absent.
      expect(rows.map((row) => row.value)).toEqual(['74.000000', '76.000000']);
      expect(rows.every((row) => row.grain === 'day')).toBe(true);
    });

    it('reads the most recent buckets first', async () => {
      const rows = unwrap(await rollups.latest(WEIGHT.key, 'day', 2));

      expect(rows.map((row) => row.value)).toEqual(['78.000000', '76.000000']);
    });

    it('keeps the grains apart', async () => {
      const weeks = unwrap(await rollups.latest(WEIGHT.key, 'week', 10));

      expect(weeks).toHaveLength(1);
      expect(weeks[0]?.grain).toBe('week');
    });

    it('reports nothing for a metric with no buckets', async () => {
      expect(unwrap(await rollups.latest(PRACTICE.key, 'day', 10))).toEqual([]);
    });
  });

  /**
   * Last, deliberately: `it` blocks run in order, so this is the suite putting
   * back what `RESET_ORDER` does not clear for it.
   */
  it('leaves metric_rollup as it found it', async () => {
    await clearRollups();

    expect(await rollups.count()).toBe(baseline);
  });
});

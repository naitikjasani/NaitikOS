/**
 * Goals — integration, against real Postgres.
 *
 * The core tests cover the arithmetic. This covers the two things only a
 * database can answer, and both of them are §4.10's central claim in a
 * different disguise:
 *
 *   1. **Nothing writes progress.** The pipeline runs from observations every
 *      time, so a corrected observation changes today's answer — which is the
 *      property "goals own no progress data" exists to give.
 *   2. **A snapshot survives that correction.** §9.2: "Snapshots exist so the
 *      *trajectory as it was believed at the time* is preserved even after the
 *      underlying data is corrected."
 *
 * Those two are in tension by design, and getting exactly one of them wrong is
 * how this feature quietly becomes a cache.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { MetricRegistry, Observation } from '@naitikos/core';
import {
  dailyRollup,
  deriveProgress,
  detectTensions,
  initialHlcState,
  planSnapshot,
  prepareObservations,
} from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createGoalRepository } from './goal.repository';
import { createMetricRepository } from './metric.repository';
import { createObservationRepository } from './observation.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

async function registry(): Promise<MetricRegistry> {
  if (db === undefined) throw new Error('no database');
  const result = await createMetricRepository(db).registry();
  if (!isOk(result)) throw new Error('registry unavailable');
  return result.value;
}

/** Write `days` bodyweight readings rising 0.1 kg/day from 74. */
async function seedWeights(days: number, from = 74): Promise<void> {
  if (db === undefined) throw new Error('no database');
  const reg = await registry();
  const observations = createObservationRepository(db);

  const source = await observations.manualSourceId();
  if (!isOk(source)) throw new Error('source unavailable');

  const prepared = prepareObservations(
    Array.from({ length: days }, (_, index) => ({
      metricKey: 'body.weight',
      value: { kind: 'number' as const, value: (from + 0.1 * index).toFixed(2), unit: 'kg' },
      observedAt: `2026-11-${String(index + 1).padStart(2, '0')}T07:00:00.000Z`,
      observedZone: ZONE,
    })),
    initialHlcState(newId(), EPOCH),
    {
      registry: reg,
      sourceId: source.value as Observation['sourceId'],
      recordedAt: '2026-11-30T09:00:00.000Z',
      physicalMillis: EPOCH,
      newId,
    },
  );
  if (!isOk(prepared)) throw new Error(`plan failed: ${JSON.stringify(prepared.error)}`);

  const written = await observations.append(prepared.value.observations, prepared.value.supersessions);
  if (!isOk(written)) throw new Error('append failed');
}

async function weightSeries() {
  if (db === undefined) throw new Error('no database');
  const reg = await registry();
  const definition = reg.get('body.weight');
  if (definition === null) throw new Error('body.weight is not registered');

  const rows = await createObservationRepository(db).query({ metricKeys: ['body.weight'], currentOnly: true });
  if (!isOk(rows)) throw new Error('read failed');
  return dailyRollup(rows.value, definition, { zone: ZONE });
}

/**
 * Supersede the most recent bodyweight reading (§9.1 — corrections append).
 */
async function correctLastWeight(value: string): Promise<void> {
  if (db === undefined) throw new Error('no database');
  const observations = createObservationRepository(db);

  const current = await observations.query({ metricKeys: ['body.weight'], currentOnly: true });
  if (!isOk(current)) throw new Error('read failed');
  const last = [...current.value].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))[0];
  if (last === undefined) throw new Error('nothing to correct');

  const source = await observations.manualSourceId();
  if (!isOk(source)) throw new Error('source unavailable');

  const prepared = prepareObservations(
    [
      {
        metricKey: 'body.weight',
        value: { kind: 'number' as const, value, unit: 'kg' },
        observedAt: last.observedAt,
        observedZone: ZONE,
        supersedes: { id: last.id, reason: 'mistyped' },
      },
    ],
    initialHlcState(newId(), EPOCH),
    {
      registry: await registry(),
      sourceId: source.value as Observation['sourceId'],
      recordedAt: '2026-11-30T10:00:00.000Z',
      physicalMillis: EPOCH,
      newId,
    },
  );
  if (!isOk(prepared)) throw new Error(`plan failed: ${JSON.stringify(prepared.error)}`);

  const written = await observations.append(prepared.value.observations, prepared.value.supersessions);
  if (!isOk(written)) throw new Error('append failed');
}

suite('goals', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await resetDomainTables(db.$client);
  });

  it('stores a definition and its targets, once on a replay', async () => {
    if (db === undefined) return;
    const goals = createGoalRepository(db);

    const input = {
      id: newId(),
      title: 'Build muscle',
      description: null,
      startedAt: '2026-11-01T12:00:00.000Z',
      horizonAt: '2027-03-01T12:00:00.000Z',
      targets: [
        {
          id: newId(),
          metricKey: 'body.weight',
          comparator: 'rate_of_change' as const,
          targetValue: '0.25',
          unit: 'kg',
          windowDays: 28,
        },
      ],
    };

    const first = await goals.create(input);
    expect(isOk(first)).toBe(true);

    /* §5.7: the same client-minted UUIDv7 arrives again from a retry. */
    const replay = await goals.create(input);
    expect(isOk(replay)).toBe(true);

    const rows = await db.$client`select count(*)::int as total from goal`;
    const targets = await db.$client`select count(*)::int as total from goal_target`;
    expect(rows[0]?.['total']).toBe(1);
    /* The one that matters: a replay must not double the denominator. */
    expect(targets[0]?.['total']).toBe(1);
  });

  it('has no column anywhere that could hold progress', async () => {
    if (db === undefined) return;
    /*
     * §9.3(4): "Goals own definitions, not progress." Asserted against the
     * live schema rather than trusted, because the temptation to add a cached
     * `current_value` is exactly what §4.10 warns produces a second, drifting
     * source of truth.
     */
    const columns = await db.$client`
      select column_name from information_schema.columns
      where table_name in ('goal', 'goal_target')`;
    const names = columns.map((row) => String(row['column_name']));

    for (const forbidden of ['current_value', 'progress_ratio', 'progress', 'projected_at']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('derives progress from observations, so a correction changes the answer', async () => {
    if (db === undefined) return;
    await seedWeights(20);

    const target = {
      id: newId(),
      goalId: 'g',
      metricKey: 'body.weight',
      comparator: 'at_least' as const,
      targetValue: '76',
      unit: 'kg',
      windowDays: null,
    };

    const before = deriveProgress({
      target,
      series: await weightSeries(),
      horizonDayKey: '2027-06-01',
      todayDayKey: '2026-11-20',
    });
    expect(before.status).toBe('on_track');
    expect(before.current).toBeCloseTo(75.9, 2);

    /*
     * A real §9.1 correction: the last reading is superseded rather than
     * edited. Nothing cached the old figure, so the derived answer moves the
     * moment the log does — which is precisely what "goals own no progress
     * data" buys.
     */
    await correctLastWeight('80.00');

    const after = deriveProgress({
      target,
      series: await weightSeries(),
      horizonDayKey: '2027-06-01',
      todayDayKey: '2026-11-20',
    });
    expect(after.current).toBeCloseTo(80, 2);
    expect(after.status).toBe('met');
  });

  /**
   * The point of the table. A March reading corrected in June changes today's
   * line; the January snapshot is the only evidence that the review that month
   * was looking at something else.
   */
  it('keeps a snapshot of what was believed, after the data behind it changes', async () => {
    if (db === undefined) return;
    const goals = createGoalRepository(db);
    await seedWeights(20);

    const goalId = newId();
    const targetId = newId();
    const created = await goals.create({
      id: goalId,
      title: 'Reach 76 kg',
      description: null,
      startedAt: '2026-11-01T12:00:00.000Z',
      horizonAt: null,
      targets: [
        { id: targetId, metricKey: 'body.weight', comparator: 'at_least', targetValue: '76', unit: 'kg', windowDays: null },
      ],
    });
    if (!isOk(created)) throw new Error('create failed');

    const targets = await goals.targets([goalId]);
    if (!isOk(targets)) throw new Error('targets failed');
    const target = targets.value[0];
    if (target === undefined) throw new Error('no target');

    const progress = deriveProgress({
      target,
      series: await weightSeries(),
      horizonDayKey: null,
      todayDayKey: '2026-11-20',
    });
    const snapshotId = newId();
    const row = planSnapshot(snapshotId, goalId, target, progress, '2026-11-20T22:00:00.000Z');
    if (row === null) throw new Error('nothing to snapshot');

    const recorded = await goals.recordSnapshots([row]);
    expect(isOk(recorded) && recorded.value).toBe(1);

    /* Re-running the same night must not write a second row. */
    await goals.recordSnapshots([row]);

    const stored = await goals.snapshots(goalId);
    if (!isOk(stored)) throw new Error('read failed');
    expect(stored.value).toHaveLength(1);
    const believed = stored.value[0]?.currentValue;

    /* Now the underlying data changes. The snapshot must not follow it. */
    await seedWeights(1, 90);
    const reread = await goals.snapshots(goalId);
    if (!isOk(reread)) throw new Error('reread failed');
    expect(reread.value[0]?.currentValue).toBe(believed);
  });

  it('closes a goal with its reason, and dates only an achievement', async () => {
    if (db === undefined) return;
    const goals = createGoalRepository(db);

    const make = async (title: string) => {
      const id = newId();
      const created = await goals.create({
        id,
        title,
        description: null,
        startedAt: '2026-11-01T12:00:00.000Z',
        horizonAt: null,
        targets: [
          { id: newId(), metricKey: 'body.weight', comparator: 'at_least', targetValue: '80', unit: 'kg', windowDays: null },
        ],
      });
      if (!isOk(created)) throw new Error('create failed');
      return id;
    };

    const achieved = await goals.close({
      id: await make('Done'),
      status: 'achieved',
      closingNote: 'Hit it in February.',
      at: '2027-02-01T09:00:00.000Z',
    });
    if (!isOk(achieved)) throw new Error('close failed');
    expect(achieved.value.achievedAt).not.toBeNull();
    expect(achieved.value.closingNote).toBe('Hit it in February.');

    /* An abandoned goal was not achieved, and a populated `achievedAt` on one
     * would read as though it had been. */
    const abandoned = await goals.close({
      id: await make('Not any more'),
      status: 'abandoned',
      closingNote: 'Priorities changed after the job move.',
      at: '2027-02-01T09:00:00.000Z',
    });
    if (!isOk(abandoned)) throw new Error('close failed');
    expect(abandoned.value.achievedAt).toBeNull();
    expect(abandoned.value.status).toBe('abandoned');
  });

  /** §4.10's named case, end to end through the database. */
  it('detects the bulk against the visible-abs goal from stored rows', async () => {
    if (db === undefined) return;
    const goals = createGoalRepository(db);

    const bulk = newId();
    const abs = newId();
    await goals.create({
      id: bulk,
      title: 'Build muscle',
      description: null,
      startedAt: '2026-11-01T12:00:00.000Z',
      horizonAt: null,
      targets: [
        { id: newId(), metricKey: 'nutrition.energy', comparator: 'at_least', targetValue: '3200', unit: 'kcal', windowDays: null },
      ],
    });
    await goals.create({
      id: abs,
      title: 'Visible abs',
      description: null,
      startedAt: '2026-11-01T12:00:00.000Z',
      horizonAt: null,
      targets: [
        { id: newId(), metricKey: 'body.fat_percentage', comparator: 'at_most', targetValue: '12', unit: 'percent', windowDays: null },
      ],
    });

    const all = await goals.all();
    const targets = await goals.targets();
    if (!isOk(all) || !isOk(targets)) throw new Error('read failed');

    const tensions = detectTensions(all.value, targets.value);
    expect(tensions).toHaveLength(1);
    expect(tensions[0]?.kind).toBe('antagonistic');
  });
});

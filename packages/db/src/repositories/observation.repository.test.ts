/**
 * The observation substrate — integration, against real Postgres.
 *
 * The guarantees `core` states and cannot verify for itself:
 *
 *   - The append-only trigger is real: an UPDATE that is not a supersession,
 *     and any DELETE, are refused by the database.
 *   - A replayed write is a no-op rather than a duplicate-key error (§5.7).
 *   - A supersession can happen once, and the second attempt is a conflict
 *     rather than a lost link in the chain (§9.1).
 *   - A local day is a day *in its zone*, so an Indian evening does not file
 *     under the following date (§5.3).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, uuidV7 } from '@naitikos/shared';
import type { Observation } from '@naitikos/core';
import { initialHlcState, hlcTick } from '@naitikos/core';

import { createDatabase } from '../client';
import { createMetricRepository } from './metric.repository';
import { createObservationRepository } from './observation.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);

/** Skipped rather than failed when there is no database — §11.5 runs these in CI. */
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';

/**
 * A fixed epoch, so every id and every HLC in this file is deterministic.
 *
 * `uuidV7` takes the millisecond rather than reading a clock — §11.3's rule
 * applied to identity as well as to time, and what lets a test assert on
 * ordering at all.
 */
const EPOCH = 1_754_000_000_000;
const newId = (): string => uuidV7(EPOCH);
let clock = initialHlcState(newId(), EPOCH);

function nextHlc(): string {
  const tick = hlcTick(clock, EPOCH);
  clock = tick.state;
  return tick.hlc;
}

function observationRow(overrides: Partial<Observation> = {}): Observation {
  return {
    id: newId() as Observation['id'],
    metricKey: 'mind.mood' as Observation['metricKey'],
    value: '4.000000',
    valueText: null,
    unit: '',
    observedAt: '2026-08-03T15:30:00.000Z',
    observedZone: ZONE,
    recordedAt: '2026-08-03T15:30:00.000Z',
    sourceId: '' as Observation['sourceId'],
    confidence: null,
    subjectType: null,
    subjectId: null,
    context: null,
    supersededById: null,
    supersededAt: null,
    supersedeReason: null,
    hlc: nextHlc() as Observation['hlc'],
    ...overrides,
  };
}

suite('observation repository', () => {
  /*
   * Cleanup has to disable the immutability trigger first, which is itself the
   * clearest possible evidence that the trigger works.
   *
   * `identity.repository.test.ts` records why this file does not use
   * transaction-per-test: postgres.js does not nest, so a repository that opens
   * its own transaction inside a manual BEGIN silently destroys the isolation.
   * And a rejected statement inside a transaction poisons it, which the
   * `rejects.toThrow` assertions below would trip on every run.
   *
   * Re-enabled in the same `beforeEach` rather than in an `afterEach`, so a
   * test that fails mid-way cannot leave the table mutable for the next one.
   * The `alter table` needs ownership, which the local development role has and
   * the application role deliberately does not (§9, RLS).
   */
  beforeEach(async () => {
    if (db === undefined) return;
    await db.$client`alter table observation disable trigger observation_append_only`;
    await db.$client`delete from observation`;
    await db.$client`alter table observation enable trigger observation_append_only`;
  });

  async function sourceId(): Promise<string> {
    if (db === undefined) throw new Error('no database');
    const repository = createObservationRepository(db);
    const result = await repository.manualSourceId();
    if (!isOk(result)) throw new Error('could not resolve the manual source');
    return result.value;
  }

  it('appends a batch and reads it back', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    const appended = await repository.append([
      observationRow({ sourceId: source }),
      observationRow({ sourceId: source, metricKey: 'mind.energy' as Observation['metricKey'] }),
    ]);

    expect(isOk(appended) && appended.value).toBe(2);
    expect(await repository.count()).toBe(2);
  });

  /**
   * The claim `columns.ts` makes about the `instant()` customType, exercised
   * end to end: what goes in is what comes back, in ISO form, not Postgres's
   * `2026-08-03 15:30:00+00`.
   */
  it('round-trips instants and decimals without reformatting them', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    await repository.append([
      observationRow({ sourceId: source, metricKey: 'body.weight' as Observation['metricKey'], value: '74.842741', unit: 'kg' }),
    ]);

    const read = await repository.query({ metricKeys: ['body.weight'] });
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;

    expect(read.value[0]?.observedAt).toBe('2026-08-03T15:30:00.000Z');
    expect(read.value[0]?.value).toBe('74.842741');
  });

  /**
   * §5.7: a record has its permanent identity "from the moment it exists", so a
   * replayed outbox entry arrives with the same primary key. It must be a
   * no-op, not a 23505 the client has to interpret.
   */
  it('treats a replayed write as a no-op rather than a duplicate-key error', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];
    const row = observationRow({ sourceId: source });

    await repository.append([row]);
    const replay = await repository.append([row]);

    expect(isOk(replay)).toBe(true);
    expect(await repository.count()).toBe(1);
  });

  /**
   * §9.1: "If a weight from 2027 can be silently edited in 2031, then no number
   * in the system can be relied upon and the entire premise fails." The trigger
   * is what makes that true rather than merely intended.
   */
  it('refuses an update that is not a supersession, and refuses every delete', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];
    const row = observationRow({ sourceId: source });
    await repository.append([row]);

    await expect(db.$client`update observation set value = '1.000000' where id = ${row.id}`).rejects.toThrow();
    await expect(db.$client`delete from observation where id = ${row.id}`).rejects.toThrow();

    // And the row is untouched by either attempt.
    const read = await repository.query({ metricKeys: ['mind.mood'] });
    expect(isOk(read) && read.value[0]?.value).toBe('4.000000');
  });

  it('records a correction as a new row plus a pointer, keeping both', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    const original = observationRow({ sourceId: source });
    const correction = observationRow({ sourceId: source, value: '2.000000' });

    await repository.append([original]);
    const applied = await repository.append([correction], [
      {
        observationId: original.id,
        supersededById: correction.id,
        supersededAt: '2026-08-03T16:00:00.000Z',
        supersedeReason: 'Mis-tapped.',
      },
    ]);
    expect(isOk(applied)).toBe(true);

    // Current-only sees the correction.
    const current = await repository.query({ metricKeys: ['mind.mood'] });
    expect(isOk(current) && current.value).toHaveLength(1);
    expect(isOk(current) && current.value[0]?.value).toBe('2.000000');

    // Both rows survive, and the chain is walkable.
    const all = await repository.query({ metricKeys: ['mind.mood'], currentOnly: false });
    expect(isOk(all) && all.value).toHaveLength(2);
    const superseded = isOk(all) ? all.value.find((o) => o.id === original.id) : undefined;
    expect(superseded?.supersededById).toBe(correction.id);
    expect(superseded?.supersedeReason).toBe('Mis-tapped.');
  });

  /**
   * Two devices correcting the same observation while offline. Without the
   * `IS NULL` guard the second write overwrites the first's pointer, losing a
   * link in a chain §9.1 promises survives forever.
   */
  it('refuses to supersede the same observation twice', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    const original = observationRow({ sourceId: source });
    const first = observationRow({ sourceId: source, value: '2.000000' });
    const second = observationRow({ sourceId: source, value: '3.000000' });

    await repository.append([original]);
    await repository.append([first], [
      { observationId: original.id, supersededById: first.id, supersededAt: '2026-08-03T16:00:00.000Z', supersedeReason: 'a' },
    ]);

    const clash = await repository.append([second], [
      { observationId: original.id, supersededById: second.id, supersededAt: '2026-08-03T17:00:00.000Z', supersedeReason: 'b' },
    ]);

    expect(isErr(clash)).toBe(true);
    expect(isErr(clash) && clash.error.code).toBe('observation_already_superseded');
  });

  /**
   * §5.3: "A workout at '7am' during travel is a materially different fact from
   * one at 7am at home." 23:30 in Kolkata is 18:00 UTC — a naive UTC-day query
   * files it under the *following* date, and every Indian evening with it.
   */
  it('buckets a day by its zone, not by UTC', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    // 2026-08-03 23:30 IST.
    await repository.append([observationRow({ sourceId: source, observedAt: '2026-08-03T18:00:00.000Z' })]);

    const indianDay = await repository.forDay('2026-08-03', ZONE);
    expect(isOk(indianDay) && indianDay.value).toHaveLength(1);

    // The same instant, read as a UTC day, belongs to the 3rd as well —
    // 18:00Z is still the 3rd in UTC. The interesting case is the next hour.
    await repository.append([observationRow({ sourceId: source, observedAt: '2026-08-03T19:30:00.000Z' })]);
    const stillTheThird = await repository.forDay('2026-08-03', ZONE);
    // 01:00 IST on the 4th — a different local day.
    expect(isOk(stillTheThird) && stillTheThird.value).toHaveLength(1);

    const theFourth = await repository.forDay('2026-08-04', ZONE);
    expect(isOk(theFourth) && theFourth.value).toHaveLength(1);
  });

  it('returns the most recent current value per metric', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const source = (await sourceId()) as Observation['sourceId'];

    await repository.append([
      observationRow({ sourceId: source, value: '2.000000', observedAt: '2026-08-01T10:00:00.000Z' }),
      observationRow({ sourceId: source, value: '5.000000', observedAt: '2026-08-03T10:00:00.000Z' }),
      observationRow({
        sourceId: source,
        metricKey: 'body.weight' as Observation['metricKey'],
        unit: 'kg',
        value: '74.200000',
        observedAt: '2026-08-02T10:00:00.000Z',
      }),
    ]);

    const latest = await repository.latestPerMetric(['mind.mood', 'body.weight', 'mind.energy']);
    expect(isOk(latest)).toBe(true);
    if (!isOk(latest)) return;

    expect(latest.value.get('mind.mood')?.value).toBe('5.000000');
    expect(latest.value.get('body.weight')?.value).toBe('74.200000');
    // A metric with no observations is absent rather than null-valued.
    expect(latest.value.has('mind.energy')).toBe(false);
  });

  it('resolves one manual provenance row, however many times it is asked', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);

    const first = await repository.manualSourceId();
    // A second repository, so the in-process memo cannot be what makes this pass.
    const second = await createObservationRepository(db).manualSourceId();

    expect(isOk(first) && isOk(second) && first.value).toBe(isOk(second) ? second.value : null);

    const rows = await db.$client`select count(*)::int as n from observation_source where kind = 'manual'`;
    expect(rows[0]?.['n']).toBe(1);
  });

  it('reports a day it cannot resolve rather than guessing', async () => {
    if (db === undefined) return;
    const repository = createObservationRepository(db);
    const bad = await repository.forDay('2026-08-03', 'IST');
    expect(isErr(bad) && bad.error.code).toBe('observation_day_unresolvable');
  });
});

suite('metric repository', () => {
  it('loads the seeded registry and answers from cache', async () => {
    if (db === undefined) return;
    const repository = createMetricRepository(db);

    const registry = await repository.registry();
    expect(isOk(registry)).toBe(true);
    if (!isOk(registry)) return;

    expect(registry.value.get('mind.mood')?.displayName).toBe('Mood');
    expect(registry.value.get('not.a.metric')).toBeNull();
    // The seed's own budget assertion, verified against the database rather
    // than against the constant it was computed from.
    expect(registry.value.dailyClose()).toHaveLength(6);
  });

  /**
   * A cold-start stampede: without the in-flight promise, N concurrent callers
   * each issue the same SELECT.
   */
  it('coalesces concurrent cold loads into one registry instance', async () => {
    if (db === undefined) return;
    const repository = createMetricRepository(db);

    const [a, b, c] = await Promise.all([repository.registry(), repository.registry(), repository.registry()]);
    expect(isOk(a) && isOk(b) && isOk(c)).toBe(true);
    if (!isOk(a) || !isOk(b) || !isOk(c)) return;
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
  });

  it('falls back to a single-row read before the cache is warm', async () => {
    if (db === undefined) return;
    const repository = createMetricRepository(db);
    expect((await repository.get('body.weight'))?.canonicalUnit).toBe('kg');
    expect(await repository.get('not.a.metric')).toBeNull();
  });
});
